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
    prepare: 'python3 -m venv {venv}',
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
    check:
      'ls build/libs/*.jar target/*.jar out/production/libs/*.jar > /dev/null 2>&1',
    install:
      '[ -x ./gradlew ] && ./gradlew build || mvn -q -DskipTests package',
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
    check:
      'ls build/libs/*.jar target/*.jar out/production/libs/*.jar > /dev/null 2>&1',
    install:
      '[ -x ./gradlew ] && ./gradlew build || mvn -q -DskipTests package',
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
    check: 'go list -m all 2> /dev/null | grep -q {module}',
    install:
      'if [ -f go.mod ]; then go get {module}; else go mod init bot && go get {module}; fi',
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
    check: 'grep -l {package} ./*.csproj > /dev/null 2>&1',
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
    check: 'grep -qi {package} Cargo.toml 2> /dev/null',
    install:
      'if [ -f Cargo.toml ]; then cargo add {package}; else cargo init --name bot && cargo add {package}; fi',
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
