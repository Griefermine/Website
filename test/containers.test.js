import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

let root;
let bot;
let containers;
let createArgs;

const label = (args) =>
  args[args.findIndex((item) => item.startsWith('bot-hub.config='))] ?? '';
const mounts = (args) =>
  args.filter((item, index) => args[index - 1] === '--volume');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'bot-hub-container-'));
  mkdirSync(join(root, 'bots', 'shared'), { recursive: true });
  mkdirSync(join(root, 'bots', 'bot1', 'workspace'), { recursive: true });
  bot = {
    id: 'bot1',
    language: 'python',
    workspaceRoot: 'bots/bot1/workspace',
  };
  containers = await import('../server/containers.js');
  createArgs = containers.containerCreateArgs(bot, root);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Container-Isolation', () => {
  it('gibt dem Container keine erhöhten Rechte', () => {
    const joined = createArgs.join(' ');
    assert.ok(!createArgs.includes('--privileged'));
    assert.ok(!joined.includes('docker.sock'));
    assert.ok(createArgs.includes('--network'));
    assert.equal(createArgs[createArgs.indexOf('--network') + 1], 'bridge');
    assert.ok(!joined.includes('--pid=host'));
    assert.ok(createArgs.includes('ALL'), 'cap-drop ALL fehlt');
    assert.ok(joined.includes('no-new-privileges:true'));
    assert.ok(createArgs.includes('--read-only'));
    assert.ok(createArgs.includes('/tmp:rw,nosuid,size=128m'));
    assert.ok(createArgs.includes('--init'));
    assert.ok(createArgs.includes(process.getuid() + ':' + process.getgid()));
    assert.ok(createArgs.includes('256'), 'pids-limit fehlt');
    assert.ok(createArgs.includes('512m'), 'Speichergrenze fehlt');
    assert.ok(createArgs.includes('2'), 'CPU-Grenze fehlt');
  });

  it('hängt nur den eigenen Workspace und die geteilte Bibliothek ein', () => {
    assert.deepEqual(
      mounts(createArgs),
      [
        `${join(root, 'bots', 'bot1', 'workspace')}:/workspace`,
        `${join(root, 'bots', 'shared')}:/shared:ro`,
      ],
      'unerwartete Mounts',
    );
  });

  it('gibt dem Bot keinen Weg zum Host, solange keiner konfiguriert ist', () => {
    assert.ok(!createArgs.includes('--add-host'));
  });

  it('verwendet in Produktion nur das gefilterte Discord-Netz', () => {
    const vorher = process.env.NODE_ENV;
    const vorherNetz = process.env.BOT_HUB_CONTAINER_NETWORK;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.BOT_HUB_CONTAINER_NETWORK;
      let args = containers.containerCreateArgs(bot, root);
      assert.equal(args[args.indexOf('--network') + 1], 'bot-hub-discord');

      process.env.BOT_HUB_CONTAINER_NETWORK = 'bridge';
      assert.throws(
        () => containers.containerCreateArgs(bot, root),
        /nur das isolierte Netzwerk bot-hub-discord/,
      );
    } finally {
      if (vorher === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = vorher;
      if (vorherNetz === undefined)
        delete process.env.BOT_HUB_CONTAINER_NETWORK;
      else process.env.BOT_HUB_CONTAINER_NETWORK = vorherNetz;
    }
  });

  it('verweigert Host-Netzwerk für Bot-Container', () => {
    const vorher = process.env.BOT_HUB_CONTAINER_NETWORK;
    process.env.BOT_HUB_CONTAINER_NETWORK = 'host';
    try {
      assert.throws(
        () => containers.containerCreateArgs(bot, root),
        /vom Host-Netz verschiedener/,
      );
    } finally {
      if (vorher === undefined) delete process.env.BOT_HUB_CONTAINER_NETWORK;
      else process.env.BOT_HUB_CONTAINER_NETWORK = vorher;
    }
  });

  it('kennzeichnet seine Konfiguration, damit alte Container ersetzt werden', () => {
    assert.match(label(createArgs), /^bot-hub\.config=[a-f0-9]{16}$/);
    // Gleiche Eingabe -> gleiche Kennung.
    assert.equal(
      label(containers.containerCreateArgs(bot, root)),
      label(createArgs),
    );
    // Anderes Bild -> andere Kennung.
    const other = containers.containerCreateArgs(
      { ...bot, language: 'go' },
      root,
    );
    assert.notEqual(label(other), label(createArgs));
  });
});

describe('Produktionsnetzwerke isolieren gleichzeitige Container', () => {
  it('verlangt Bridge-Peer-Isolation und erlaubt nur die Proxy-Gateways', () => {
    const compose = readFileSync(
      join(ROOT, 'deploy/discord-egress/compose.yaml'),
      'utf8',
    );
    const squid = readFileSync(
      join(ROOT, 'deploy/discord-egress/squid.conf'),
      'utf8',
    );
    const firewall = readFileSync(
      join(ROOT, 'deploy/discord-egress/update-ufw-rules.py'),
      'utf8',
    );
    const setup = readFileSync(
      join(ROOT, 'deploy/discord-egress/setup-ubuntu-debian.sh'),
      'utf8',
    );
    const dockerEgress = readFileSync(
      join(ROOT, 'deploy/discord-egress/apply-docker-egress.py'),
      'utf8',
    );
    const checker = readFileSync(
      join(ROOT, 'deploy/discord-egress/check-host-firewall.py'),
      'utf8',
    );
    const nft = readFileSync(
      join(ROOT, 'deploy/discord-egress/host-firewall.nft'),
      'utf8',
    );

    assert.equal((compose.match(/enable_icc: "false"/g) ?? []).length, 0);
    // Compose now runs the proxy on the host namespace; bridge networks are
    // provisioned by the installer with ICC disabled, so no peer service is
    // left attached to those container networks.
    assert.match(compose, /network_mode: host/);
    assert.match(compose, /user:\s*["']13:13["']/);
    assert.match(compose, /callback-domains\.txt:.*:ro/);
    assert.match(squid, /http_port 172\.30\.250\.1:3128/);
    assert.match(squid, /http_port 172\.30\.251\.1:3128/);
    assert.match(squid, /http_port 127\.0\.0\.1:3129 name=hub/);
    assert.match(squid, /http_port 127\.0\.0\.1:3130 name=docker/);
    assert.match(squid, /http_port 127\.0\.0\.1:3131 name=packages/);
    assert.match(squid, /callback-domains\.txt/);
    // Fail-Closed: Die dst-bezogenen Sperren müssen vor allen allow-Regeln
    // greifen. Sonst lassen Split-DNS oder Rebinding eine freigegebene
    // Callback-Domain durch, die auf ein privates Ziel zeigt.
    const accessRules = squid
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('http_access '));
    const firstAllow = accessRules.findIndex((line) =>
      line.startsWith('http_access allow '),
    );
    assert.ok(firstAllow > 0, 'erwartet mindestens eine allow-Regel');
    for (const protectedRule of [
      'private_ipv4',
      'private_ipv6',
      'to_localhost',
      'to_linklocal',
      'metadata_ipv4',
      'metadata_ipv6',
    ]) {
      const denyIndex = accessRules.findIndex(
        (line) => line === `http_access deny ${protectedRule}`,
      );
      assert.ok(denyIndex >= 0, `deny ${protectedRule} fehlt`);
      assert.ok(
        denyIndex < firstAllow,
        `deny ${protectedRule} muss vor jeder allow-Regel stehen`,
      );
    }
    // NAT64 darf keinen Umweg auf Metadaten- oder link-lokale IPv4-Ziele
    // eröffnen; das Discard-Präfix ist ebenfalls zu sperren.
    const privateIpv6Networks = squid
      .split('\n')
      .find((line) => line.startsWith('acl private_ipv6 dst '))
      ?.slice('acl private_ipv6 dst '.length)
      .split(/\s+/);
    assert.ok(
      privateIpv6Networks?.includes('64:ff9b::/96'),
      'NAT64-Präfix 64:ff9b::/96 fehlt in private_ipv6',
    );
    assert.ok(
      privateIpv6Networks?.includes('100::/64'),
      'Discard-Präfix 100::/64 fehlt in private_ipv6',
    );
    assert.match(setup, /com\.docker\.network\.bridge\.enable_icc=false/);
    assert.match(setup, /ufw default deny outgoing/);
    assert.doesNotMatch(setup, /ufw default allow outgoing/);
    assert.match(setup, /HTTPS_PROXY=http:\/\/127\.0\.0\.1:3130/);
    assert.match(
      setup,
      /ExecStartPost=\/usr\/local\/sbin\/bot-hub-docker-egress/,
    );
    assert.match(firewall, /br-bothubdisc.*--dport 3128 -j ACCEPT/);
    assert.match(firewall, /br-bothubdeps.*--dport 3128 -j ACCEPT/);
    assert.match(firewall, /br-bothubdisc -j DROP/);
    assert.match(firewall, /br-bothubdeps -j DROP/);
    assert.match(firewall, /uid-owner 13.*--dport 443 -j ACCEPT/);
    // Der Prüfer kontrolliert nicht mehr den nft-Text, sondern die LIVE-
    // Regeln der UFW-Ketten ("iptables -S ufw-before-input") und verlangt
    // dort als Kettenanfang je Bot-Brücke erst die Proxy-Freigabe, dann den
    // pauschalen DROP (iptables-Form der früheren nft-Assertions, als
    // Python-Listen notiert; Zitatstil-tolerant geprüft). Die nft-Referenz
    // in host-firewall.nft behält ihre eigene Soll-Semantik.
    assert.match(
      checker,
      /["']iptables["'],\s*["']-S["'],\s*["']ufw-before-input["']/,
      'Prüfer liest die Live-Regeln von ufw-before-input',
    );
    assert.match(
      checker,
      /actual\[:\s*len\((?:EXPECTED_UFW_RULES|expected_input)\)\]\s*==\s*(?:EXPECTED_UFW_RULES|expected_input)/,
      'Prüfer verlangt die erwartete Regelfolge am Anfang der Live-Kette',
    );
    for (const bridge of ['br-bothubdisc', 'br-bothubdeps']) {
      const accept = checker.search(
        new RegExp(
          `["']-i["'],\\s*["']${bridge}["'],\\s*["']-d["'],\\s*["']172\\.30\\.25[01]\\.1/32["'],\\s*["']-p["'],\\s*["']tcp["'],\\s*["']--dport["'],\\s*["']3128["'],\\s*["']-j["'],\\s*["']ACCEPT["']`,
        ),
      );
      const drop = checker.search(
        new RegExp(
          `\\[\\s*["']-A["'],\\s*["']ufw-before-input["'],\\s*["']-i["'],\\s*["']${bridge}["'],\\s*["']-j["'],\\s*["']DROP["']\\s*\\]`,
        ),
      );
      assert.ok(
        accept >= 0,
        `Prüfer verlangt die Proxy-Freigabe für ${bridge} nicht`,
      );
      assert.ok(
        drop >= 0,
        `Prüfer verlangt den pauschalen DROP für ${bridge} nicht`,
      );
      assert.ok(
        accept < drop,
        `DROP für ${bridge} muss im Prüfer nach der Proxy-Freigabe stehen`,
      );
      assert.match(
        nft,
        new RegExp(`iifname\\s+["']${bridge}["']\\s+drop`),
        `host-firewall.nft sperrt ${bridge} nicht vollständig`,
      );
    }
    assert.match(dockerEgress, /--ctstate RELATED,ESTABLISHED -j RETURN/);
    assert.match(dockerEgress, /--ctstate NEW -j DROP/);
  });

  it('richtet Bots und Installer auf ihre privaten Proxy-Gateways', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const botExec = containers.execArgs(
        bot,
        root,
        join(root, 'bots', 'bot1', 'workspace'),
        { executable: 'node', args: ['index.js'] },
      );
      const botEnv = readFileSync(botExec.envFile, 'utf8');
      containers.cleanupExecEnvFile(botExec.envFile);
      assert.match(botEnv, /HTTPS_PROXY=http:\/\/172\.30\.250\.1:3128/);
      assert.match(botEnv, /NODE_USE_ENV_PROXY=1/);

      const installer = containers.dependencyRunArgs(
        bot,
        root,
        join(root, 'bots', 'bot1', 'workspace'),
        { executable: 'npm', args: ['install'] },
      );
      const installerEnv = readFileSync(installer.envFile, 'utf8');
      containers.cleanupExecEnvFile(installer.envFile);
      assert.match(installerEnv, /HTTPS_PROXY=http:\/\/172\.30\.251\.1:3128/);
      assert.match(installerEnv, /NODE_USE_ENV_PROXY=1/);
      assert.match(installerEnv, /JAVA_TOOL_OPTIONS=.*172\.30\.251\.1/);
      assert.doesNotMatch(installerEnv, /DISCORD_BOT_TOKEN=/);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('hält jede dstdomain-ACL frei von Subdomain-Kollisionen', () => {
    const squid = readFileSync(
      join(ROOT, 'deploy/discord-egress/squid.conf'),
      'utf8',
    );
    // Squid 5 (5.7) weist es als Parse-Fehler ("FATAL: Bungled") ab, wenn
    // innerhalb einer dstdomain-ACL ein Eintrag mit führendem Punkt neben
    // seiner Punktform steht oder ein Eintrag Subdomain eines anderen ist –
    // der Proxy startet dann nie und die Egress-Isolierung fällt lautlos
    // weg. Kein Eintrag darf deshalb identisch zu oder unter einem anderen
    // Eintrag derselben Zeile liegen (führende Punkte werden mitverglichen).
    const normalize = (entry) => entry.toLowerCase().replace(/^\.+/, '');
    const dstdomainAcl = (name) =>
      squid
        .split('\n')
        .find((line) => line.trim().startsWith(`acl ${name} dstdomain `))
        ?.trim()
        .slice(`acl ${name} dstdomain `.length) ?? null;
    const isSameOrSubdomain = (candidate, other) =>
      candidate === other || candidate.endsWith(`.${other}`);
    for (const line of squid.split('\n')) {
      const match = line.trim().match(/^acl\s+(\S+)\s+dstdomain\s+(\S.*?)\s*$/);
      if (!match || match[2].startsWith('"')) continue; // dateibasierte ACL
      const eintraege = match[2].split(/\s+/).map(normalize);
      for (const [index, eintrag] of eintraege.entries()) {
        for (const anderer of eintraege.slice(index + 1)) {
          assert.ok(
            !isSameOrSubdomain(eintrag, anderer) &&
              !isSameOrSubdomain(anderer, eintrag),
            `dstdomain-ACL ${match[1]}: "${eintrag}" und "${anderer}" ` +
              'kollidieren – squid -k parse bricht dazu mit FATAL ab',
          );
        }
      }
    }
    // Äquivalenz der Reduktion: Jeder vorher gematchte Host wird weiterhin
    // gematcht, denn foo.com matcht per dstdomain auch alle Subdomains.
    const covers = (name, host) => {
      const liste = dstdomainAcl(name);
      assert.ok(liste !== null, `dstdomain-ACL ${name} fehlt`);
      return liste
        .split(/\s+/)
        .map(normalize)
        .some((eintrag) => isSameOrSubdomain(host, eintrag));
    };
    assert.ok(covers('discord_domains', 'discord.com'));
    assert.ok(covers('discord_domains', 'gateway.discord.gg'));
    assert.ok(covers('docker_domains', 'registry-1.docker.io'));
    assert.ok(covers('docker_domains', 'auth.docker.io'));
    assert.ok(covers('docker_domains', 'production.cloudflare.docker.com'));
    assert.ok(covers('docker_domains', 'mcr.microsoft.com'));
    assert.ok(covers('hub_domains', 'acme-v02.api.letsencrypt.org'));
    assert.ok(covers('hub_domains', 'discord.gg'));
    assert.ok(covers('package_domains', 'index.crates.io'));
    assert.ok(covers('package_domains', 'static.crates.io'));
    assert.ok(covers('package_domains', 'pypi.org'));
    assert.ok(covers('package_domains', 'nuget.org'));
    assert.ok(covers('distro_domains', 'deb.debian.org'));
    assert.ok(covers('distro_domains', 'security.ubuntu.com'));
    assert.ok(covers('distro_domains', 'ports.ubuntu.com'));
    // Jede ACL nennt genau ihre maximalen Domains: in der von Squid 5.7
    // verlangten Form mit führendem Punkt (nur der Punkt trifft auch
    // Subdomains – Begründung im Kopf der squid.conf), ohne Doppelungen,
    // ohne Subdomains eigener Einträge.
    assert.deepEqual(dstdomainAcl('discord_domains').split(/\s+/), [
      '.discord.com',
      '.discord.gg',
      '.discordapp.com',
      '.discordapp.net',
    ]);
    assert.deepEqual(dstdomainAcl('docker_domains').split(/\s+/), [
      '.docker.io',
      '.docker.com',
      '.mcr.microsoft.com',
    ]);
    assert.deepEqual(dstdomainAcl('hub_domains').split(/\s+/), [
      '.discord.com',
      '.discord.gg',
      '.letsencrypt.org',
    ]);
    assert.deepEqual(dstdomainAcl('distro_domains').split(/\s+/), [
      '.debian.org',
      '.ubuntu.com',
    ]);
    assert.ok(
      dstdomainAcl('package_domains')
        .split(/\s+/)
        .every((eintrag) => eintrag.startsWith('.')),
      'package_domains nennt Einträge ohne führenden Punkt – unter Squid 5.7 ' +
        'träfen sie nur die exakten Namen, nicht ihre Subdomains',
    );
  });
});

describe('Container-URL aktiviert den Weg zum Host', () => {
  let withHost;
  before(async () => {
    process.env.BOT_HUB_CONTAINER_URL = 'http://host.docker.internal:8787';
    // Frisches Modul, weil die Konfiguration einmalig gelesen wird.
    const module = await import(`../server/containers.js?v=${Date.now()}`);
    withHost = module.containerCreateArgs(bot, root);
    delete process.env.BOT_HUB_CONTAINER_URL;
  });

  it('mappt host.docker.internal nur auf Wunsch', () => {
    assert.ok(withHost.includes('--add-host'));
    assert.ok(withHost.includes('host.docker.internal:host-gateway'));
  });
});

describe('Bilder auf eine Digest-Version festnageln', () => {
  const withImages = async (value) => {
    process.env.BOT_HUB_CONTAINER_IMAGES = value;
    const module = await import(`../server/containers.js?v=${Math.random()}`);
    delete process.env.BOT_HUB_CONTAINER_IMAGES;
    return module.containerImage({ language: 'python' });
  };

  it('übernimmt eine gültige Referenz', async () => {
    const digest = 'a'.repeat(64);
    assert.equal(
      await withImages(
        JSON.stringify({ python: `python:3.12-bookworm@sha256:${digest}` }),
      ),
      `python:3.12-bookworm@sha256:${digest}`,
    );
  });

  it('ignoriert ungültige Werte', async () => {
    for (const value of [
      '{kein json',
      JSON.stringify({ python: 'python:3.12; rm -rf /' }),
      JSON.stringify({ python: '--entrypoint=sh' }),
      JSON.stringify({ python: '../../evil' }),
      JSON.stringify({ java: 'eclipse-temurin:17-jdk' }),
      JSON.stringify(['nope']),
    ])
      assert.equal(await withImages(value), 'python:3.12-bookworm', value);
  });
});

describe('Die Digest-Liste kennt nur Bilder, die wirklich gezogen werden', () => {
  const namen = async (env) => {
    Object.assign(process.env, env);
    try {
      const module = await import(`../server/containers.js?v=${Math.random()}`);
      return module
        .containerSecurityFacts()
        .unpinnedImages.map(({ language }) => language);
    } finally {
      for (const key of Object.keys(env)) delete process.env[key];
    }
  };

  it('nennt MySQL nicht, wenn der Hub keine eigene Datenbank startet', async () => {
    // Sonst müsste eine Installation mit SQLite ein MySQL-Image festnageln,
    // das sie nie zieht – und dürfte wegen einer Einstellung nicht starten, die
    // sie gar nicht benutzt.
    const liste = await namen({ BOT_HUB_DB: 'sqlite' });
    assert.ok(
      !liste.includes('mysql'),
      `ohne mysql-container darf mysql nicht in der Liste stehen: ${liste}`,
    );
    assert.ok(!liste.includes('phpmyadmin'));
  });

  it('nennt MySQL, sobald der Hub den Container selbst startet', async () => {
    const liste = await namen({ BOT_HUB_DB: 'mysql-container' });
    assert.ok(liste.includes('mysql'), `mysql fehlt: ${liste}`);
    assert.ok(
      !liste.includes('phpmyadmin'),
      `ohne BOT_HUB_PHPMYADMIN darf phpmyadmin nicht mitlaufen: ${liste}`,
    );
  });

  it('nennt auch die Oberfläche, wenn sie eingeschaltet ist', async () => {
    const liste = await namen({
      BOT_HUB_DB: 'mysql-container',
      BOT_HUB_PHPMYADMIN: '1',
    });
    assert.ok(liste.includes('mysql') && liste.includes('phpmyadmin'));
  });

  it('lässt einen ausnahmsweise festgelegten Digest aus der Liste', async () => {
    const digest = 'e'.repeat(64);
    const liste = await namen({
      BOT_HUB_DB: 'mysql-container',
      BOT_HUB_PHPMYADMIN: '1',
      BOT_HUB_MYSQL_IMAGE: `mysql:8.4@sha256:${digest}`,
      BOT_HUB_PHPMYADMIN_IMAGE: `phpmyadmin/phpmyadmin@sha256:${digest}`,
    });
    assert.ok(!liste.includes('mysql'), `mysql fehlt: ${liste}`);
    assert.ok(!liste.includes('phpmyadmin'), `phpmyadmin fehlt: ${liste}`);
  });

  it('prüft die Bot-Bilder auch mit kaputter MySQL-Einstellung weiter', async () => {
    // `managedConfig` wirft bei manchen Werten. Finge man das mit einem
    // `try`/`catch` ab und gäbe dann eine leere Liste zurück, wäre die ganze
    // Digest-Prüfung lautlos weg – genau die Art stiller Abschaltung, die hier
    // nirgends sonst vorkommt.
    const liste = await namen({
      BOT_HUB_DB: 'sqlite',
      BOT_HUB_MYSQL_ADMIN_USER: 'root',
    });
    assert.ok(liste.includes('python'), `die Bot-Bilder fehlen: ${liste}`);
    assert.ok(liste.includes('rust'), `die Bot-Bilder fehlen: ${liste}`);
  });
});

describe('execArgs: Umgebung als 0600-Datei, nie als Argument', () => {
  const dir = join(root, 'bots', 'bot1', 'workspace');
  const spec = { executable: 'python3', args: ['bot.py'] };

  it('reicht Werte über --env-file und hält Geheimnisse aus der Argumentliste', () => {
    const plan = containers.execArgs(bot, root, dir, spec, {
      DISCORD_BOT_TOKEN: 'geheim-token',
      VIRTUAL_ENV: join(dir, '.venv'),
      PATH: join(dir, '.venv', 'bin') + ':/bin',
      LANG: 'C',
    });
    assert.ok(plan.args.includes('--env-file'));
    assert.ok(
      !plan.args.includes('--env'),
      '--env KEY=WERT darf nicht mehr vorkommen',
    );
    assert.ok(
      !plan.args.join(' ').includes('geheim-token'),
      'Secret steht in der Prozessliste',
    );
    assert.equal(plan.args[plan.args.indexOf('--env-file') + 1], plan.envFile);
    assert.deepEqual(plan.args.slice(-3), [
      'bot-hub-bot1',
      'python3',
      'bot.py',
    ]);
    const body = readFileSync(plan.envFile, 'utf8');
    assert.match(body, /^DISCORD_BOT_TOKEN=geheim-token$/m);
    assert.match(body, /^LANG=C$/m);
    // Die existierenden Umformungen bleiben: venv-Pfad in Container-Sicht.
    assert.match(body, /^VIRTUAL_ENV=\/workspace\/\.venv$/m);
    assert.match(
      body,
      /^PATH=\/workspace\/\.venv\/bin:\/workspace\/\.venv\/Scripts:\/usr\/local\/sbin/m,
    );
    assert.match(body, /^GOPATH=\/workspace\/\.cache\/go$/m);
    assert.equal(statSync(plan.envFile).mode & 0o777, 0o600);
    containers.cleanupExecEnvFile(plan.envFile);
    assert.equal(existsSync(plan.envFile), false);
  });

  it('mapped ein Workspace-Programm beim Start nach /workspace', () => {
    // Der Prüfer liefert Host-Pfade (`realpath`); im Container gilt die
    // Workspace-Einhängung unter /workspace (Bug 29).
    const plan = containers.execArgs(
      bot,
      root,
      dir,
      { executable: join(dir, 'target', 'release', 'bot'), args: [] },
      { LANG: 'C' },
    );
    assert.deepEqual(plan.args.slice(-2), [
      'bot-hub-bot1',
      '/workspace/target/release/bot',
    ]);
    containers.cleanupExecEnvFile(plan.envFile);
  });

  it('lehnt ein Workspace-Programm außerhalb des Workspace ab', () => {
    assert.throws(
      () =>
        containers.execArgs(
          bot,
          root,
          dir,
          { executable: join(root, 'fremd', 'bot'), args: [] },
          {},
        ),
      /außerhalb des Bot-Workspace/,
    );
  });

  it('hält unbrauchbare Schlüssel und Werte mit Zeilenumbruch aus der Datei', () => {
    const plan = containers.execArgs(bot, root, dir, spec, {
      'BAD KEY': 'x',
      '1ZAHL': 'y',
      OK_KEY: 'sichtbar',
      MULTI: 'zeile1\nBOSER_KEY=zeile2',
    });
    const body = readFileSync(plan.envFile, 'utf8');
    assert.match(body, /^OK_KEY=sichtbar$/m);
    assert.ok(!body.includes('BAD KEY'));
    assert.ok(!body.includes('1ZAHL'));
    assert.ok(
      !body.includes('BOSER_KEY'),
      'umgebrochener Wert schmuggelt einen Schlüssel',
    );
    // Maßnahme 34: Docker erzwingt noexec auf --tmpfs – 'go run' braucht
    // GOTMPDIR/TMPDIR im ausführbaren Workspace.
    assert.match(body, /^GOTMPDIR=\/workspace\/\.cache\/tmp$/m);
    assert.match(body, /^TMPDIR=\/workspace\/\.cache\/tmp$/m);
    // Maßnahme 35: dotnet-Erststart-Sentinel-Home im Workspace.
    assert.match(
      body,
      /^DOTNET_CLI_HOME=\/workspace\/\.cache\/dotnet-cli-home$/m,
    );
    containers.cleanupExecEnvFile(plan.envFile);
  });

  it('legt jede Ausführung unter einem neuen Zufallspfad an', () => {
    const a = containers.execArgs(bot, root, dir, spec, { A: '1' });
    const b = containers.execArgs(bot, root, dir, spec, { A: '1' });
    assert.notEqual(a.envFile, b.envFile);
    assert.match(a.envFile, /bot-hub-exec-env-/);
    containers.cleanupExecEnvFile(a.envFile);
    containers.cleanupExecEnvFile(b.envFile);
  });

  it('Cleanup ist fehlertolerant (doppeltes Löschen und null)', () => {
    const a = containers.execArgs(bot, root, dir, spec, { A: '1' });
    containers.cleanupExecEnvFile(a.envFile);
    containers.cleanupExecEnvFile(a.envFile);
    containers.cleanupExecEnvFile(null);
    containers.cleanupExecEnvFile(undefined);
  });
});

describe('Paket-Runner ohne Host-Angriffsfläche', () => {
  const previous = process.env.NODE_ENV;
  let installer;

  before(() => {
    process.env.NODE_ENV = 'production';
    installer = containers.dependencyRunArgs(
      { ...bot, language: 'custom' },
      root,
      join(root, 'bots', 'bot1', 'workspace'),
      { executable: 'bash', args: ['-c', 'echo install'] },
      { DISCORD_BOT_TOKEN: 'soll-weg', BOT_HUB_API_TOKEN: 'soll-weg' },
    );
  });
  after(() => {
    containers.cleanupExecEnvFile(installer.envFile);
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });

  it('hält Go-Werkzeug-Caches auf schreibbaren Workspace-Pfaden', () => {
    // Das golang-Bild setzt GOPATH=/go auf die read-only-Rootfs: die
    // Sumdb-Prüfung landete auf /go/pkg/sumdb und scheiterte (Bug 30).
    const body = installer.envFile
      ? readFileSync(installer.envFile, 'utf8')
      : '';
    assert.match(body, /^GOPATH=\/workspace\/\.cache\/go$/m);
    assert.match(body, /^GOMODCACHE=\/workspace\/\.cache\/go-mod$/m);
    assert.match(body, /^GOCACHE=\/workspace\/\.cache\/go-build$/m);
    // Docker erzwingt noexec auf --tmpfs: go run braucht GOTMPDIR im Workspace.
    assert.match(body, /^GOTMPDIR=\/workspace\/\.cache\/tmp$/m);
    assert.match(
      body,
      /^DOTNET_CLI_HOME=\/workspace\/\.cache\/dotnet-cli-home$/m,
    );
    assert.match(body, /^XDG_DATA_HOME=\/workspace\/\.cache\/xdg-data$/m);
    assert.ok(
      existsSync(join(root, 'bots', 'bot1', 'workspace', '.cache', 'tmp')),
    );
    // Maven 3.9s Native-Transport ignoriert JVM-Proxy-Properties und
    // Umgebungsvariablen: einziger gültiger Kanal ist eine settings.xml,
    // die der Runner in den Workspace schreibt und via MAVEN_ARGS übergibt
    // (Maßnahme 31, Probe A/B2/C auf dem Paketnetz).
    assert.match(
      body,
      /^MAVEN_ARGS=-s \/workspace\/\.bot-hub\/maven-settings\.xml$/m,
    );
    const settings = readFileSync(
      join(root, 'bots', 'bot1', 'workspace', '.bot-hub', 'maven-settings.xml'),
      'utf8',
    );
    assert.match(settings, /<protocol>https<\/protocol>/);
    assert.match(settings, /<host>172\.30\.251\.1<\/host>/);
    assert.match(settings, /<port>3128<\/port>/);
  });

  it('übergibt dem Docker-Prozess keine Sockets und keine Fremd-Rechte', () => {
    const joined = installer.args.join(' ');
    // Der Socket ist der Weg auf den Host: er darf in keiner Argumentliste
    // auftauchen, auch nicht als Mount-Ziel oder über ein Verzeichnis.
    assert.ok(
      !joined.includes('docker.sock'),
      'Docker-Socket erreicht den Bot',
    );
    assert.ok(
      !joined.includes('/var/run'),
      'Host-Laufzeitverzeichnis im Mount',
    );
    for (const flag of [
      '--privileged',
      '--pid=host',
      '--ipc=host',
      '--net=host',
      '--group-add',
      '--device',
      '-v',
    ])
      assert.ok(!installer.args.includes(flag), `${flag} ist gesetzt`);
    assert.ok(installer.args.includes('--cap-drop'));
    assert.equal(
      installer.args[installer.args.indexOf('--cap-drop') + 1],
      'ALL',
    );
    assert.ok(joined.includes('no-new-privileges:true'));
    assert.ok(installer.args.includes('--read-only'));
    assert.equal(
      installer.args[installer.args.indexOf('--network') + 1],
      'bot-hub-dependencies',
    );
  });

  it('hängt ausschließlich den eigenen Workspace ein', () => {
    const volumes = installer.args.filter(
      (_, index) => installer.args[index - 1] === '--volume',
    );
    assert.deepEqual(
      volumes.map((entry) => entry.split(':')[1]),
      ['/workspace'],
    );
    assert.equal(
      volumes[0],
      `${join(root, 'bots', 'bot1', 'workspace')}:/workspace`,
    );
    assert.ok(
      !volumes.some((entry) => entry.split(':')[2]?.includes('exec')),
      'Workspace darf nicht ausführbar gemountet sein',
    );
  });

  it('schleust keine Bot-Geheimnisse in die Env-Datei', () => {
    const body = installer.envFile
      ? readFileSync(installer.envFile, 'utf8')
      : '';
    assert.ok(!body.includes('soll-weg'));
    assert.ok(!body.includes('DISCORD_BOT_TOKEN='));
    assert.ok(!body.includes('BOT_HUB_API_TOKEN='));
    // Noch einmal mit einem Wert, der eine eigene Datei erzwingen würde.
    const plan = containers.dependencyRunArgs(
      { ...bot, language: 'custom' },
      root,
      join(root, 'bots', 'bot1', 'workspace'),
      { executable: 'bash', args: ['-c', 'echo install'] },
      { DISCORD_BOT_TOKEN: 'geheim', HOME: '/tmp/bot-home' },
    );
    const planBody = plan.envFile ? readFileSync(plan.envFile, 'utf8') : '';
    assert.ok(!planBody.includes('geheim'));
    assert.ok(!planBody.includes('DISCORD_BOT_TOKEN='));
    containers.cleanupExecEnvFile(plan.envFile);
  });
});

describe('Egress-Proxy-Image ist auf einen Digest festgenagelt', () => {
  it('pinnt das Base-Image und bleibt ohne Docker-Socket aus', () => {
    const dockerfile = readFileSync(
      join(ROOT, 'deploy/discord-egress/Dockerfile'),
      'utf8',
    );
    const from = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
    assert.ok(from.length > 0);
    for (const reference of from)
      assert.match(
        reference,
        /@sha256:[a-f0-9]{64}$/,
        `Base-Image ${reference} ist nicht per Digest festgelegt`,
      );
    assert.ok(!dockerfile.includes('docker.sock'));
    // Der Runner startet squid als Nicht-Root und ohne Capabilities.
    assert.match(dockerfile, /^USER proxy$/m);
    assert.match(dockerfile, /--chmod=0444/);
  });
});
