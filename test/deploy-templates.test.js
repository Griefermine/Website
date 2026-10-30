/**
 * Maßnahme 47 (Auftrag 5.5/5.9): die nginx-Vorlagen der Deployment-Skripte.
 *
 * Anlass ist ein realer Fehler, kein Verdacht: `setup-tls.sh` schrieb seine
 * nginx-Konfiguration mit einem UNZITIERTEN Heredoc (`<<EOF`), ohne die
 * nginx-Variablen zu escapeiren. Bash expandierte `$host`, `$remote_addr`,
 * `$proxy_add_x_forwarded_for`, `$scheme` und `$http_upgrade` damit zu leeren
 * Strings – die geschriebene Datei enthielt Zeilen wie
 * `proxy_set_header Host ;`. Mit echtem nginx 1.27 nachgeprüft:
 *
 *     [emerg] invalid number of arguments in "proxy_set_header" directive
 *     nginx: configuration file /etc/nginx/nginx.conf test failed
 *
 * `setup-tls.sh` macht `nginx -t && systemctl reload nginx`, bricht bei
 * Misserfolg aber nicht ab: die TLS-Umstellung meldete Erfolg, während der
 * Traffic auf der alten Konfiguration blieb (praktisch reproduziert, siehe
 * Abschlussbericht).
 *
 * Geprüft wird das GERENDERTE Ergebnis – mit demselben bash, das auch der
 * Betreiber ausführt – und nicht ein Quelltext-Verdacht.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const WURZEL = join(import.meta.dirname, '..');
const SKRIPTE = ['deploy-full.sh', 'setup-tls.sh'];

/**
 * Alle `cat > /etc/nginx/… <<[']MARKER[…]`-Blöcke, so wie bash sie schreibt.
 * Zitierter Marker (`<<'EOF'`) heißt „keine Expansion“, unzitierter heißt
 * „expandieren“ – genau wie im Skript.
 */
const nginxBloecke = (pfad) => {
  const zeilen = readFileSync(pfad, 'utf8').split('\n');
  const blöcke = [];
  for (let index = 0; index < zeilen.length; index += 1) {
    const treffer =
      /^cat\s+>\s*(.+?)\s+<<(-?)([\'"]?)([A-Za-z_]+)\3$/.exec(
        zeilen[index],
      );
    if (!treffer) continue;
    const [, ziel, , zitierung, marker] = treffer;
    const ende = zeilen.findIndex((zeile, j) => j > index && zeile === marker);
    assert.notEqual(ende, -1, `${pfad}: Heredoc ohne schließendes ${marker}`);
    const inhalt = zeilen.slice(index + 1, ende).join('\n');
    blöcke.push({ pfad, ziel, zitierung: Boolean(zitierung), inhalt });
    index = ende;
  }
  return blöcke;
};

/** bash-getreues Ergebnis eines Blocks: Expandieren, wenn nicht zitiert. */
const gerendert = (blok) => {
  if (blok.zitierung) return blok.inhalt;
  const root = mkdtempSync(join(tmpdir(), 'nginx-template-'));
  const ziel = join(root, 'bot-hub.conf');
  try {
    const skript = [
      'set -e',
      // Der einzige Platzhalter, den die Skripte bewusst einsetzen.
      'DOMAIN=bot.example',
      'WEBROOT=/var/lib/letsencrypt',
      'CERT_DIR=/etc/letsencrypt/live/bot.example',
      `cat > '${ziel}' <<MARKER`,
      blok.inhalt,
      'MARKER',
    ].join('\n');
    execFileSync('bash', ['-c', skript], { stdio: 'pipe' });
    return readFileSync(ziel, 'utf8');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const alleBloecke = SKRIPTE.flatMap((name) =>
  nginxBloecke(join(WURZEL, name)),
).map((blok) => ({ ...blok, gerendert: gerendert(blok) }));

const mitProxy = (blok) => blok.gerendert.includes('proxy_pass');

test('die TLS-Vorlage schreibt den HTTPS-Reverse-Proxy', () => {
  const proxyBloecke = alleBloecke.filter(mitProxy);
  assert.ok(
    proxyBloecke.length >= 1,
    'Erwartet mindestens eine Proxy-Vorlage.',
  );
  assert.ok(
    proxyBloecke.some((blok) => /listen 443 ssl/.test(blok.gerendert)),
    'Der produktive Reverse-Proxy muss TLS verwenden.',
  );
});

test(
  'Standard-Deployment fordert TLS an und veröffentlicht keine HTTP-App',
  () => {
  const deploy = readFileSync(join(WURZEL, 'deploy-full.sh'), 'utf8');
  assert.match(deploy, /setup-tls\.sh.*BOT_HUB_DOMAIN/);
  assert.match(deploy, /BOT_HUB_LE_EMAIL/);
  assert.doesNotMatch(deploy, /chown -R bot-hub:bot-hub "\$PROJECT_DIR"/);
  assert.match(deploy, /sudo -u bot-hub-build .*npm ci/);
  assert.match(deploy, /sudo -u bot-hub-build .*npm run build/);
});

test('keine Vorlage hinterlässt eine Direktive ohne Wert', () => {
  for (const blok of alleBloecke) {
    // Gemeint ist die Form `irgendwas  ;` (Argument durch Expansion verloren)
    // und `https://;` (leere Ziel-URL im Redirect). Beides schreibt bash, wenn
    // eine nginx-Variable nicht escapeiert war.
    const leer = blok.gerendert
      .split('\n')
      .map((zeile, nr) => [nr + 1, zeile.trim()])
      .filter(
        ([, zeile]) =>
          /[^;"]\s+;\s*$/.test(zeile) ||
          /:\/\/\s*;/.test(zeile) ||
          /\$\s*;/.test(zeile),
      );
    assert.deepEqual(
      leer,
      [],
      `${blok.pfad} → ${blok.ziel} schreibt Direktiven ohne Argument: ` +
        leer.map(([nr, zeile]) => `${nr}: "${zeile}"`).join(' | ') +
        ' – nginx -t bricht dazu mit „invalid number of arguments“ ab.',
    );
  }
});

test('der HTTP→HTTPS-Verweis behält Ziel und Anfrage', () => {
  const umleitungen = alleBloecke.filter((blok) =>
    /\breturn\s+301\b/.test(blok.gerendert),
  );
  assert.ok(umleitungen.length >= 1, 'Erwartet den HTTP→HTTPS-Verweis.');
  for (const blok of umleitungen) {
    assert.match(
      blok.gerendert,
      /return\s+301\s+https:\/\/\S*\$request_uri\s*;/,
      `${blok.pfad} → ${blok.ziel}: Der Verweis verliert Ziel oder ` +
        'Anfragepfad – `return 301 https://;` ist zwar gültige Syntax, ' +
        'leitet ' +
        'aber ins Leere.',
    );
  }
});

test('Proxy-Kopfzeilen bleiben als nginx-Variablen erhalten', () => {
  const erwartet = [
    // $http_host statt $host: der Hostname erreicht den Hub inklusive Port.
    // Mit $host wäre aus `https://example.org:8443/…` `example.org` geworden,
    // und jede Herkunfts-Prüfung lief auf einer anderen Adresse als der, unter
    // der der Hub wirklich erreicht wird. Beide Vorlagen verwenden dasselbe.
    ['Host', /\bproxy_set_header\s+Host\s+\$http_host\s*;/],
    ['X-Real-IP', /\bproxy_set_header\s+X-Real-IP\s+\$remote_addr\s*;/],
    [
      'X-Forwarded-For',
      /\bproxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for\s*;/,
    ],
    [
      'X-Forwarded-Proto',
      /\bproxy_set_header\s+X-Forwarded-Proto\s+\$scheme\s*;/,
    ],
  ];
  for (const blok of alleBloecke.filter(mitProxy)) {
    for (const [name, muster] of erwartet) {
      assert.match(
        blok.gerendert,
        muster,
        `${blok.pfad} → ${blok.ziel} verliert die Kopfzeile ${name}. Ohne ` +
          'sie kennt der Hub weder echte Besucher-Adresse noch HTTPS – und ' +
          'ohne X-Forwarded-For landen alle Besucher in einem Rate-Limit-' +
          'Eimer.',
      );
    }
  }
});

test('der WebSocket-Hochstieg überlebt die Vorlage', () => {
  for (const blok of alleBloecke.filter(mitProxy)) {
    assert.match(
      blok.gerendert,
      /\bproxy_set_header\s+Upgrade\s+\$http_upgrade\s*;/,
      `${blok.pfad} → ${blok.ziel}: ohne Upgrade-Kopfzeile scheitert der ` +
        'WebSocket-Handshake (Discord-Gateway der Bots läuft über WebSocket).',
    );
  }
});

test(
  'Uploads haben eine bewusste Körpergrenze, nicht die nginx-Standardgrenze',
  () => {
  for (const blok of alleBloecke.filter(mitProxy)) {
    assert.match(
      blok.gerendert,
      /\bclient_max_body_size\s+2m\s*;/,
      `${blok.pfad} → ${blok.ziel} setzt keine Körpergrenze. Der ` +
        'nginx-Standard (1m) kollidiert mit der hub-eigenen Grenze von 1 MiB ' +
        'und liefert eine nginx-Fehlerseite statt der Hub-Meldung.',
    );
  }
});

test('Deployment schreibt Proxy-Vertrauen und Vault-Key in die .env', () => {
  const text = readFileSync(join(WURZEL, 'deploy-full.sh'), 'utf8');
  assert.match(
    text,
    /grep -q '\^BOT_HUB_TRUSTED_PROXIES='/,
    'BOT_HUB_TRUSTED_PROXIES fehlt in der .env-Anlage: der Hub darf ' +
      'X-Forwarded-For nicht auswerten und alle Besucher teilen sich einen ' +
      'Rate-Limit-Eimer (Maßnahme 47).',
  );
  assert.match(
    text,
    /BOT_HUB_TRUSTED_PROXIES=127\.0\.0\.1/,
    'nginx läuft in dieser Installation auf demselben Rechner – 127.0.0.1 ' +
      'ist die tatsächliche, nicht eine geratenes Adresse.',
  );
  assert.match(
    text,
    /BOT_HUB_KEY_FILE=\/etc\/bot-hub\/master\.key/,
    'Ohne Vault-Key-Eintrag würde die Produktion ohne Verschlüsselung ' +
      'starten (Maßnahme 46).',
  );
});

test('TLS-Setup expandiert Shell-Variablen korrekt und unterstützt ältere nginx-Versionen', () => {
  const tls = readFileSync(join(WURZEL, 'setup-tls.sh'), 'utf8');
  assert.match(tls, /^DOMAIN="\$\{1:-\$\{BOT_HUB_DOMAIN:-\}\}"/m);
  assert.match(tls, /^EMAIL="\$\{2:-\$\{BOT_HUB_LE_EMAIL:-\}\}"/m);
  assert.match(tls, /dirname "\$\{BASH_SOURCE\[0\]\}"/);
  assert.match(tls, /listen 443 ssl http2;/);
  assert.doesNotMatch(tls, /^http2 on;$/m);
  assert.match(tls, /renewal-hooks\/deploy\/10-bot-hub-reload-nginx/);
  assert.match(tls, /certbot renew --dry-run/);
});
