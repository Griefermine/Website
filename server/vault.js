/**
 * Umschlag-Verschlüsselung für Geheimnisse im Ruhezustand (AES-256-GCM).
 *
 * Ist ein Vault-Key vorhanden, schreibt `secrets.js` Werte nicht mehr als
 * Klartext, sondern als selbstbeschreibenden Umschlag:
 *
 *     KEY="vault:v1:<iv-b64>:<tag-b64>:<chiffre-text-b64>"
 *
 * Woher der Key kommt:
 *   - Produktion: `BOT_HUB_KEY_FILE` (Datei AUSSERHALB von data/, z. B.
 *     /etc/bot-hub/master.key, 0640 root:bot-hub).
 *   - Entwicklung: existiert `<projectRoot>/.secrets.key`, gilt er.
 * Kein Key = Klartext wie bisher. Verschlüsselung ist damit AN, sobald der
 * Betreiber den Key anlegt, und aus, wo er (Tests, schnelle Starts) bewusst
 * keins will. Bestehender Klartext bleibt lesbar und wird beim nächsten
 * Schreiben automatisch umgeschlagen.
 *
 * Warum das hilft: Backups, Git-Unfälle oder Kopien, die nur den Daten-
 * ordner erwischen, geben dann nichts mehr her – der Key liegt nicht mit drin.
 *
 * Was es NICHT leistet: Wer den laufenden Hub-Prozess oder den kompletten
 * Projektordner samt Key lesen kann, kommt weiter (dagegen hilft nur
 * Festplattenverschlüsselung). Ein Bot-Container kommt weder an `data/` noch
 * an den Key – er sieht nur sein eigenes /workspace.
 *
 * GCM gibt Integrität: veränderte Umschläge oder ein falscher Key werfen
 * einen Fehler statt still Müll zu liefern. AAD ist der SchlüsselNAME, ein
 * Umschlag lässt sich also nicht zwischen Einträgen hin- und herschieben.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const PREFIX = 'vault:v1:';

export const isVaultValue = (value) =>
  String(value ?? '').startsWith(PREFIX);

/** Pfad, an dem der Hub seinen Vault-Key sucht (ohne ihn zu erzeugen). */
export const vaultKeyPath = (projectRoot, env = process.env) =>
  String(env.BOT_HUB_KEY_FILE ?? '').trim() ||
  join(projectRoot, '.secrets.key');

const keyCache = new Map();

/**
 * Liest und prüft den Vault-Key. Wirft, wenn die Datei fehlt oder nicht ein
 * 64-stelliges Hex (AES-256) ist. `ensure` legt einen frischen Zufallskey an,
 * falls noch keiner existiert (Einrichtungs-Aufruf, nie im Lese-/Schreibpfad).
 */
export const loadVaultKey = (projectRoot, env = process.env, ensure = false) => {
  const path = vaultKeyPath(projectRoot, env);
  const cached = keyCache.get(path);
  if (cached && !ensure) return cached;
  if (!existsSync(path)) {
    if (!ensure)
      throw new Error(
        `Vault-Key fehlt: "${path}" (BOT_HUB_KEY_FILE beachten, oder "ensureVaultKey" ausführen).`,
      );
    writeKeyFile(path, `${randomBytes(32).toString('hex')}\n`);
  }
  const hex = readFileSync(path, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex))
    throw new Error(`Vault-Key-Datei "${path}" ist kein 64-stelliges Hex.`);
  const key = Buffer.from(hex, 'hex');
  keyCache.set(path, key);
  return key;
};

/** Key-Datei 0600 anlegen (atomar). Nur für die Einrichtung. */
export const ensureVaultKey = (projectRoot, env = process.env) => {
  const path = vaultKeyPath(projectRoot, env);
  if (existsSync(path)) return path;
  writeKeyFile(path, `${randomBytes(32).toString('hex')}\n`);
  keyCache.delete(path);
  return path;
};

function writeKeyFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* Originalfehler ist die Diagnose. */
    }
    throw error;
  }
}

/** Vault aktiv? = es existiert eine lesbare Key-Datei am erwarteten Ort. */
export const vaultEnabled = (projectRoot, env = process.env) => {
  try {
    loadVaultKey(projectRoot, env);
    return true;
  } catch {
    return false;
  }
};

/**
 * Verschlüsselt, wenn ein Key vorhanden ist; sonst Klartext (alter Modus).
 * Leere Werte und bereits umgeschlagene bleiben unverändert.
 */
export const encryptValue = (keyName, value, projectRoot, env = process.env) => {
  const text = String(value ?? '');
  if (!text || isVaultValue(text)) return text;
  if (!vaultEnabled(projectRoot, env)) return text;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loadVaultKey(projectRoot, env), iv);
  cipher.setAAD(Buffer.from(String(keyName), 'utf8'));
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64')}:${cipher
    .getAuthTag()
    .toString('base64')}:${ct.toString('base64')}`;
};

/**
 * Entschlüsselt umgeschlagene Werte; Klartext (Altbestand) kommt unverändert
 * durch. Fehlt der Key für einen vorhandenen Umschlag, wirft es – lieber
 * laut als einen scheinbar leeren Secret-Vorrat.
 */
export const decryptValue = (keyName, stored, projectRoot, env = process.env) => {
  const text = String(stored ?? '');
  if (!isVaultValue(text)) return text;
  const parts = text.slice(PREFIX.length).split(':');
  if (parts.length !== 3)
    throw new Error(`Vault-Umschlag für "${keyName}" ist fehlerhaft gebaut.`);
  const [iv, tag, ct] = parts.map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', loadVaultKey(projectRoot, env), iv);
  decipher.setAAD(Buffer.from(String(keyName), 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
};

/** Nur für Tests: Schlüssel-Cache leeren (Key-Wechsel im selben Prozess). */
export const __forgetKeys = () => keyCache.clear();
