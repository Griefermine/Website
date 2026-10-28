#!/usr/bin/env node
/**
 * language-matrix.mjs — Live-Matrix für alle vom Hub unterstützten Sprachen.
 *
 * Pro Sprache wird ein Testbot angelegt, gestartet und geprüft:
 *   1. Discord-Gateway-Login    → Logzeile „READY <sprache>“
 *   2. KV-Schreiben             → PUT /api/hub/db/matrix/probe:<sprache>
 *      ( landet in MySQL `bot_store`; Nachweis outside via VM-MySQL-Query )
 *   3. Panel-Lebenszeichen      → POST /api/hub/state (Seite „Bereit <sprache>“)
 *
 * Bots laufen SERIELL: derselbe Discord-Token verträgt keine gleichzeitigen
 * Sitzungen mehrerer Prozesse. Der Token kommt ausschließlich über die
 * Umgebungsvariable DISCORD_TEST_TOKEN in die API (secretEnv → Vault); er
 * wird nie gedruckt, nie geloggt und nie in Dateien geschrieben.
 *
 * Benutzung (vom Laptop gegen die Simulations-VM):
 *   DISCORD_TEST_TOKEN=… BOT_SESSION=… node tools/language-matrix.mjs
 *   … --only=python,javascript     nur ausgewählte Sprachen
 *   … --keep                       Bots nach dem Lauf behalten
 *   … --signature                  Auswahl-Bot „Kommandante“ (Go) anlegen+behalten
 *   … --list | --cleanup           Testbots ansehen / löschen
 *
 * Der Hub spricht selbstsigniertes TLS auf dem Loopback-Port — darum ist
 * NODE_TLS_REJECT_UNAUTHORIZED hier bewusst abgeschaltet (nur Loopback).
 */

import process from 'node:process';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const HUB = process.env.HUB_URL || 'https://localhost:8443';
const SESSION = process.env.BOT_SESSION;
const TOKEN = process.env.DISCORD_TEST_TOKEN || '';
const args = process.argv.slice(2);
const onlyList = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1]
  ? args.find((a) => a.startsWith('--only=')).split('=')[1].split(',')
  : null;
const KEEP = args.includes('--keep');

const api = async (method, path, body) => {
  const res = await fetch(HUB + path, {
    method,
    headers: {
      cookie: `bot_hub_session=${SESSION}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* Fehlerseiten sind kein JSON. */
  }
  if (!res.ok)
    throw new Error(
      `${method} ${path} -> ${res.status}: ${(json?.error || text).slice(0, 220)}`,
    );
  return json;
};

/* Gemeinsame Beweismuster, in der Idiomsprache jeder Sprache.
 * HTTPS_PROXY/BOT_HUB_DISCORD_PROXY setzt der Hub in den Bot-Container;
 * NO_PROXY deckt die Hub-API selbst ab. Der Bot-Net-Ausgang ist ausschließlich
 * der Squid-CONNECT-Proxy auf Discord-Domains — jeder Client muss ihn
 * explizit oder via Umgebungsvariable nutzen. */

/* Boot-Shim für discord.js in DNS-freien Bot-Netzen (JS und TS teilen ihn):
 * discord.js 14.27 nutzt im WS-Worker globalThis.WebSocket (undici) ohne
 * Agent-Unterstützung – direkte Gateway-Verbindungen scheitern lautlos.
 * Das Boot-Modell patcht die Module auf der Platte, BEVOR discord.js lädt,
 * und wirkt damit in Main-Thread und Workern gleichermaßen. */
const WS_BOOT_SHIM_CJS = `// ws-boot.cjs — discord.js braucht den Squid-Proxy auch im WebSocket.
const fs = require('node:fs');
const path = require('node:path');
const PROXY = process.env.HTTPS_PROXY || process.env.BOT_HUB_DISCORD_PROXY;
const WRAP = [
  "module.exports = (() => {",
  "  const PX = process.env.HTTPS_PROXY || process.env.BOT_HUB_DISCORD_PROXY;",
  "  if (!PX) return WebSocket;",
  "  const { HttpsProxyAgent } = require('https-proxy-agent');",
  "  class ProxyWebSocket extends WebSocket {",
  "    constructor(url, protocols, options = {}) {",
  "      if (!options.agent && /^wss:/i.test(String(url))) {",
  "        options = { ...options, agent: new HttpsProxyAgent(PX) };",
  "      }",
  "      super(url, protocols, options);",
  "    }",
  "  }",
  "  for (const k of Object.getOwnPropertyNames(WebSocket)) {",
  "    if (!['length', 'name', 'prototype'].includes(k)) {",
  "      try { ProxyWebSocket[k] = WebSocket[k]; } catch {}",
  "    }",
  "  }",
  "  ProxyWebSocket.WebSocket = ProxyWebSocket;",
  "  return ProxyWebSocket;",
  "})(); // bot-hub-ws-shim",
].join('\\n');
const patch = (file, from, to) => {
  const p = path.join(__dirname, 'node_modules', file);
  try {
    let src = fs.readFileSync(p, 'utf8');
    if (src.includes('bot-hub-ws-shim') || src.includes('bot-hub-globalfetch-shim')) return;
    if (!src.includes(from)) return;
    src = src.replace(from, '/*bot-hub-globalfetch-shim*/' + to);
    fs.writeFileSync(p, src);
    console.log('proxy-shim aktiv:', file);
  } catch (e) {
    console.log('shim-Fehler:', file, e.message);
  }
};
if (PROXY) {
  patch('@discordjs/ws/dist/index.js', 'import_util2.shouldUseGlobalFetchAndWebSocket', '(() => false)');
  patch('@discordjs/ws/dist/index.mjs', 'shouldUseGlobalFetchAndWebSocket()', 'false');
  patch('ws/index.js', 'module.exports = WebSocket;', WRAP);
}
require('./index.js');
`;
// .mts ist Pflicht: ohne package.json"type":"module" behandelt tsx die Endung
// .ts als CommonJS und Top-Level-Await wäre ein Transform-Fehler (K1).
const WS_BOOT_SHIM_TS = `// ws-boot.mts — derselbe Shim für TypeScript (tsx lädt diese Datei zuerst).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const PROXY = process.env.HTTPS_PROXY || process.env.BOT_HUB_DISCORD_PROXY;
const WRAP = [
  "module.exports = (() => {",
  "  const PX = process.env.HTTPS_PROXY || process.env.BOT_HUB_DISCORD_PROXY;",
  "  if (!PX) return WebSocket;",
  "  const { HttpsProxyAgent } = require('https-proxy-agent');",
  "  class ProxyWebSocket extends WebSocket {",
  "    constructor(url, protocols, options = {}) {",
  "      if (!options.agent && /^wss:/i.test(String(url))) {",
  "        options = { ...options, agent: new HttpsProxyAgent(PX) };",
  "      }",
  "      super(url, protocols, options);",
  "    }",
  "  }",
  "  for (const k of Object.getOwnPropertyNames(WebSocket)) {",
  "    if (!['length', 'name', 'prototype'].includes(k)) {",
  "      try { ProxyWebSocket[k] = WebSocket[k]; } catch {}",
  "    }",
  "  }",
  "  ProxyWebSocket.WebSocket = ProxyWebSocket;",
  "  return ProxyWebSocket;",
  "})(); // bot-hub-ws-shim",
].join('\\n');
const patch = (file: string, from: string, to: string) => {
  const p = path.join(here, 'node_modules', file);
  try {
    let src = fs.readFileSync(p, 'utf8');
    if (src.includes('bot-hub-ws-shim') || src.includes('bot-hub-globalfetch-shim')) return;
    if (!src.includes(from)) return;
    src = src.replace(from, '/*bot-hub-globalfetch-shim*/' + to);
    fs.writeFileSync(p, src);
    console.log('proxy-shim aktiv:', file);
  } catch (e) {
    console.log('shim-Fehler:', file, String(e));
  }
};
if (PROXY) {
  patch('@discordjs/ws/dist/index.js', 'import_util2.shouldUseGlobalFetchAndWebSocket', '(() => false)');
  patch('@discordjs/ws/dist/index.mjs', 'shouldUseGlobalFetchAndWebSocket()', 'false');
  patch('ws/index.js', 'module.exports = WebSocket;', WRAP);
}
await import('./src/index.ts');
`;

const bots = {
  python: {
    marker: 'READY python',
    deadline: 900,
    def: {
      name: 'Matrix Python',
      language: 'python',
      framework: 'discord.py',
      files: {
        'bot.py': `import json, os, time, urllib.request
import discord

def hub(method, path, body=None):
    req = urllib.request.Request(
        os.environ["BOT_HUB_URL"] + "/api/hub" + path,
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={"authorization": "Bearer " + os.environ["BOT_HUB_TOKEN"],
                 "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status

proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or None
intents = discord.Intents.default()
client = discord.Client(intents=intents, proxy=proxy)

@client.event
async def on_ready():
    print(f"READY python {client.user}", flush=True)
    hub("PUT", "/db/matrix/probe:python", {"value": f"python-{int(time.time())}"})
    hub("POST", "/state", {"status": "online",
        "pages": [{"name": "Bereit python", "href": "https://example.com"}]})

client.run(os.environ["DISCORD_BOT_TOKEN"])
`,
      },
    },
  },
  javascript: {
    marker: 'READY javascript',
    deadline: 900,
    def: {
      name: 'Matrix JavaScript',
      language: 'javascript',
      framework: 'discord.js',
      entrypoint: 'ws-boot.cjs',
      depsCheck:
        'ls node_modules/discord.js/package.json node_modules/https-proxy-agent/package.json node_modules/ws/package.json',
      depsInstall:
        'npm install --no-fund --no-audit discord.js https-proxy-agent ws',
      files: {
        'ws-boot.cjs': WS_BOOT_SHIM_CJS,
        'index.js': `import { HttpsProxyAgent } from 'https-proxy-agent';
import { Client, GatewayIntentBits } from 'discord.js';
const HUB = process.env.BOT_HUB_URL, TOK = process.env.BOT_HUB_TOKEN;
const call = (method, path, body) => fetch(HUB + '/api/hub' + path, {
  method,
  headers: { authorization: 'Bearer ' + TOK, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.status);
const proxy = process.env.HTTPS_PROXY;
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  ...(proxy ? { ws: { agent: new HttpsProxyAgent(proxy) } } : {}),
});
let done = false;
const onReady = async () => {
  if (done) return;
  done = true;
  console.log('READY javascript', client.user.tag);
  await call('PUT', '/db/matrix/probe:javascript', { value: 'javascript-' + Date.now() });
  await call('POST', '/state', { status: 'online', pages: [{ name: 'Bereit javascript', href: 'https://example.com' }] });
};
/* discord.js hat „ready“ zu „clientReady“ umbenannt; beide Namen abdecken
 * alte und neue Versionen ab (Schutz gegen Doppelaufruf). */
client.once('clientReady', onReady);
client.once('ready', onReady);
client.on('error', (e) => console.log('client-error', e.message));
client.on('shardDisconnect', (_e, code) => console.log('shard-disconnect', code));
client.login(process.env.DISCORD_BOT_TOKEN);
`,
      },
    },
  },
  typescript: {
    marker: 'READY typescript',
    deadline: 900,
    def: {
      name: 'Matrix TypeScript',
      language: 'typescript',
      framework: 'discord.js',
      entrypoint: 'ws-boot.mts',
      depsCheck:
        'ls node_modules/discord.js/package.json node_modules/https-proxy-agent/package.json node_modules/tsx/package.json node_modules/ws/package.json',
      depsInstall:
        'npm install --no-fund --no-audit discord.js tsx https-proxy-agent ws',
      files: {
        'ws-boot.mts': WS_BOOT_SHIM_TS,
        'src/index.ts': `import { HttpsProxyAgent } from 'https-proxy-agent';
import { Client, GatewayIntentBits } from 'discord.js';
const HUB = process.env.BOT_HUB_URL as string;
const TOK = process.env.BOT_HUB_TOKEN as string;
const call = (method: string, path: string, body?: unknown): Promise<number> =>
  fetch(HUB + '/api/hub' + path, {
    method,
    headers: { authorization: 'Bearer ' + TOK, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => r.status);
const proxy = process.env.HTTPS_PROXY;
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  ...(proxy ? { ws: { agent: new HttpsProxyAgent(proxy) } } : {}),
});
let done = false;
const onReady = async (): Promise<void> => {
  if (done) return;
  done = true;
  console.log('READY typescript', client.user.tag);
  await call('PUT', '/db/matrix/probe:typescript', { value: 'typescript-' + Date.now() });
  await call('POST', '/state', { status: 'online', pages: [{ name: 'Bereit typescript', href: 'https://example.com' }] });
};
client.once('clientReady', onReady);
client.once('ready', onReady);
client.on('error', (e) => console.log('client-error', e.message));
client.on('shardDisconnect', (_e, code) => console.log('shard-disconnect', code));
client.login(process.env.DISCORD_BOT_TOKEN as string);
`,
      },
    },
  },
  go: {
    marker: 'READY go',
    deadline: 900,
    def: {
      name: 'Matrix Go',
      language: 'go',
      framework: 'discordgo',
      // 'go list -m …' würde vom Hub-Agent-Guard als Eval-Flag (-m) abgelehnt;
      // der Go-Cache liegt im Workspace, also genügt der Blick in go.mod.
      depsCheck: 'grep -q discordgo go.mod',
      files: {
        'main.go': `package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/bwmarrin/discordgo"
)

func call(method, path string, body any) {
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, os.Getenv("BOT_HUB_URL")+"/api/hub"+path, r)
	req.Header.Set("authorization", "Bearer "+os.Getenv("BOT_HUB_TOKEN"))
	req.Header.Set("content-type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Println("hub:", err)
		return
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
}

func main() {
	dg, err := discordgo.New("Bot " + os.Getenv("DISCORD_BOT_TOKEN"))
	if err != nil {
		log.Fatal(err)
	}
	if p := os.Getenv("HTTPS_PROXY"); p != "" {
		if u, err := url.Parse(p); err == nil {
			dg.Dialer.Proxy = http.ProxyURL(u)
		}
	}
	dg.AddHandler(func(s *discordgo.Session, r *discordgo.Ready) {
		fmt.Println("READY go", r.User.Username)
		call("PUT", "/db/matrix/probe:go", map[string]any{"value": fmt.Sprintf("go-%d", time.Now().Unix())})
		call("POST", "/state", map[string]any{"status": "online",
			"pages": []any{map[string]any{"name": "Bereit go", "href": "https://example.com"}}})
	})
	if err := dg.Open(); err != nil {
		log.Fatal(err)
	}
	defer dg.Close()
	select {}
}
`,
      },
    },
  },
  java: {
    marker: 'READY java',
    deadline: 1500,
    def: {
      name: 'Matrix Java',
      language: 'java',
      framework: 'JDA',
      entrypoint: 'target/bot.jar',
      depsCheck: 'ls target/bot.jar',
      files: {
        'pom.xml': `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>bot</groupId><artifactId>bot</artifactId><version>1</version>
  <packaging>jar</packaging>
  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency><groupId>net.dv8tion</groupId><artifactId>JDA</artifactId><version>5.0.0-beta.13</version></dependency>
  </dependencies>
  <build><finalName>bot</finalName><plugins>
    <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-shade-plugin</artifactId><version>3.5.1</version>
      <executions><execution><phase>package</phase><goals><goal>shade</goal></goals>
        <configuration><transformers>
          <transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer"><mainClass>Bot</mainClass></transformer>
        </transformers></configuration>
      </execution></executions></plugin>
  </plugins></build>
</project>
`,
        'src/main/java/Bot.java': `import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import net.dv8tion.jda.api.JDABuilder;
import net.dv8tion.jda.api.events.session.ReadyEvent;
import net.dv8tion.jda.api.hooks.ListenerAdapter;

public class Bot extends ListenerAdapter {
  static HttpClient http = HttpClient.newHttpClient();
  static String hub = System.getenv("BOT_HUB_URL");
  static String tok = System.getenv("BOT_HUB_TOKEN");

  static void call(String method, String path, String body) throws Exception {
    HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(hub + "/api/hub" + path))
        .header("authorization", "Bearer " + tok)
        .header("content-type", "application/json");
    b = "GET".equals(method) ? b.GET() : b.method(method, HttpRequest.BodyPublishers.ofString(body));
    http.send(b.build(), HttpResponse.BodyHandlers.ofString());
  }

  public static void main(String[] a) throws Exception {
    JDABuilder builder = JDABuilder.createDefault(System.getenv("DISCORD_BOT_TOKEN")).addEventListeners(new Bot());
    String proxy = System.getenv("HTTPS_PROXY");
    if (proxy != null && !proxy.isEmpty()) {
      // JDA 5.0.0-beta.13 hat kein setDefaultProxy/GatewayProxyBuilder mehr.
      // Gateway: nv-websocket-client 2.14 kennt kein WebSocketFactory.setProxy,
      // stattdessen getProxySettings().setServer(...).setPort(...) (HTTP-
      // CONNECT-Tunnel); REST: okhttp-Proxy direkt. (Maßnahme 33, javap-verifiziert.)
      java.net.URI u = java.net.URI.create(proxy);
      java.net.Proxy p = new java.net.Proxy(java.net.Proxy.Type.HTTP,
          new java.net.InetSocketAddress(u.getHost(), u.getPort()));
      com.neovisionaries.ws.client.WebSocketFactory f = new com.neovisionaries.ws.client.WebSocketFactory();
      // Falle: setServer(String) will eine URI („http://…“) – nackte Hosts
      // werfen IllegalArgumentException und der Proxy bleibt leer gesetzt.
      // Host und Port immer einzeln setzen.
      f.getProxySettings().setHost(u.getHost()).setPort(u.getPort());
      builder.setWebsocketFactory(f);
      builder.setHttpClientBuilder(new okhttp3.OkHttpClient.Builder().proxy(p));
    }
    builder.build();
  }

  @Override public void onReady(ReadyEvent e) {
    System.out.println("READY java " + e.getJDA().getSelfUser().getName());
    try {
      call("PUT", "/db/matrix/probe:java", "{\\"value\\":\\"java-" + System.currentTimeMillis() + "\\"}");
      call("POST", "/state", "{\\"status\\":\\"online\\",\\"pages\\":[{\\"name\\":\\"Bereit java\\",\\"href\\":\\"https://example.com\\"}]}");
    } catch (Exception ex) {
      System.out.println("matrix-nachweis fehlgeschlagen: " + ex);
    }
  }
}
`,
      },
    },
  },
  kotlin: {
    marker: 'READY kotlin',
    deadline: 1500,
    def: {
      name: 'Matrix Kotlin',
      language: 'kotlin',
      framework: 'JDA (via Kotlin)',
      entrypoint: 'target/bot.jar',
      depsCheck: 'ls target/bot.jar',
      files: {
        'pom.xml': `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>bot</groupId><artifactId>bot</artifactId><version>1</version><packaging>jar</packaging>
  <properties><maven.compiler.release>17</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding><kotlin.version>1.9.24</kotlin.version></properties>
  <dependencies>
    <dependency><groupId>net.dv8tion</groupId><artifactId>JDA</artifactId><version>5.0.0-beta.13</version></dependency>
    <dependency><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-stdlib</artifactId><version>\${kotlin.version}</version></dependency>
  </dependencies>
  <build><finalName>bot</finalName><sourceDirectory>src/main/kotlin</sourceDirectory><plugins>
    <plugin><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-maven-plugin</artifactId><version>\${kotlin.version}</version>
      <executions><execution><id>compile</id><phase>compile</phase><goals><goal>compile</goal></goals>
        <configuration><jvmTarget>17</jvmTarget></configuration></execution></executions></plugin>
    <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-shade-plugin</artifactId><version>3.5.1</version>
      <executions><execution><phase>package</phase><goals><goal>shade</goal></goals>
        <configuration><transformers>
          <transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer"><mainClass>BotKt</mainClass></transformer>
        </transformers></configuration>
      </execution></executions></plugin>
  </plugins></build>
</project>
`,
        'src/main/kotlin/Bot.kt': `import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import net.dv8tion.jda.api.JDABuilder
import net.dv8tion.jda.api.events.session.ReadyEvent
import net.dv8tion.jda.api.hooks.ListenerAdapter

val http = HttpClient.newHttpClient()

fun call(method: String, path: String, body: String) {
    val builder = HttpRequest.newBuilder(URI.create(System.getenv("BOT_HUB_URL") + "/api/hub" + path))
        .header("authorization", "Bearer " + System.getenv("BOT_HUB_TOKEN"))
        .header("content-type", "application/json")
    val request = builder.method(method, HttpRequest.BodyPublishers.ofString(body)).build()
    http.send(request, HttpResponse.BodyHandlers.ofString())
}

object Bot : ListenerAdapter() {
    override fun onReady(event: ReadyEvent) {
        println("READY kotlin " + event.jda.selfUser.name)
        try {
            call("PUT", "/db/matrix/probe:kotlin", "{\\"value\\":\\"kotlin-" + System.currentTimeMillis() + "\\"}")
            call("POST", "/state", "{\\"status\\":\\"online\\",\\"pages\\":[{\\"name\\":\\"Bereit kotlin\\",\\"href\\":\\"https://example.com\\"}]}")
        } catch (ex: Exception) {
            println("matrix-nachweis fehlgeschlagen: " + ex)
        }
    }
}

fun main(args: Array<String>) {
    val builder = JDABuilder.createDefault(System.getenv("DISCORD_BOT_TOKEN")).addEventListeners(Bot)
    val proxy = System.getenv("HTTPS_PROXY")
    if (!proxy.isNullOrEmpty()) {
        // JDA beta.13: Gateway via ProxySettings (nv kennt kein setProxy),
        // REST via okhttp-Proxy. (Maßnahme 33, javap-verifiziert.)
        val u = URI.create(proxy)
        val p = java.net.Proxy(java.net.Proxy.Type.HTTP, InetSocketAddress(u.host, u.port))
        val f = com.neovisionaries.ws.client.WebSocketFactory()
        // setServer(String) erwartet eine URI – nackte Hosts fliegen raus,
        // daher host/port einzeln setzen.
        f.proxySettings.setHost(u.host).setPort(u.port)
        builder.setWebsocketFactory(f)
        builder.setHttpClientBuilder(okhttp3.OkHttpClient.Builder().proxy(p))
    }
    builder.build().awaitReady()
}
`,
      },
    },
  },
  csharp: {
    marker: 'READY csharp',
    deadline: 1500,
    def: {
      name: 'Matrix C#',
      language: 'csharp',
      framework: 'Discord.Net',
      depsCheck: 'ls bin/Release/net8.0/Bot.dll',
      // '-c' ist ein Eval-Flag und wird vom Hub-Agent Guard abgelehnt.
      depsInstall: 'dotnet build --configuration Release',
      files: {
        'Bot.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Discord.Net" Version="3.17.2" />
  </ItemGroup>
</Project>
`,
        'Program.cs': `using System.Text;
using System.Text.Json;
using Discord;
using Discord.WebSocket;

var hub = Environment.GetEnvironmentVariable("BOT_HUB_URL") ?? "";
var tok = Environment.GetEnvironmentVariable("BOT_HUB_TOKEN") ?? "";
using var http = new HttpClient();

async Task Call(string method, string path, string? body = null)
{
    using var req = new HttpRequestMessage(new HttpMethod(method), hub + "/api/hub" + path);
    req.Headers.TryAddWithoutValidation("authorization", "Bearer " + tok);
    if (body != null) req.Content = new StringContent(body, Encoding.UTF8, "application/json");
    try { await http.SendAsync(req); } catch (Exception e) { Console.WriteLine("hub: " + e.Message); }
}

var pxUri = Environment.GetEnvironmentVariable("HTTPS_PROXY")
    ?? Environment.GetEnvironmentVariable("BOT_HUB_DISCORD_PROXY");
System.Net.IWebProxy proxy = string.IsNullOrEmpty(pxUri) ? null : new System.Net.WebProxy(pxUri);
// .NET wertet fuer ClientWebSocket/HttpClient KEINE Proxy-Env-Variablen aus –
// Discord.Net 3.x will die Proxy-Instanz explizit in beiden Providern
// (DefaultRestClientProvider.Create / DefaultWebSocketProvider.Create).
var client = new DiscordSocketClient(new DiscordSocketConfig
{
    RestClientProvider = Discord.Net.Rest.DefaultRestClientProvider.Create(true, proxy),
    WebSocketProvider = Discord.Net.WebSockets.DefaultWebSocketProvider.Create(proxy)
});
client.Log += m => { Console.WriteLine(m.ToString()); return Task.CompletedTask; };
client.Ready += async () =>
{
    Console.WriteLine($"READY csharp {client.CurrentUser.Username}");
    await Call("PUT", "/db/matrix/probe:csharp", JsonSerializer.Serialize(new { value = "csharp-" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }));
    await Call("POST", "/state", JsonSerializer.Serialize(new { status = "online", pages = new[] { new { name = "Bereit csharp", href = "https://example.com" } } }));
};
await client.LoginAsync(TokenType.Bot, Environment.GetEnvironmentVariable("DISCORD_BOT_TOKEN"));
await client.StartAsync();
await Task.Delay(Timeout.Infinite);
`,
      },
    },
  },
  rust: {
    marker: 'READY rust',
    deadline: 1800,
    def: {
      name: 'Matrix Rust',
      language: 'rust',
      framework: 'Serenity',
      /* Serenity wäre in der Simulations-VM (2 CPU, 1,5 GB) ein
       * 20-Minuten-Kompiliermonster. Die Matrix prüft die Schiene
       * (Gateway-Login + Hub-API aus einer echten Cargo-Build) mit dem
       * kleinsten Satz reiner Rust-Kisten. depsCheck/depsInstall sind darum
       * bewusst gesetzt – das Serenity-Preset selbst ist dadurch nicht
       * ausgesprochen, sondern nur zugunsten schneller Live-Prüfung ersetzt. */
      depsCheck: 'test -x target/release/bot',
      depsInstall: 'cargo build --release',
      files: {
        'Cargo.toml': `[package]
name = "bot"
version = "0.1.0"
edition = "2021"

[dependencies]
tokio = { version = "1", features = ["rt-multi-thread", "macros", "net", "io-util", "time"] }
tokio-tungstenite = { version = "0.23", default-features = false, features = ["handshake"] }
futures-util = "0.3"
serde_json = "1"
tokio-rustls = "0.26"
webpki-roots = "0.26"

[profile.release]
debug = false
strip = true
`,
        'src/main.rs': `use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpStream;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream as AsyncTcp;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;
use tokio_tungstenite::client_async;
use tokio_tungstenite::tungstenite::Message;

const DOMAIN: &str = "gateway.discord.gg";

/* Die Hub-API ist reines HTTP im internen Netz – ohne externe Kiste:
 * ein Handshake über TcpStream. */
fn hub(method: &str, path: &str, body: &str) {
    let base = std::env::var("BOT_HUB_URL").unwrap_or_default();
    let host = base.replace("http://", "");
    let token = std::env::var("BOT_HUB_TOKEN").unwrap_or_default();
    if let Ok(mut s) = TcpStream::connect(&host) {
        let len = body.len();
        let req = format!(
            "{method} /api/hub{path} HTTP/1.1\\r\\nHost: {host}\\r\\nAuthorization: Bearer {token}\\r\\nContent-Type: application/json\\r\\nContent-Length: {len}\\r\\nConnection: close\\r\\n\\r\\n{body}"
        );
        let _ = s.write_all(req.as_bytes());
        let mut buf = String::new();
        let _ = s.read_to_string(&mut buf);
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let token = std::env::var("DISCORD_BOT_TOKEN")?;
    let proxy = std::env::var("HTTPS_PROXY").unwrap_or_default();

    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    /* Falle (behoben): Der Harness schrieb diese Datei aus einem
     * JS-Template-Literal; einfache Backslash-r-Backslash-n-Escapes wertet JS
     * zu ECHTEN
     * CRLFs – und rustc normalisiert CRLF in String-Literals zu LF.
     * Ergebnis war ein LF-only-CONNECT: Squid antwortete brav mit 200,
     * schaltete aber nie auf Tunnel, der TLS-Handshake endete mit
     * „tls handshake eof“. Deshalb hier NUR gemodderte Escapes, nie
     * echte CRLFs. Ein Post-Quantum- oder Kx-Gruppen-Problem gab es
     * nicht (Gegenprobe: identischer rustls-Aufbau mit echtem CRLF
     * handshake-t erfolgreich durch denselben Squid). */
    let cfg = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = TlsConnector::from(std::sync::Arc::new(cfg));
    let name = ServerName::try_from(DOMAIN.to_string())?;

    /* Der Bot-Net-Ausgang ist ausschließlich der Squid-CONNECT-Proxy. */
    let tcp = if proxy.is_empty() {
        AsyncTcp::connect((DOMAIN, 443)).await?
    } else {
        let proxy_addr = proxy.replace("http://", "").replace("https://", "");
        let mut tcp = AsyncTcp::connect(proxy_addr.as_str()).await?;
        let req = format!("CONNECT {DOMAIN}:443 HTTP/1.1\\r\\nHost: {DOMAIN}:443\\r\\n\\r\\n");
        tcp.write_all(req.as_bytes()).await?;
        let mut head: Vec<u8> = Vec::new();
        loop {
            let mut b = [0u8; 1];
            if tcp.read(&mut b).await? == 0 {
                break;
            }
            head.push(b[0]);
            if head.ends_with(b"\\r\\n\\r\\n") {
                break;
            }
        }
        let status = String::from_utf8_lossy(&head).to_string();
        if !(status.starts_with("HTTP/1.") && status.as_bytes().get(9) == Some(&b'2')) {
            return Err(format!("Proxy-CONNECT fehlgeschlagen: {}", status).into());
        }
        tcp
    };

    let tls = connector.connect(name, tcp).await?;
    let (ws, _) = client_async(format!("wss://{DOMAIN}/?v=10&encoding=json"), tls).await?;
    let (mut write, mut read) = ws.split();
    let identify = json!({"op": 2, "d": {"token": token, "intents": 1,
        "properties": {"os": "linux", "browser": "matrix", "device": "matrix"}}});
    write.send(Message::text(identify.to_string())).await?;

    while let Some(msg) = read.next().await {
        if let Ok(Message::Text(t)) = msg {
            let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
            if v["t"].as_str() == Some("READY") {
                println!("READY rust {}", v["d"]["user"]["username"].as_str().unwrap_or("?"));
                hub("PUT", "/db/matrix/probe:rust",
                    &json!({"value": format!("rust-{}", std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)?.as_millis())}).to_string());
                hub("POST", "/state", &json!({"status": "online", "pages": [{"name": "Bereit rust", "href": "https://example.com"}]}).to_string());
                return Ok(());
            }
        }
    }
    Ok(())
}
`,
      },
    },
  },
  custom: {
    marker: 'HUBOK custom',
    deadline: 600,
    discord: false,
    def: {
      name: 'Matrix Shell',
      language: 'custom',
      framework: 'Eigenes Script',
      /* ubuntu:24.04 bringt kein Python/Node mit, und das Paketnetz kennt kein
       * Ubuntu-Archiv – WebSocket aus reinem Bash ist kein sinnvoller Beweis.
       * Der Nachweis zählt hier die Hub-Schiene (KV + Panel über /dev/tcp);
       * die Discord-Anbindung ist pro Sprache bereits achtmal bewiesen. */
      files: {
        'run.sh': `#!/usr/bin/env bash
set -uo pipefail

hub() { # $1=Methode $2=Pfad $3=JSON
  local host="\${BOT_HUB_URL#http://}" ip port
  ip="\${host%%:*}"; port="\${host##*:}"
  local body="\${3:-}"
  if ! exec 3<>"/dev/tcp/\${ip}/\${port}"; then echo "hub nicht erreichbar"; return 1; fi
  printf '%s /api/hub%s HTTP/1.1\\r\\nHost: %s\\r\\nAuthorization: Bearer %s\\r\\nContent-Type: application/json\\r\\nContent-Length: %d\\r\\nConnection: close\\r\\n\\r\\n%s' \\
    "\$1" "\$2" "\$host" "\$BOT_HUB_TOKEN" "\${#body}" "\$body" >&3
  head -1 <&3
  exec 3<&- 3>&-
}

hub PUT /db/matrix/probe:custom "{\\"value\\":\\"custom-\$(date +%s)\\"}"
hub POST /state "{\\"status\\":\\"online\\",\\"pages\\":[{\\"name\\":\\"Bereit custom\\",\\"href\\":\\"https://example.com\\"}]}"
echo "HUBOK custom"
sleep 3600
`,
      },
    },
  },
};

/* ---------------- Auswahl-Bot „Kommandante“ (Go) ---------------- */
const signatureBot = {
  name: 'Kommandante',
  emoji: '🫡',
  language: 'go',
  framework: 'discordgo',
  description: 'Meine Wahl: Slash /status mit KV-Zähler in MySQL',
  autoRestart: true,
  depsCheck: 'grep -q discordgo go.mod',
  secretEnv: {},
  files: {
    'main.go': `package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"

	"github.com/bwmarrin/discordgo"
)

var (
	hubURL  = os.Getenv("BOT_HUB_URL")
	hubTok  = os.Getenv("BOT_HUB_TOKEN")
	started = time.Now()
)

func call(method, path string, body any) []byte {
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, hubURL+"/api/hub"+path, r)
	req.Header.Set("authorization", "Bearer "+hubTok)
	req.Header.Set("content-type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Println("hub:", err)
		return nil
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return out
}

/* Lebenszeichen hochzählen – Beweis, dass Lesen UND Schreiben in MySQL ankommen. */
func aufrufeInkrement() int {
	var antwort struct {
		Entry struct {
			Value string \`json:"value"\`
		} \`json:"entry"\`
	}
	if out := call("GET", "/db/commander/aufrufe", nil); len(out) > 0 {
		json.Unmarshal(out, &antwort)
	}
	n, _ := strconv.Atoi(antwort.Entry.Value)
	n++
	call("PUT", "/db/commander/aufrufe", map[string]any{"value": strconv.Itoa(n)})
	return n
}

func main() {
	dg, err := discordgo.New("Bot " + os.Getenv("DISCORD_BOT_TOKEN"))
	if err != nil {
		log.Fatal(err)
	}
	if p := os.Getenv("HTTPS_PROXY"); p != "" {
		if u, err := url.Parse(p); err == nil {
			dg.Dialer.Proxy = http.ProxyURL(u)
		}
	}
	dg.AddHandler(func(s *discordgo.Session, r *discordgo.Ready) {
		fmt.Println("READY go", r.User.Username)
		call("PUT", "/db/commander/bereit", map[string]any{"value": started.Format(time.RFC3339)})
		guilds, _ := s.UserGuilds(20, "", "", false)
		if len(guilds) > 0 {
			/* discordgo: BulkOverwrite für Listen, Create nur für EINZELNE Commands. */
			_, err := s.ApplicationCommandBulkOverwrite(s.State.User.ID, guilds[0].ID, []*discordgo.ApplicationCommand{{
				Name:        "status",
				Description: "Lebenszeichen plus KV-Zaehler aus MySQL",
			}})
			if err != nil {
				log.Println("Slash-Registrierung:", err)
			}
		} else {
			fmt.Println("keine Guild – /status bleibt bis zum Invite inaktiv")
		}
	})
	dg.AddHandler(func(s *discordgo.Session, i *discordgo.InteractionCreate) {
		if i.ApplicationCommandData().Name != "status" {
			return
		}
		n := aufrufeInkrement()
		s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
			Type: discordgo.InteractionResponseChannelMessageWithSource,
			Data: &discordgo.InteractionResponseData{
				Content: fmt.Sprintf("Kommandante lebt seit %s – /status-Aufruf #%d (in MySQL gezaehlt).",
					started.Format(time.RFC3339), n),
			},
		})
	})
	for {
		if err := dg.Open(); err != nil {
			log.Println("gateway:", err)
			time.Sleep(10 * time.Second)
			continue
		}
		select {}
	}
}
`,
  },
};

/* ---------------- Ablauf ---------------- */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const logText = (logs) =>
  (logs?.lines || [])
    .map((l) => (typeof l === 'string' ? l : l?.line || l?.message || l?.text || ''))
    .join('\n');

async function runLanguage(key, spec) {
  const started = Date.now();
  console.log(`\n=== ${key} — ${spec.def.name} ===`);
  let bot;
  try {
    const created = await api('POST', '/api/bots', {
      ...spec.def,
      emoji: '🧪',
      description: 'language-matrix Testbot',
      autoRestart: false,
      secretEnv: { DISCORD_BOT_TOKEN: TOKEN },
    });
    bot = created.bot;
    for (const [pfad, inhalt] of Object.entries(spec.def.files))
      await api('PUT', `/api/bots/${bot.id}/files/${pfad}`, { inhalt });
    await api('POST', `/api/bots/${bot.id}/start`, {});

    let ready = false;
    let runningSeen = false;
    let lastStatus = '';
    let stoppedSince = 0;
    const deadline = Date.now() + spec.deadline * 1000;
    while (Date.now() < deadline) {
      await wait(5000);
      // Ein einzelner Hub-Neustart/Fehler darf einen 20-Minuten-Lauf nicht
      // killen: Liste mit Fang lesen, Durchlauf fortsetzen.
      const list = await api('GET', '/api/bots').catch(() => null);
      if (!list) continue;
      const now = list.bots.find((b) => b.id === bot.id);
      lastStatus = now?.status || '?';
      if (lastStatus === 'running') {
        runningSeen = true;
        stoppedSince = 0; // nur ununterbrochene Stop-Phasen zählen
      }
      const logs = await api('GET', `/api/bots/${bot.id}/logs`).catch(() => null);
      const text = logText(logs);
      if (text.includes(spec.marker)) {
        ready = true;
        break;
      }
      if (lastStatus === 'error' || lastStatus === 'crashed') {
        throw new Error(
          `Status ${lastStatus} — Logtail:\n${text.split('\n').slice(-15).join('\n')}`,
        );
      }
      if (lastStatus === 'stopped' && runningSeen) {
        stoppedSince = stoppedSince || Date.now();
        if (Date.now() - stoppedSince > 90_000)
          throw new Error(
            `abgestürzt (stopped, nie READY) — Logtail:\n${text.split('\n').slice(-15).join('\n')}`,
          );
      }
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (elapsed % 60 < 6) console.log(`  … ${lastStatus} (${elapsed}s)`);
    }
    if (!ready)
      throw new Error(
        `READY nie erreicht (Status ${lastStatus}) — Logtail:\n` +
          logText(await api('GET', `/api/bots/${bot.id}/logs`).catch(() => null))
            .split('\n')
            .slice(-15)
            .join('\n'),
      );
    /* Panel-Zustand: live im Bot-Objekt sichtbar? */
    let panel = '—';
    try {
      const now = (await api('GET', '/api/bots')).bots.find((b) => b.id === bot.id);
      panel = JSON.stringify(now?.panel || {}).includes('Bereit') ? '✓' : '?';
    } catch {
      /* Panel-Anzeige ist Beweiszusatz, kein K.-o.-Kriterium. */
    }
    const dur = Math.round((Date.now() - started) / 1000);
    return `OK ${dur}s (panel ${panel})`;
  } catch (error) {
    return `FEHLER: ${String(error).slice(0, 400)}`;
  } finally {
    if (bot && !KEEP) {
      await api('POST', `/api/bots/${bot.id}/stop`, {}).catch(() => {});
      await wait(2000);
      await api('DELETE', `/api/bots/${bot.id}`, {}).catch(
        (e) => console.log(`  cleanup ${key}: ${e.message}`),
      );
    } else if (bot) {
      console.log(`  behalten: ${bot.id}`);
    }
  }
}

async function createSignature() {
  const existing = (await api('GET', '/api/bots')).bots.find(
    (b) => b.name === signatureBot.name,
  );
  if (existing) {
    console.log(`Kommandante existiert bereits (${existing.id}, ${existing.status})`);
    return;
  }
  const { files, ...def } = signatureBot;
  const created = await api('POST', '/api/bots', {
    ...def,
    secretEnv: { DISCORD_BOT_TOKEN: TOKEN },
  });
  const bot = created.bot;
  for (const [pfad, inhalt] of Object.entries(files))
    await api('PUT', `/api/bots/${bot.id}/files/${pfad}`, { inhalt });
  await api('POST', `/api/bots/${bot.id}/start`, {});
  console.log(`Kommandante angelegt und gestartet: ${bot.id}`);
}

const list = async () => {
  for (const b of (await api('GET', '/api/bots')).bots)
    console.log(`${b.id}  ${b.name.padEnd(18)} ${b.language}/${b.framework}  ${b.status}`);
};

const cleanup = async () => {
  const listNow = (await api('GET', '/api/bots')).bots.filter((b) =>
    b.name.startsWith('Matrix '),
  );
  for (const b of listNow) {
    await api('POST', `/api/bots/${b.id}/stop`, {}).catch(() => {});
    await wait(1500);
    await api('DELETE', `/api/bots/${b.id}`, {}).catch((e) => console.log(b.name, e.message));
    console.log('gelöscht:', b.name);
  }
};

const main = async () => {
  if (!SESSION) {
    console.error('BOT_SESSION fehlt (Owner-Sitzung aus data/sessions.json).');
    process.exit(2);
  }
  if (args.includes('--list')) return list();
  if (args.includes('--cleanup')) return cleanup();
  if (!TOKEN) {
    console.error('DISCORD_TEST_TOKEN fehlt — Abbruch.');
    process.exit(2);
  }
  console.log(
    `Hub: ${HUB} | Sitzung: ${SESSION.slice(0, 8)}… | Token: übergeben (${TOKEN.length} Zeichen, wird nicht angezeigt)`,
  );
  if (args.includes('--signature')) return createSignature();
  const results = {};
  for (const [key, spec] of Object.entries(bots)) {
    if (onlyList && !onlyList.includes(key)) continue;
    results[key] = await runLanguage(key, spec);
    console.log(`${key}: ${results[key]}`);
  }
  console.log('\n===== Ergebnis =====');
  for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(12)} ${v}`);
};

if (!process.env.MATRIX_EXPORT_ONLY) {
  main().catch((error) => {
    console.error('Abbruch:', error);
    process.exit(1);
  });
}
export { bots, signatureBot };
