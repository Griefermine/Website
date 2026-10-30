/**
 * Umschlag-Verschlüsselung für Geheimnisse im Ruhezustand (AES-256-GCM).
 *
 * Ist ein Vault-Key vorhanden, schreibt `secrets.js` Werte nicht mehr als
 * Klartext, sondern als selbstbeschreibenden Umschlag:
 *
 *     KEY="vault:v2:<iv-b64>:<tag-b64>:<chiffre-text-b64>"
 *
 * v2 bindet als Additional-Authenticated-Data (AAD) Dateiname UND
 * Schlüsselname ein: ein Umschlag lässt sich weder zwischen Einträgen noch
 * zwischen Secret-Dateien verschieben, ohne dass die GCM-Prüfung ihn wirft.
 * v1-Umschläge (nur Schlüsselname) bleiben lesbar und werden beim nächsten
 * Schreiben hochgezogen (`bootstrapSecretVault` tut das beim Hub-Start).
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
 * einen Fehler statt still Müll zu liefern. Das Umschichten eines Umschlags
 * (auf einen anderen Eintrag oder in eine andere Datei) scheitert an der
 * AAD-Bindung.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
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

const PREFIX_V1 = 'vault:v1:';
const PREFIX = 'vault:v2:';

export const isVaultValue = (value) => {
  const text = String(value ?? '');
  return text.startsWith(PREFIX) || text.startsWith(PREFIX_V1);
};

/** v1-Umschläge (nur Schlüsselname als AAD) – zum Hochziehen beim Start. */
export const isLegacyVaultValue = (value) =>
  String(value ?? '').startsWith(PREFIX_V1);

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
export const loadVaultKey = (
  projectRoot,
  env = process.env,
  ensure = false,
) => {
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
 * Maßnahme 46 (Auftrag 5.1): `vaultEnabled()` kann zwei völlig verschiedene
 * Zustände nicht unterscheiden – „niemand hat einen Schlüssel wollten“ und
 * „ein Schlüssel ist konfiguriert, aber unbrauchbar“ (Datei nicht lesbar,
 * falsches Format). Genau der zweite Fall ist der gefährliche: der Betreiber
 * hat `BOT_HUB_KEY_FILE` gesetzt, der Hub-Benutzer darf die root-eigene Datei
 * nicht lesen – und alle Secrets gingen trotzdem unverschlüsselt auf die
 * Platte. Diese Funktion würfelt nichts zusammen und wirft nicht; sie nennt
 * den Grund, damit Vorprüfung und Fehlermeldung damit arbeiten können.
 */
export const vaultStatus = (projectRoot, env = process.env) => {
  const path = vaultKeyPath(projectRoot, env);
  const konfiguriert = String(env.BOT_HUB_KEY_FILE ?? '').trim() !== '';
  try {
    loadVaultKey(projectRoot, env);
    return { aktiv: true, konfiguriert, pfad: path, grund: '' };
  } catch (error) {
    return {
      aktiv: false,
      konfiguriert,
      pfad: path,
      grund: error.message,
    };
  }
};

/** v2-AAD: Dateiname + Schlüsselname, getrennt durch ein Zeichen, das kein Name enthält. */
const aad = (vaultId, keyName) =>
  Buffer.from(`${vaultId}\u0000${keyName}`, 'utf8');

/**
 * Verschlüsselt, wenn ein Key vorhanden ist; sonst Klartext (alter Modus).
 * Leere Werte und bereits umgeschlagene bleiben unverändert. `vaultId` ist
 * der Name der Secret-Datei (Bot-Id, 'hub', …) und wandert – wie `keyName` –
 * als AAD in die Integritätsprüfung: ein Umschlag aus Datei A entschüsselt
 * in Datei B nicht mehr.
 */
export const encryptValue = (
  vaultId,
  keyName,
  value,
  projectRoot,
  env = process.env,
) => {
  const text = String(value ?? '');
  if (!text || isVaultValue(text)) return text;
  if (!vaultEnabled(projectRoot, env)) return text;
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    loadVaultKey(projectRoot, env),
    iv,
  );
  cipher.setAAD(aad(vaultId, keyName));
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64')}:${cipher
    .getAuthTag()
    .toString('base64')}:${ct.toString('base64')}`;
};

const openEnvelope = (vaultId, keyName, envelope, projectRoot, env) => {
  const legacy = envelope.startsWith(PREFIX_V1);
  const body = envelope.slice((legacy ? PREFIX_V1 : PREFIX).length);
  const parts = body.split(':');
  if (parts.length !== 3)
    throw new Error(`Vault-Umschlag für "${keyName}" ist fehlerhaft gebaut.`);
  const [iv, tag, ct] = parts.map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv(
    'aes-256-gcm',
    loadVaultKey(projectRoot, env),
    iv,
  );
  decipher.setAAD(
    legacy
      ? Buffer.from(String(keyName), 'utf8') // v1 kannte nur den Schlüsselnamen
      : aad(vaultId, keyName),
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    'utf8',
  );
};

/**
 * Entschlüsselt umschlagene Werte; Klartext (Altbestand) kommt unverändert
 * durch, v1-Umschläge mit ihrem alten AAD. Fehlt der Key für einen
 * vorhandenen Umschlag, wirft es – lieber laut als einen scheinbar leeren
 * Secret-Vorrat.
 */
export const decryptValue = (
  vaultId,
  keyName,
  stored,
  projectRoot,
  env = process.env,
) => {
  const text = String(stored ?? '');
  if (!isVaultValue(text)) return text;
  return openEnvelope(vaultId, keyName, text, projectRoot, env);
};

/** Nur für Tests: Schlüssel-Cache leeren (Key-Wechsel im selben Prozess). */
export const __forgetKeys = () => keyCache.clear();
