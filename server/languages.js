/**
 * Sprach-Presets für den Bot-Hub.
 *
 * Je Sprache bis zu drei Vorlagen:
 *   prepare – wird vor check ausgeführt und legt z. B. eine venv an
 *   check   – muss mit Exit-Code 0 enden, wenn die Library vorhanden ist
 *   install – wird nur ausgeführt, wenn check fehlschlägt
 *
 * `venv` benennt den Ordner der virtuellen Umgebung. Existiert er, wird sein
 * bin-Verzeichnis dem PATH des Bots hinzugefügt – dadurch landen pip und der
 * Startbefehl automatisch in der venv statt im System-Python (PEP 668).
 *
 * Platzhalter: {package} (Name beim Paketmanager), {module} (Import-Name),
 * {venv} (Ordner der virtuellen Umgebung).
 */
const framework = (name, module, pkg) => ({
  name,
  module,
  package: pkg ?? name,
});

export const LANGUAGES = [
  {
    id: 'python',
    label: 'Python',
    color: '#3776ab',
    runtime: 'python3',
    entrypoint: 'bot.py',
    command: 'python3 {entrypoint}',
    venv: '.venv',
    prepare: 'python3 -m venv --clear {venv}',
    check: 'python3 -c "import {module}"',
    install: 'python3 -m pip install --disable-pip-version-check {package}',
    frameworks: [
      framework('discord.py', 'discord', 'discord.py'),
      framework('Nextcord', 'nextcord', 'Nextcord'),
      framework('disnake', 'disnake', 'disnake'),
      framework('pycord', 'pycord', 'pycord'),
    ],
  },
  {
    id: 'javascript',
    label: 'JavaScript',
    color: '#f1e05a',
    runtime: 'node',
    entrypoint: 'index.js',
    command: 'node {entrypoint}',
    check: `node -e "import('{package}').then(() => process.exit(0)).catch(() => process.exit(1))"`,
    install: 'npm install --no-fund --no-audit {package}',
    frameworks: [
      framework('discord.js', 'discord.js', 'discord.js'),
      framework('Eris', 'eris', 'eris'),
      framework('Sapphire', '@sapphire/framework', '@sapphire/framework'),
      framework('discordeno', 'discordeno', 'discordeno'),
    ],
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    color: '#3178c6',
    runtime: 'node',
    entrypoint: 'src/index.ts',
    command: 'npx tsx {entrypoint}',
    check: `node -e "import('{package}').then(() => process.exit(0)).catch(() => process.exit(1))"`,
    install: 'npm install --no-fund --no-audit {package} tsx',
    frameworks: [
      framework('discord.js', 'discord.js', 'discord.js'),
      framework('Sapphire', '@sapphire/framework', '@sapphire/framework'),
      framework('Discordeno', 'discordeno', 'discordeno'),
    ],
  },
  {
    id: 'java',
    label: 'Java',
    color: '#e76f00',
    runtime: 'java',
    entrypoint: 'build/libs/bot.jar',
    command: 'java -jar {entrypoint}',
    // Kein Shell, keine Globs: `parseCommand` lehnt `>`, `|`, `2>` und Co.
    // ab – der alte Multi-Pfad-Check scheiterte damit IMMER und erzwang
    // jeden Start zu einem Vollbau. Geprüft wird genau die Datei, die der
    // Preset-Startbefehl gleich laden will (Maßnahme 39).
    check: 'ls build/libs/bot.jar',
    install: {
      // Entspricht `[ -x ./gradlew ] && ./gradlew build || mvn ... package`:
      // der Wrapper im Projekt hat Vorrang, sonst Maven.
      if: { file: 'gradlew', executable: true },
      then: { run: ['./gradlew', 'build'] },
      else: { run: ['mvn', '-q', '-DskipTests', 'package'] },
    },
    frameworks: [
      framework('JDA', 'net.dv8tion.jda', 'net.dv8tion:JDA:5.0.0-beta.13'),
      framework('Discord4J', 'discord4j', 'discord4j:core'),
      framework('Minutia', 'minutia', 'space.minutia:core'),
    ],
  },
  {
    id: 'kotlin',
    label: 'Kotlin',
    color: '#7f52ff',
    runtime: 'java',
    entrypoint: 'build/libs/bot.jar',
    command: 'java -jar {entrypoint}',
    // Kein Shell, keine Globs: `parseCommand` lehnt `>`, `|`, `2>` und Co.
    // ab – der alte Multi-Pfad-Check scheiterte damit IMMER und erzwang
    // jeden Start zu einem Vollbau. Geprüft wird genau die Datei, die der
    // Preset-Startbefehl gleich laden will (Maßnahme 39).
    check: 'ls build/libs/bot.jar',
    install: {
      // Entspricht `[ -x ./gradlew ] && ./gradlew build || mvn ... package`:
      // der Wrapper im Projekt hat Vorrang, sonst Maven.
      if: { file: 'gradlew', executable: true },
      then: { run: ['./gradlew', 'build'] },
      else: { run: ['mvn', '-q', '-DskipTests', 'package'] },
    },
    frameworks: [
      framework('Kord', 'dev.kord', 'dev.kord:kord-core'),
      framework(
        'JDA (via Kotlin)',
        'net.dv8tion.jda',
        'net.dv8tion:JDA:5.0.0-beta.13',
      ),
    ],
  },
  {
    id: 'go',
    label: 'Go',
    color: '#00add8',
    runtime: 'go',
    entrypoint: 'main.go',
    command: 'go run {entrypoint}',
    // `go list -m` blockierte der Eval-Flag-Wächter, die Pipeline ohnehin
    // `parseCommand` – der Check war toter Code (Maßnahme 39).
    check: 'grep -q {module} go.mod',
    install: {
      // Entspricht `if [ -f go.mod ]; then go get {module}; else
      // go mod init bot && go get {module}; fi`. Der else-Zweig ist eine
      // Folge, kein Ersatz: erst initialisieren, dann das Modul holen.
      if: { file: 'go.mod' },
      then: { run: ['go', 'get', '{module}'] },
      else: {
        sequence: [
          ['go', 'mod', 'init', 'bot'],
          ['go', 'get', '{module}'],
        ],
      },
    },
    frameworks: [
      framework(
        'discordgo',
        'github.com/bwmarrin/discordgo',
        'github.com/bwmarrin/discordgo',
      ),
      framework(
        'arikawa',
        'github.com/diamondburned/arikawa/v3',
        'github.com/diamondburned/arikawa/v3',
      ),
    ],
  },
  {
    id: 'csharp',
    label: 'C#',
    color: '#68217a',
    runtime: 'dotnet',
    entrypoint: 'bin/Release/net8.0/Bot.dll',
    command: 'dotnet {entrypoint}',
    // Kein Shell: das `> /dev/null` machte den Check kaputt; die csproj muss
    // wie im Preset-Standard `Bot.csproj` heißen, sonst greift der
    // Wiederinstall automatisch (Maßnahme 39).
    check: 'grep -q {package} Bot.csproj',
    install: 'dotnet add package {package}',
    frameworks: [
      framework('Discord.Net', 'DNetCore', 'Discord.Net'),
      framework('Disco.RSdk', 'DiscoSdk', 'Disco.RSdk'),
    ],
  },
  {
    id: 'rust',
    label: 'Rust',
    color: '#dea584',
    runtime: 'cargo',
    entrypoint: 'target/release/bot',
    command: './target/release/bot',
    // `2>` kannte `parseCommand` nicht – ohne Umleitung meldet grep bei
    // fehlender Cargo.toml einfach Exit 2: Einbau nötig, exakt richtig
    // (Maßnahme 39).
    check: 'grep -qi {package} Cargo.toml',
    install: {
      // Entspricht `if [ -f Cargo.toml ]; then cargo add {package}; else
      // cargo init --name bot && cargo add {package}; fi`.
      if: { file: 'Cargo.toml' },
      then: { run: ['cargo', 'add', '{package}'] },
      else: {
        sequence: [
          ['cargo', 'init', '--name', 'bot'],
          ['cargo', 'add', '{package}'],
        ],
      },
    },
    frameworks: [
      framework('Serenity', 'serenity', 'serenity'),
      framework('Poise', 'poise', 'poise'),
    ],
  },
  {
    id: 'custom',
    label: 'Sonstiges',
    color: '#8b949e',
    runtime: '',
    entrypoint: 'run.sh',
    command: 'bash {entrypoint}',
    check: '',
    install: '',
    frameworks: [
      framework('Shell', '', ''),
      framework('Node', '', ''),
      framework('Docker', '', ''),
      framework('Eigenes Script', '', ''),
    ],
  },
];

export const getLanguage = (id) =>
  LANGUAGES.find((language) => language.id === id) ??
  LANGUAGES[LANGUAGES.length - 1];

export const getFramework = (languageId, name) => {
  const language = getLanguage(languageId);
  return (
    language.frameworks.find((item) => item.name === name) ??
    language.frameworks[0]
  );
};

/** Setzt {package}, {module} und {venv} in einer Vorlage ein. */
export const fillDeps = (template, deps) =>
  template
    ? template
        .replace(/\{package\}/gi, () => deps?.package ?? '')
        .replace(/\{module\}/gi, () => deps?.module ?? '')
        .replace(/\{venv\}/gi, () => deps?.venv ?? '')
    : '';
