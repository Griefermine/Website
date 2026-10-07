/**
 * Beispiel-Webseite für jeden Bot.
 *
 * Jeder angelegte Bot (bestehend wie neu) bekommt eine Webseiten-Einbindung:
 * `bot-hub.json` + `panel/index.html` + `panel/panel.js` + `panel/panel.css`
 * im Startordner. Der Hub spiegelt sie in den Workspace, von dort rendert
 * das Panel sie via bridge.js – inklusive Discord-OAuth-Beispiel.
 *
 * Idempotent: vorhandene Dateien werden nie überschrieben. Keine Geheimnisse
 * im Scaffold, nur Platzhalter. OAuth-Credentials gehören in
 * `data/secrets/<id>.env` (Hub-kontrolliert), nie in den Workspace.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { startFolderPath, workspacePath } from './botFiles.js';

/**
 * Zielverzeichnis des Scaffolds: Startordner + als sicher geprüftes cwd.
 * Dieselben Schranken wie `safeStartPath` (kein `..`, kein absolut, kein `~`,
 * keine Windows-Reservierungen) – bei ungültigem cwd gilt sicher der
 * Startordner selbst, statt aus einem bösen Pfad einen guten zu machen.
 * Das Ergebnis liegt garantiert unter `bots/<bot-id>/startordner/`.
 */
const scaffoldDir = (bot, projectRoot) => {
  const start = startFolderPath(bot, projectRoot);
  const raw = String(bot.cwd || '.')
    .normalize('NFC')
    .replace(/\\/g, '/')
    .trim();
  if (!raw || raw === '.' || raw === '/') return start;
  if (raw.startsWith('/') || raw === '~' || raw.startsWith('~/')) return start;
  const parts = raw.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) return start;
  for (const part of parts) {
    if (!part.normalize('NFC')) return start;
    if (part.endsWith('.') || part.endsWith(' ')) return start;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(part)) return start;
    if (
      part.includes(':') ||
      part.includes('*') ||
      part.includes('?') ||
      part.includes('\0')
    )
      return start;
  }
  const candidate = join(start, ...parts);
  const rel = relative(start, candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return start;
  return candidate;
};

const manifestFor = (bot) =>
  JSON.stringify(
    {
      hub: {
        panel: {
          title: `${bot.name || 'Bot'} · Webseite`,
          icon: bot.emoji || '🤖',
          description: `Beispiel-Webseite für ${bot.name || 'diesen Bot'} – Einstellungen, Discord-Login und Aktionen.`,
          entry: 'panel/index.html',
          settings: [
            {
              key: 'log_channel',
              type: 'text',
              label: 'Log-Kanal',
              description: 'Kanalname für Statusmeldungen des Bots.',
              default: 'bot-log',
              placeholder: 'bot-log',
            },
            {
              key: 'begruessung',
              type: 'text',
              label: 'Begrüßung',
              description: 'Wird neuen Mitgliedern angezeigt.',
              default: 'Willkommen!',
              placeholder: 'Willkommen!',
            },
            {
              key: 'api_key',
              type: 'secret',
              label: 'API-Key (Beispiel)',
              description:
                'Beispiel-Secret – wird im Hub gespeichert und nie ans Frontend ausgeliefert.',
            },
          ],
          commands: [
            {
              id: 'ping',
              label: 'Ping (Beispiel)',
              description:
                'Beispiel-Aktion – antwortet, sobald ein laufender Bot sie per Callback bedient. Ohne Bot meldet die Seite verständlich, dass noch nichts hinterlegt ist.',
            },
            {
              id: 'info',
              label: 'Info (Beispiel)',
              description:
                'Beispiel-Aktion – zeigt Bot-Infos, sobald ein laufender Bot sie per Callback bedient.',
            },
          ],
        },
      },
    },
    null,
    2,
  ) + '\n';

const INDEX_HTML = `<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <title>Bot · Webseite</title>
    <link rel="stylesheet" href="panel.css" />
  </head>
  <body>
    <main class="wrap">
      <header class="card hero">
        <div class="hero__avatar" id="avatar">🤖</div>
        <div>
          <div class="eyebrow">Bot-Hub · Beispiel-Webseite</div>
          <h1 id="title">Bot</h1>
          <p class="sub" id="sub">Verbinde …</p>
          <span class="pill" id="conn"><span class="dot"></span>verbinde …</span>
        </div>
      </header>

      <section class="card" id="discord-section">
        <div class="card__head">
          <h2>Discord-Login (Beispiel)</h2>
          <span class="spacer"></span>
          <span class="pill" id="discord-status">nicht angemeldet</span>
        </div>
        <div class="card__body">
          <p class="hint" id="discord-hint">
            So bindest du Discord-OAuth ein: Die Seite fragt
            <code>discord/config</code>, der Browser öffnet die Login-Adresse
            als Navigation, der Callback landet im Hub. Lege dafür im Hub die
            Discord-OAuth-Werte an (siehe Dashboard-Hinweis bei den
            Bot-Geheimnissen) – Hub-seitig, nie im Workspace.
          </p>
          <div id="discord-login-row">
            <button class="btn--primary" id="discord-login" type="button">
              Mit Discord anmelden
            </button>
          </div>
          <div id="discord-user-row" hidden></div>
          <div class="guild-list" id="guild-list" hidden></div>
          <p class="empty" id="guilds-empty" hidden>Keine berechtigten Server.</p>
        </div>
      </section>

      <section class="card">
        <div class="card__head"><h2>Live-Werte</h2></div>
        <div class="card__body"><div id="stats"><p class="empty">Noch keine Werte.</p></div></div>
      </section>

      <section class="card">
        <div class="card__head"><h2>Einstellungen</h2></div>
        <div class="card__body">
          <form id="settings"><div id="fields"></div></form>
          <div class="row">
            <button class="btn--primary" id="save" type="submit" form="settings">Speichern</button>
            <span class="status" id="save-status"></span>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card__head"><h2>Aktionen</h2></div>
        <div class="card__body">
          <p class="hint">Beispiel-Aktionen – sie antworten, sobald ein laufender Bot sie bedient. Ohne Bot meldet das Log verständlich, dass noch nichts hinterlegt ist.</p>
          <div id="actions"></div>
        </div>
      </section>

      <section class="card">
        <div class="card__head"><h2>Log</h2></div>
        <div class="card__body"><ul class="log" id="log"></ul></div>
      </section>
    </main>
    <script src="panel.js"></script>
  </body>
</html>
`;

export const SCAFFOLD_VERSION = 2;
export const SCAFFOLD_MARKER =
  '// Bot-Hub Scaffold v2 – Beispielseite (wird nie überschrieben).';

const PANEL_JS = `${SCAFFOLD_MARKER}
// Beispiel-Webseite: läuft in Sandbox (Origin "null"), spricht per
// bridge.js mit dem Hub – nicht per fetch. Discord-OAuth als Beispiel.
void (async () => {
  const parts = location.pathname.split('/').filter(Boolean);
  const botId = parts[0] === 'api' && parts[1] === 'bots' ? parts[2] : '';
  const bridgeUrl = new URL(
    \`/api/bots/\${encodeURIComponent(botId)}/panel/bridge.js\`,
    location.href,
  );
  const bootstrap = new URLSearchParams(location.search).get('bootstrap');
  if (bootstrap) bridgeUrl.searchParams.set('bootstrap', bootstrap);

  const $ = (id) => document.getElementById(id);
  const h = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  };
  const log = (msg, kind = 'info') => {
    const list = $('log');
    if (!list) return;
    list.prepend(h('li', {}, h('span', { class: \`is-\${kind}\`, text: msg })));
    while (list.children.length > 40) list.lastElementChild.remove();
  };

  let hub = null;
  let payload = null;
  // Geheimnisse: leer lassen heißt behalten (Schlüssel wird gar nicht erst
  // gesendet). Nur der explizite Entfernen-Knopf markiert ein Secret zur
  // Löschung – ein leeres Feld allein löscht nie.
  const clearedSecrets = new Set();
  try {
    ({ hub } = await import(bridgeUrl.href));
  } catch (e) {
    $('sub').textContent = 'bridge.js nicht erreichbar: ' + e.message;
    return;
  }

  const renderDiscord = (session) => {
    const status = $('discord-status');
    if (!session?.authenticated) {
      status.textContent = 'nicht angemeldet';
      $('discord-login-row').hidden = false;
      $('discord-user-row').hidden = true;
      $('guild-list').hidden = true;
      return;
    }
    status.textContent = 'verbunden';
    $('discord-login-row').hidden = true;
    const user = $('discord-user-row');
    user.hidden = false;
    user.replaceChildren(
      h('strong', { text: \`Angemeldet als \${session.user?.name ?? '?'}\` }),
      h('button', {
        type: 'button',
        text: 'Abmelden',
        onclick: async () => {
          await hub.discordLogout();
          renderDiscord({ authenticated: false });
        },
      }),
    );
    const list = $('guild-list');
    list.hidden = false;
    list.replaceChildren(
      ...(session.guilds ?? []).map((g) =>
        h('div', { class: 'guild' }, h('strong', { text: g.name })),
      ),
    );
    $('guilds-empty').hidden = (session.guilds ?? []).length > 0;
  };

  const paint = (data) => {
    payload = data;
    if (data?.bot?.name) $('title').textContent = data.bot.name;
    $('conn').textContent = data?.online ? 'Bot läuft' : 'Bot gestoppt';
    $('sub').textContent = data?.online
      ? 'Live – Werte kommen vom Bot.'
      : 'Offline – Änderungen greifen beim nächsten Start.';
    const stats = $('stats');
    const entries = Object.entries(data?.state ?? {});
    const nodes = entries.length
      ? entries.map(([k, v]) => h('div', { class: 'stat' }, h('strong', { text: k }), h('span', { text: String(v) })))
      : [h('p', { class: 'empty', text: 'Noch keine Werte.' })];
    stats.replaceChildren(...nodes);
    const fields = $('fields');
    clearedSecrets.clear();
    fields.replaceChildren(
      ...(data?.fields ?? []).map((f) => {
        if (f.secret) {
          const isSet = Boolean(data?.secrets?.[f.key]);
          const input = h('input', { type: 'password', name: f.key, 'data-secret': 'true',
            placeholder: isSet ? '•••••••• – leer lassen, bleibt gespeichert' : 'noch nicht gesetzt' });
          const drop = isSet ? h('button', { type: 'button', text: 'Entfernen',
            title: 'Gespeicherten Wert beim Speichern löschen',
            onclick: () => {
              clearedSecrets.add(f.key);
              input.value = '';
              input.disabled = true;
              input.placeholder = 'wird beim Speichern entfernt';
            } }) : null;
          return h('label', { class: 'field' }, h('span', { text: f.label + ' (geheim)' }),
            input, drop);
        }
        return h('label', { class: 'field' }, h('span', { text: f.label || f.key }),
          h('input', { name: f.key, value: data?.settings?.[f.key] ?? f.default ?? '' }));
      }),
    );
    const actions = $('actions');
    actions.replaceChildren(
      ...(data?.commands ?? []).map((c) =>
        h('button', {
          type: 'button', text: c.label,
          onclick: async () => {
            try {
              const r = await hub.command(c.id, {});
              log(\`\${c.label}: \${JSON.stringify(r?.result ?? r)}\`, 'ok');
            } catch (e) { log(c.label + ': ' + e.message, 'bad'); }
          },
        }),
      ),
    );
  };

  $('discord-login').addEventListener('click', async () => {
    try {
      const cfg = await hub.discordConfig();
      if (!cfg?.configured) {
        log('Discord-OAuth nicht konfiguriert – CLIENT_ID/SECRET in data/secrets/<bot-id>.env einrichten.', 'bad');
        return;
      }
      const login = await hub.discordLogin();
      // Als Navigation öffnen (kein fetch): so legt der Hub State + Cookie
      // im richtigen Browser an.
      const popup = window.open(login.location, 'discord-login', 'popup,width=520,height=720');
      if (!popup) location.href = login.location;
      const poll = setInterval(async () => {
        try {
          const s = await hub.discordSession();
          if (s?.authenticated) { clearInterval(poll); renderDiscord(s); if (!popup.closed) popup.close(); }
        } catch {}
      }, 800);
      setTimeout(() => clearInterval(poll), 120000);
    } catch (e) { log(e.message, 'bad'); }
  });

  $('settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {};
    const secretKeys = new Set((payload?.fields ?? []).filter((f) => f.secret).map((f) => f.key));
    for (const input of e.target.querySelectorAll('[name]')) {
      if (secretKeys.has(input.name)) {
        if (clearedSecrets.has(input.name)) values[input.name] = '';
        else if (input.value.trim()) values[input.name] = input.value.trim();
        // Leer und nicht zum Löschen markiert: Schlüssel weglassen, das
        // gespeicherte Secret bleibt erhalten.
        continue;
      }
      values[input.name] = input.value;
    }
    try {
      const data = await hub.save(values);
      paint(data);
      $('save-status').textContent = 'gespeichert';
      log('Einstellungen gespeichert.', 'ok');
    } catch (err) { $('save-status').textContent = err.message; }
  });

  try {
    paint(await hub.settings());
    renderDiscord(await hub.discordSession());
    log('Verbunden.', 'ok');
  } catch (e) { log(e.message, 'bad'); }
})();
`;

const PANEL_CSS = `:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #08090d; color: #e7eaf3; font: 15px/1.55 system-ui, sans-serif; }
.wrap { max-width: 860px; margin: 0 auto; padding: 20px 16px 40px; display: flex; flex-direction: column; gap: 14px; }
.card { background: rgba(22, 25, 35, 0.72); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 18px; padding: 16px; }
.card__head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.card__head h2 { margin: 0; font-size: 16px; }
.spacer { flex: 1; }
.hero { display: flex; gap: 12px; align-items: center; }
.hero__avatar { font-size: 32px; }
.eyebrow { color: #8b93a7; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
h1 { margin: 2px 0; font-size: 22px; }
.sub { margin: 0; color: #8b93a7; }
.pill { display: inline-flex; gap: 6px; align-items: center; border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #8b93a7; }
.hint, .empty { color: #8b93a7; }
code { background: rgba(255, 255, 255, 0.06); border-radius: 6px; padding: 1px 6px; }
.row { display: flex; gap: 10px; align-items: center; margin-top: 10px; }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
input { background: rgba(8, 9, 13, 0.6); border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 12px; color: inherit; font: inherit; padding: 9px 12px; }
button, .btn--primary { appearance: none; border: 1px solid rgba(88, 101, 242, 0.6); background: linear-gradient(135deg, #5865f2, #7c3aed); color: #fff; border-radius: 12px; padding: 9px 14px; cursor: pointer; font: inherit; }
button[type="button"] { background: rgba(255, 255, 255, 0.06); border-color: rgba(255, 255, 255, 0.16); }
.guild-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.guild { border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 8px 12px; }
.stat { display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255, 255, 255, 0.06); padding: 6px 0; }
.log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.is-ok { color: #34d399; } .is-bad { color: #f87171; }
#actions { display: flex; gap: 8px; flex-wrap: wrap; }
.status { color: #8b93a7; font-size: 13px; }
`;

/**
 * Bestehende Workspace-Seite in den Startordner übernehmen (adoptieren).
 *
 * Der Startordner ist die Quelle – aber eine Bot-Seite, die nur im Workspace
 * liegt (z. B. von Hand dort angelegt, vor der Startordner-Ära), darf vom
 * Scaffold nicht plattgemacht werden: Der folgende Sync kopiert
 * Startordner→Workspace und würde gleichnamige Workspace-Dateien
 * überschreiben. Deshalb wandern vorhandene Workspace-Dateien zuerst in den
 * Startordner; danach ist der Sync ein No-Op und der Startordner ab sofort
 * die Quelle. Nur reguläre Dateien, keine Symlinks (kein Folgen nach außen).
 */
const adoptWorkspacePanel = (bot, projectRoot, base, rels) => {
  const adopted = [];
  let ws;
  try {
    ws = workspacePath(bot, projectRoot);
  } catch {
    return adopted;
  }
  for (const rel of rels) {
    const src = join(ws, rel);
    const dst = join(base, rel);
    try {
      if (existsSync(dst)) continue;
      const st = lstatSync(src);
      if (!st.isFile()) continue;
      mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
      copyFileSync(src, dst);
      adopted.push(rel);
    } catch {
      /* Je Datei ignorieren – Scaffold unten meldet den Rest. */
    }
  }
  return adopted;
};

/**
 * Scaffold anlegen, wo Dateien fehlen. Gibt zurück, was erstellt wurde.
 * Überschreibt nie – Beispiel bleibt Beispiel, eigene Seiten bleiben.
 * Fehler werden als `error` zurückgegeben (kein stilles Verschlucken):
 * Der Aufrufer entscheidet – melden statt abbrechen, damit ein fehlendes
 * Beispiel nie die Bot-Erstellung verhindert.
 */
/**
 * Erkennt ein altes Hub-generiertes panel.js (V1, syntaktisch kaputt durch den
 * bedingten Spread `? ...entries.map`). Eigene Seiten enthalten dieses Muster
 * nicht und werden niemals angefasst – im Zweifel gilt eine Datei als
 * benutzerdefiniert und bleibt liegen.
 */
const isBrokenScaffoldV1 = (content) =>
  typeof content === 'string' &&
  !content.includes(SCAFFOLD_MARKER) &&
  content.includes('? ...entries.map');

/**
 * Migriert alte Hub-Scaffolds (V1 → V2): nur Dateien, die eindeutig als
 * kaputtes Hub-Generat erkennbar sind, werden durch die reparierte Version
 * ersetzt. Benutzerdefinierte Panels und aktuelle V2-Dateien bleiben
 * unangetastet. Gibt die migrierten Pfade zurück.
 */
export const migrateScaffold = (bot, projectRoot) => {
  const migrated = [];
  let base;
  try {
    base = scaffoldDir(bot, projectRoot);
  } catch {
    return { migrated };
  }
  const target = join(base, 'panel', 'panel.js');
  try {
    const rel = relative(base, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { migrated };
    if (!existsSync(target)) return { migrated };
    const content = readFileSync(target, 'utf8');
    if (!isBrokenScaffoldV1(content)) return { migrated };
    writeFileSync(target, PANEL_JS, { mode: 0o600 });
    migrated.push('panel/panel.js');
  } catch {
    /* Defekte Datei, die sich nicht lesen/schreiben lässt, bleibt liegen. */
  }
  return { migrated };
};

export const ensurePanelScaffold = (bot, projectRoot) => {
  const created = [];
  const skipped = [];
  const adopted = [];
  let base;
  try {
    base = scaffoldDir(bot, projectRoot);
  } catch (error) {
    return { created, skipped, error: error?.message ?? String(error) };
  }
  const start = startFolderPath(bot, projectRoot);
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    mkdirSync(join(base, 'panel'), { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      created,
      skipped,
      error: error?.message ?? String(error),
    };
  }
  try {
    // Symlink-Escape: falls base (oder ein Elternteil) per Verweis aus dem
    // Startordner zeigt, nichts schreiben – sonst landete das Beispiel
    // außerhalb von bots/<id>/startordner/.
    const realStart = realpathSync(start);
    const realBase = realpathSync(base);
    const rel = relative(realStart, realBase);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return {
        created,
        skipped: [
          'bot-hub.json',
          'panel/index.html',
          'panel/panel.js',
          'panel/panel.css',
        ],
        error: 'Scaffold-Ziel liegt außerhalb des Startordners (Symlink?)',
      };
    }
  } catch (error) {
    return { created, skipped, error: error?.message ?? String(error) };
  }
  const files = [
    ['bot-hub.json', manifestFor(bot)],
    ['panel/index.html', INDEX_HTML],
    ['panel/panel.js', PANEL_JS],
    ['panel/panel.css', PANEL_CSS],
  ];
  // Erst adoptieren (Workspace→Startordner), dann Beispiel erzeugen:
  // So überlebt eine bestehende Workspace-Seite den folgenden Sync.
  for (const rel of adoptWorkspacePanel(
    bot,
    projectRoot,
    base,
    files.map(([r]) => r),
  ))
    adopted.push(rel);
  for (const [rel, content] of files) {
    const target = join(base, rel);
    try {
      // Containment je Datei: Ziel muss unter base bleiben.
      const relTarget = relative(base, target);
      if (!relTarget || relTarget.startsWith('..') || isAbsolute(relTarget)) {
        skipped.push(rel);
        continue;
      }
      if (existsSync(target)) {
        skipped.push(rel);
        continue;
      }
      writeFileSync(target, content, { mode: 0o600 });
      created.push(rel);
    } catch (error) {
      return {
        created,
        skipped: [
          ...skipped,
          ...files
            .map(([r]) => r)
            .filter((r) => !created.includes(r) && !skipped.includes(r)),
        ],
        error: error?.message ?? String(error),
      };
    }
  }
  return { created, skipped, adopted };
};
