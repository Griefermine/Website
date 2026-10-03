"""Python-Bot für den Bot-Hub (discord.py).

Enthält zwei Dinge in einer Datei:
  * den klassischen Echo-Demo-Bot (``!ping``, Demo-Modus ohne Token)
  * die Rollen-Verwaltung (Slash-Commands, Modale, Permission-Dropdowns)

Start über den Bot-Hub oder manuell:
    DISCORD_BOT_TOKEN=... python3 bots/python-echo/bot.py

Ohne Token oder ohne discord.py läuft der Bot im Demo-Modus und schreibt
nur Log-Ausgaben, damit das Dashboard etwas zu zeigen hat.

Anbindung an die Weboberfläche:
  * ``bot-hub.json`` beschreibt die eigene Seite samt Einstellungen
  * ``hub_link.py`` schickt Live-Werte an das Dashboard
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import hub_link

LEVELS = ["debug", "info", "info", "info", "warn", "error"]
CALLBACK_TOKEN = secrets.token_urlsafe(24)


def _load_dotenv() -> None:
    """Lädt .env, falls python-dotenv installiert ist."""
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv()


_load_dotenv()

TOKEN = os.environ.get("DISCORD_BOT_TOKEN")
GUILD_ID = os.environ.get("DISCORD_GUILD_ID")
HUB_SETTINGS = hub_link.settings()


def setting_bool(key: str, default: bool = True) -> bool:
    value = HUB_SETTINGS.get(key)
    if value is None:
        value = os.environ.get(key.upper(), default)
    if isinstance(value, str):
        return value.lower() not in {"0", "false", "off", "no", ""}
    return bool(value)


def command_enabled(command: str) -> bool:
    return setting_bool(f"command_{command}", True)



logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
    stream=sys.stdout,
    force=True,
)
logger = logging.getLogger("python-echo")

# --- Rollen-Berechtigungen (reine Daten, brauchen kein discord.py) ---

ALL_PERMISSIONS = [
    ("Administrator", "administrator", "Alle Rechte"),
    ("Mitglieder bannen", "ban_members", "Mitglieder bannen"),
    ("Mitglieder kicken", "kick_members", "Mitglieder kicken"),
    ("Rollen verwalten", "manage_roles", "Rollen verwalten"),
    ("Kanäle verwalten", "manage_channels", "Kanäle verwalten"),
    ("Nachrichten verwalten", "manage_messages", "Nachrichten verwalten/löschen"),
    ("Nachrichten senden", "send_messages", "Nachrichten senden"),
    ("Nachrichten lesen", "view_channel", "Nachrichten lesen"),
    ("Nachrichten anhängen", "attach_files", "Dateien anhängen"),
    ("Links einbetten", "embed_links", "Links einbetten"),
    ("@everyone/@here erwähnen", "mention_everyone", "@everyone/@here erwähnen"),
    ("Threads verwalten", "manage_threads", "Threads verwalten"),
    ("Emojis verwalten", "manage_emojis", "Emojis verwalten"),
    ("Sticker verwalten", "manage_stickers", "Sticker verwalten"),
    ("Webhooks verwalten", "manage_webhooks", "Webhooks verwalten"),
    ("Server verwalten", "manage_guild", "Server verwalten"),
    ("Events verwalten", "manage_events", "Events verwalten"),
    ("Nicknames ändern", "change_nickname", "Eigenen Nickname ändern"),
    ("Nicknames verwalten", "manage_nicknames", "Nicknames verwalten"),
    ("Sprachkanäle verbinden", "connect", "Sprachkanäle verbinden"),
    ("In Sprachkanälen sprechen", "speak", "In Sprachkanälen sprechen"),
    ("Mitglieder verschieben", "move_members", "Mitglieder verschieben"),
    ("Mitglieder stummschalten", "mute_members", "Mitglieder stummschalten"),
    ("Mitglieder taub schalten", "deafen_members", "Mitglieder taub schalten"),
    ("Nachrichten anpinnen", "pin_messages", "Nachrichten anpinnen"),
    ("Nachrichten entpinnen", "unpin_messages", "Nachrichten entpinnen"),
    ("Mitglieder verwalten", "manage_members", "Mitglieder verwalten"),
    ("Nachrichten lesen (History)", "read_message_history", "Nachrichtenverlauf lesen"),
    ("TTS-Nachrichten senden", "send_tts_messages", "TTS-Nachrichten senden"),
    ("Reaktionen hinzufügen", "add_reactions", "Reaktionen hinzufügen"),
]

PERMISSION_CHUNK_SIZE = 24


def chunk_permissions(
    options: list[tuple[str, str, str]], size: int = PERMISSION_CHUNK_SIZE
) -> list[list[tuple[str, str, str]]]:
    """Teilt die Berechtigungen in Dropdown-größere Blöcke (max. 25 Optionen)."""
    chunks = []
    for i in range(0, len(options), size):
        chunk = options[i : i + size]
        if chunk:  # Nur nicht-leere Chunks zulassen
            chunks.append(chunk)
    return chunks


async def demo_mode() -> None:
    print(f"Demo-Modus aktiv (Guild: {GUILD_ID or 'nicht gesetzt'})", flush=True)
    settings = HUB_SETTINGS
    hub_link.publish(
        {
            "status": "demo",
            "mode": settings.get("mode", "–"),
            "cooldown": settings.get("cooldown", 0),
            "startedAt": time.time(),
        }
    )
    while True:
        level = random.choice(LEVELS)
        print(f"[{level.upper():<5}] simulated event #{random.randint(100, 999)}", flush=True)
        await asyncio.sleep(3)


def hub_state(bot: Any = None) -> dict[str, Any]:
    """Aktueller Stand für die Bot-Seite – auch auf Zuruf."""
    state: dict[str, Any] = {"mode": HUB_SETTINGS.get("mode", "–")}
    if bot is not None:
        # Solange die Verbindung steht, ist die Latenz NaN. round(NaN) wirft
        # und würde den Herzschlag für den Rest der Sitzung beenden.
        latency = getattr(bot, "latency", None)
        state |= {
            "status": "online",
            "guilds": len(getattr(bot, "guilds", [])),
            "latency": f"{round(latency * 1000)} ms" if latency == latency else "–",
            "user": str(getattr(bot, "user", None) or ""),
        }
    return state


async def hub_heartbeat(bot: Any = None) -> None:
    """Schickt Live-Werte an die Bot-Seite im Dashboard."""
    while True:
        try:
            hub_link.publish(hub_state(bot))
        except Exception as error:  # noqa: BLE001
            # Ein Fehler darf den Rhythmus nicht abbrechen, sonst stehen die
            # Werte auf der Bot-Seite den ganzen Rest der Sitzung still.
            logger.warning(f"Live-Werte nicht gemeldet: {error}")
        await asyncio.sleep(15)


def callback_guild(bot: Any) -> Any:
    if GUILD_ID:
        return bot.get_guild(int(GUILD_ID))
    return bot.guilds[0] if bot.guilds else None


async def handle_panel_command(bot: Any, command_id: str, args: dict[str, Any]) -> dict[str, Any]:
    guild = callback_guild(bot)
    if guild is None:
        raise RuntimeError("Kein Ziel-Server gefunden. Setze eine gültige GUILD_ID.")
    if command_id == "roles_list":
        return {
            "roles": [
                {
                    "id": str(role.id),
                    "name": role.name,
                    "color": str(role.color),
                    "position": role.position,
                    "managed": role.managed,
                    "hoist": role.hoist,
                    "mentionable": role.mentionable,
                }
                for role in reversed(guild.roles)
                if not role.is_default()
            ]
        }
    if command_id == "role_create_web":
        name = str(args.get("name", "")).strip()[:100]
        if not name:
            raise ValueError("Der Rollenname fehlt.")
        if any(role.name.casefold() == name.casefold() for role in guild.roles):
            raise ValueError(f'Die Rolle "{name}" existiert bereits.')
        role = await guild.create_role(
            name=name,
            colour=discord_colour(args.get("color")),
            hoist=bool(args.get("hoist", False)),
            mentionable=bool(args.get("mentionable", False)),
            reason="Über Python-Echo-Webseite erstellt",
        )
        hub_link.notify(f'Rolle "{role.name}" erstellt.', "success")
        return {"role": role_payload(role), "message": f'Rolle "{role.name}" erstellt.'}
    if command_id == "role_update":
        role = guild.get_role(int(args.get("id", 0)))
        if role is None or role.is_default():
            raise ValueError("Rolle nicht gefunden oder nicht bearbeitbar.")
        if role.managed:
            raise ValueError("Verwaltete Discord-Rollen können nicht geändert werden.")
        name = str(args.get("name", role.name)).strip()[:100]
        if not name:
            raise ValueError("Der Rollenname fehlt.")
        role = await role.edit(
            name=name,
            colour=discord_colour(args.get("color"), role.color),
            hoist=bool(args.get("hoist", role.hoist)),
            mentionable=bool(args.get("mentionable", role.mentionable)),
            reason="Über Python-Echo-Webseite bearbeitet",
        )
        hub_link.notify(f'Rolle "{role.name}" aktualisiert.', "success")
        return {"role": role_payload(role), "message": f'Rolle "{role.name}" aktualisiert.'}
    if command_id == "role_delete":
        role = guild.get_role(int(args.get("id", 0)))
        if role is None or role.is_default():
            raise ValueError("Rolle nicht gefunden oder nicht löschbar.")
        if role.managed:
            raise ValueError("Verwaltete Discord-Rollen können nicht gelöscht werden.")
        name = role.name
        await role.delete(reason="Über Python-Echo-Webseite gelöscht")
        hub_link.notify(f'Rolle "{name}" gelöscht.', "success")
        return {"id": str(args.get("id")), "message": f'Rolle "{name}" gelöscht.'}
    raise ValueError(f"Unbekannte Panel-Aktion: {command_id}")


def role_payload(role: Any) -> dict[str, Any]:
    return {
        "id": str(role.id),
        "name": role.name,
        "color": str(role.color),
        "position": role.position,
        "managed": role.managed,
        "hoist": role.hoist,
        "mentionable": role.mentionable,
    }


def discord_colour(value: Any, fallback: Any = None) -> Any:
    import discord

    raw = str(value or "").strip().lstrip("#")
    if not raw:
        return fallback or discord.Colour.default()
    try:
        return discord.Colour(int(raw, 16))
    except (ValueError, TypeError):
        raise ValueError("Ungültige Rollenfarbe. Nutze z. B. #5865F2.")


def start_panel_callback(bot: Any, loop: asyncio.AbstractEventLoop) -> ThreadingHTTPServer:
    class CallbackHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            if self.path != "/panel":
                self.send_error(404)
                return
            if self.headers.get("x-bot-hub-token", "") != CALLBACK_TOKEN:
                self.send_error(401)
                return
            try:
                length = min(int(self.headers.get("content-length", "0")), 64 * 1024)
                body = json.loads(self.rfile.read(length) or b"{}")
                command_id = str(body.get("id", ""))
                future = asyncio.run_coroutine_threadsafe(
                    handle_panel_command(bot, command_id, body.get("args") or {}),
                    loop,
                )
                result = future.result(timeout=30)
                response = {"ok": True, **result}
                status = 200
            except Exception as error:  # noqa: BLE001
                response = {"ok": False, "error": str(error)}
                status = 400
            raw = json.dumps(response, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), CallbackHandler)
    threading.Thread(
        target=server.serve_forever,
        daemon=True,
        name="panel-callback",
    ).start()
    hub_link.callback(f"http://127.0.0.1:{server.server_port}/panel", CALLBACK_TOKEN)
    logger.info(f"Panel-Callback aktiv auf Port {server.server_port}")
    return server


def create_bot(discord: Any) -> Any:
    """Baut den discord.py-Bot mit Echo- und Rollen-Funktionen.

    Wird erst aufgerufen, wenn discord.py wirklich importiert werden konnte –
    so bleibt der Demo-Modus auch ohnediscord.py nutzbar.
    """
    from discord import app_commands
    from discord.ext import commands
    from discord.ui import Modal, Select, TextInput, View

    # Intents setzen (für Rollen/Kanäle benötigt)
    intents = discord.Intents.default()
    intents.guilds = True
    intents.guild_messages = True
    intents.guild_reactions = True
    intents.members = True
    intents.message_content = True

    bot = commands.Bot(command_prefix="!", intents=intents)

    # --- Dropdown für einzelne Berechtigungen ---

    class RolePermissionSelect(Select):
        def __init__(self, idx, options, disabled=False):
            # Füge immer eine "Nichts"-Option hinzu
            select_options = [
                discord.SelectOption(label=label, value=value, description=desc)
                for label, value, desc in options
            ]
            select_options.insert(
                0,
                discord.SelectOption(
                    label="Nichts auswählen",
                    value="none",
                    description="Keine dieser Berechtigungen",
                ),
            )
            if len(select_options) < 1:
                raise ValueError("Ein Dropdown muss mindestens eine Option enthalten!")
            # Schutz: max_values nie über 25
            max_vals = min(len(select_options), 25)
            super().__init__(
                placeholder=f"Berechtigungen auswählen (Teil {idx + 1})...",
                min_values=1,
                max_values=max_vals,
                options=select_options,
                disabled=disabled,
            )

    # --- View für schrittweise Auswahl ---

    class StepPermissionView(View):
        def __init__(self, rollenname, chunked_permissions, current_idx=0, selected=None):
            super().__init__(timeout=180)
            self.rollenname = rollenname
            self.chunked_permissions = list(chunked_permissions)
            self.current_idx = current_idx
            self.selected = selected or []  # Liste aller gewählten Werte
            # Nur das aktuelle Dropdown anzeigen
            select = RolePermissionSelect(current_idx, self.chunked_permissions[current_idx])
            select.callback = self.make_callback()
            self.add_item(select)

        def make_callback(self):
            async def callback(interaction: discord.Interaction):
                # Werte aus diesem Dropdown speichern (ohne 'none')
                values = [v for v in interaction.data.get("values", []) if v != "none"]
                all_selected = self.selected + values
                next_idx = self.current_idx + 1
                if next_idx < len(self.chunked_permissions):
                    # Nächstes Dropdown anzeigen
                    new_view = StepPermissionView(
                        self.rollenname, self.chunked_permissions, next_idx, all_selected
                    )
                    text = (
                        "Wähle die nächsten Berechtigungen für die Rolle "
                        f"**{self.rollenname}**:"
                    )
                    try:
                        await interaction.response.edit_message(content=text, view=new_view)
                    except discord.errors.NotFound:
                        await interaction.followup.send(text, view=new_view, ephemeral=True)
                else:
                    # Alle Permissions gewählt, Rolle erstellen
                    guild = interaction.guild
                    perms = discord.Permissions()
                    alle_werte = set(all_selected)
                    logger.info(
                        f"User {interaction.user} startet Rollen-Erstellung: {self.rollenname}"
                    )
                    if "administrator" in alle_werte:
                        perms.update(administrator=True)
                        logger.info("Administrator-Rechte gesetzt.")
                    else:
                        for value in alle_werte:
                            if hasattr(perms, value):
                                setattr(perms, value, True)
                                logger.info(f"Permission gesetzt: {value}")
                    try:
                        role = await guild.create_role(
                            name=self.rollenname, permissions=perms
                        )
                        logger.info(
                            f"Rolle erstellt: {role.name} (ID: {role.id}) "
                            f"mit Permissions: {perms.value}"
                        )
                        try:
                            await interaction.response.edit_message(
                                content=f'Rolle "{role.name}" mit Berechtigungen erstellt!',
                                view=None,
                            )
                        except discord.errors.NotFound:
                            await interaction.followup.send(
                                f'Rolle "{role.name}" mit Berechtigungen erstellt! '
                                "(Nachricht, da Interaktion abgelaufen)",
                                ephemeral=True,
                            )
                    except Exception as error:  # noqa: BLE001
                        logger.error(f"Fehler beim Erstellen der Rolle: {error}")
                        try:
                            await interaction.response.edit_message(
                                content=f"Fehler beim Erstellen der Rolle: {error}",
                                view=None,
                            )
                        except discord.errors.NotFound:
                            await interaction.followup.send(
                                f"Fehler beim Erstellen der Rolle: {error} "
                                "(Nachricht, da Interaktion abgelaufen)",
                                ephemeral=True,
                            )

            return callback

    # --- Modal: einzelner Rollenname ---

    class RoleNameModal(Modal, title="Rollenname eingeben"):
        rollenname = TextInput(
            label="Wie soll die Rolle heißen?", placeholder="z.B. Supporter", required=True
        )

        def __init__(self, interaction: discord.Interaction):
            super().__init__()
            self.interaction = interaction

        async def on_submit(self, interaction: discord.Interaction):
            logger.info(
                f"Modal ausgefüllt von {interaction.user}: "
                f"Rollenname={self.rollenname.value}"
            )
            chunks = list(chunk_permissions(ALL_PERMISSIONS, PERMISSION_CHUNK_SIZE))
            view = StepPermissionView(self.rollenname.value, chunks, 0, [])
            text = f"Wähle die Berechtigungen für die Rolle **{self.rollenname.value}**:"
            try:
                await interaction.response.send_message(text, view=view, ephemeral=True)
            except discord.errors.NotFound:
                await interaction.followup.send(text, view=view, ephemeral=True)

    # --- Modal: mehrere Rollennamen auf einmal ---

    class MassRoleNamesModal(Modal, title="Mehrere Rollennamen eingeben"):
        rollennamen = TextInput(
            label="Rollennamen (Komma/Zeilenumbruch)",
            style=discord.TextStyle.paragraph,
            placeholder="z.B. Supporter, Moderator, Admin",
            required=True,
        )

        def __init__(self, interaction: discord.Interaction):
            super().__init__()
            self.interaction = interaction

        async def on_submit(self, interaction: discord.Interaction):
            logger.info(
                f"MassRoleNamesModal ausgefüllt von {interaction.user}: "
                f"Rollennamen={self.rollennamen.value}"
            )
            # Rollennamen aufteilen (Komma oder Zeilenumbruch)
            namen_raw = self.rollennamen.value.replace("\r", "").replace("\n", ",")
            namen = [n.strip() for n in namen_raw.split(",") if n.strip()]
            if not namen:
                await interaction.response.send_message(
                    "Keine gültigen Rollennamen angegeben.", ephemeral=True
                )
                return
            guild = interaction.guild
            created = []
            skipped = []
            errors = []
            for name in namen:
                if discord.utils.get(guild.roles, name=name):
                    skipped.append(name)
                    continue
                try:
                    role = await guild.create_role(name=name)
                    created.append(role.name)
                    logger.info(f"Massenrolle erstellt: {role.name} (ID: {role.id})")
                except Exception as error:  # noqa: BLE001
                    logger.error(f"Fehler beim Erstellen der Rolle {name}: {error}")
                    errors.append(f"{name} ({error})")
            msg = []
            if created:
                msg.append(f"Erstellte Rollen: {', '.join(created)}")
            if skipped:
                msg.append(f"Übersprungen (existieren bereits): {', '.join(skipped)}")
            if errors:
                msg.append(f"Fehler: {', '.join(errors)}")
            await interaction.response.send_message(
                "\n".join(msg) or "Keine Rollen erstellt.", ephemeral=True
            )

    # --- Slash-Commands ---

    @bot.tree.command(
        name="role_create", description="Erstelle eine neue Rolle mit Auswahl der Berechtigungen."
    )
    @app_commands.checks.has_permissions(administrator=True)
    async def role_create(interaction: discord.Interaction):
        if not command_enabled("role_create"):
            await interaction.response.send_message("Dieser Command ist deaktiviert.", ephemeral=True)
            return
        logger.info(f"Slash-Command /role_create von {interaction.user}")
        await interaction.response.send_modal(RoleNameModal(interaction))

    @bot.tree.command(
        name="create_mass_roles",
        description="Erstelle mehrere Rollen auf einmal (durch Komma oder Zeilenumbruch getrennt)",
    )
    @app_commands.checks.has_permissions(manage_roles=True)
    async def create_mass_roles(interaction: discord.Interaction):
        if not command_enabled("create_mass_roles"):
            await interaction.response.send_message("Dieser Command ist deaktiviert.", ephemeral=True)
            return
        logger.info(f"Slash-Command /create_mass_roles von {interaction.user}")
        await interaction.response.send_modal(MassRoleNamesModal(interaction))

    # --- Prefix-Commands ---

    @bot.command(name="ping")
    async def ping(ctx):
        if not command_enabled("ping"):
            return
        latency = round(bot.latency * 1000)
        await ctx.send(f"🏓 Pong! {latency} ms")
        print(f"auf !ping geantwortet ({latency} ms)", flush=True)

    @bot.command()
    @commands.has_guild_permissions(manage_roles=True)
    async def rolle_erstellen(ctx, *, rollenname: str):
        if not command_enabled("rolle_erstellen"):
            return
        guild = ctx.guild
        logger.info(f"!rolle_erstellen von {ctx.author}: {rollenname}")
        existing_role = discord.utils.get(guild.roles, name=rollenname)
        if existing_role:
            logger.info(f"Rolle existiert bereits: {rollenname}")
            await ctx.send(f'Rolle "{rollenname}" existiert bereits.')
            return
        try:
            role = await guild.create_role(name=rollenname)
            logger.info(f"Rolle erstellt: {role.name} (ID: {role.id})")
            await ctx.send(f'Rolle "{role.name}" wurde erstellt!')
        except Exception as error:  # noqa: BLE001
            logger.error(f"Fehler beim Erstellen der Rolle: {error}")
            await ctx.send(f"Fehler beim Erstellen der Rolle: {error}")

    @bot.command()
    @commands.has_guild_permissions(manage_channels=True)
    async def kategorie_erstellen(ctx, *, kategoriename: str):
        if not command_enabled("kategorie_erstellen"):
            return
        guild = ctx.guild
        logger.info(f"!kategorie_erstellen von {ctx.author}: {kategoriename}")
        existing_category = discord.utils.get(guild.categories, name=kategoriename)
        if existing_category:
            logger.info(f"Kategorie existiert bereits: {kategoriename}")
            await ctx.send(f'Kategorie "{kategoriename}" existiert bereits.')
            return
        try:
            category = await guild.create_category(name=kategoriename)
            logger.info(f"Kategorie erstellt: {category.name} (ID: {category.id})")
            await ctx.send(f'Kategorie "{category.name}" wurde erstellt!')
        except Exception as error:  # noqa: BLE001
            logger.error(f"Fehler beim Erstellen der Kategorie: {error}")
            await ctx.send(f"Fehler beim Erstellen der Kategorie: {error}")

    @bot.command()
    @commands.has_guild_permissions(manage_channels=True)
    async def kanal_erstellen(ctx, kanalname: str, kategoriename: str = None):
        if not command_enabled("kanal_erstellen"):
            return
        guild = ctx.guild
        logger.info(f"!kanal_erstellen von {ctx.author}: {kanalname} (Kategorie: {kategoriename})")
        category = None
        if kategoriename:
            category = discord.utils.get(guild.categories, name=kategoriename)
            if not category:
                logger.info(f"Kategorie nicht gefunden: {kategoriename}")
                await ctx.send(f'Kategorie "{kategoriename}" nicht gefunden.')
                return
        existing_channel = discord.utils.get(guild.text_channels, name=kanalname)
        if existing_channel:
            logger.info(f"Kanal existiert bereits: {kanalname}")
            await ctx.send(f'Kanal "{kanalname}" existiert bereits.')
            return
        try:
            channel = await guild.create_text_channel(name=kanalname, category=category)
            logger.info(f"Textkanal erstellt: {channel.name} (ID: {channel.id})")
            await ctx.send(f'Textkanal "{channel.name}" wurde erstellt!')
        except Exception as error:  # noqa: BLE001
            logger.error(f"Fehler beim Erstellen des Kanals: {error}")
            await ctx.send(f"Fehler beim Erstellen des Kanals: {error}")

    # --- Events: Echo (!ping) + Command-Dispatch + Slash-Command-Sync ---

    @bot.event
    async def on_ready():
        logger.info(f"Bot ist eingeloggt als {bot.user} (ID: {bot.user.id})")
        namen = ", ".join(command.name for command in bot.tree.get_commands())
        logger.info(f"Registrierte Slash-Commands: {namen or 'keine'}")

        # 1) Test-Guild zuerst: dort erscheinen die Commands sofort.
        if GUILD_ID:
            guild = None
            # on_ready feuert teils, bevor alle Guilds im Cache sind -> kurz warten.
            for _ in range(20):
                guild = discord.utils.get(bot.guilds, id=int(GUILD_ID))
                if guild is not None:
                    break
                await asyncio.sleep(0.5)
            if guild is None:
                logger.warning(
                    f"GUILD_ID {GUILD_ID} nicht gefunden – Bot ist dort kein Mitglied. "
                    "Nur globaler Sync."
                )
            else:
                logger.info(f"Guild: {guild.name} (ID: {guild.id})")
                try:
                    synced = await bot.tree.sync(guild=guild)
                    logger.info(
                        f"{len(synced)} Slash-Commands in '{guild.name}' synchronisiert: "
                        f"{', '.join(command.name for command in synced)}"
                    )
                except Exception as error:  # noqa: BLE001
                    logger.error(
                        f"Guild-Sync fehlgeschlagen ({guild.name}): {error!r} – "
                        "prüfe den Invite-Scope 'applications.commands'. "
                        "Es folgt der globale Sync."
                    )

        # 2) Global: damit die Commands in allen Servern verfügbar sind
        #    (kann bis zu 1 Stunde dauern).
        try:
            synced = await bot.tree.sync()
            logger.info(
                f"{len(synced)} Slash-Commands global synchronisiert: "
                f"{', '.join(command.name for command in synced)}"
            )
        except Exception as error:  # noqa: BLE001
            logger.error(f"Globaler Slash-Command-Sync fehlgeschlagen: {error!r}")

    @bot.tree.error
    async def on_app_command_error(interaction: discord.Interaction, error: Exception):
        logger.error(
            f"Fehler bei Slash-Command {interaction.command.qualified_name if interaction.command else '?'} "
            f"von {interaction.user}: {error!r}",
            exc_info=error,
        )
        message = "Da ist etwas schiefgelaufen – bitte später nochmal versuchen."
        try:
            if interaction.response.is_done():
                await interaction.followup.send(message, ephemeral=True)
            else:
                await interaction.response.send_message(message, ephemeral=True)
        except discord.HTTPException:
            pass

    @bot.event
    async def on_message(message):
        if message.author.bot:
            return

        if message.content.strip() == "!ping":
            if not command_enabled("ping"):
                return
            await bot.process_commands(message)
            return

        # Prefix-Commands (z. B. !rolle_erstellen) weiterleiten
        await bot.process_commands(message)

    return bot


async def run_real_bot() -> None:
    import discord

    def apply_settings(new: dict) -> None:
        """Reagiert auf Änderungen aus dem Dashboard (SSE-Stream)."""
        HUB_SETTINGS.clear()
        HUB_SETTINGS.update(new)
        logger.info(f"Einstellungen aus dem Dashboard: {new}")

    def report_now() -> None:
        """Meldet die Live-Werte sofort – der Hub fragt nach jeder Aktion."""
        hub_link.publish(hub_state(bot))

    bot = create_bot(discord)
    async with bot:
        callback_server = start_panel_callback(bot, asyncio.get_running_loop())
        hub_link.on_settings(apply_settings, report_now)
        task = asyncio.create_task(hub_heartbeat(bot))
        try:
            await bot.start(TOKEN)
        finally:
            task.cancel()
            callback_server.shutdown()
            callback_server.server_close()


if __name__ == "__main__":
    started = time.time()
    print(f"python-echo startet (Python {os.sys.version.split()[0]})", flush=True)
    if hub_link.CONNECTED:
        print(
            f"Bot-Hub erkannt ({hub_link.URL}) – "
            f"Einstellungen: {HUB_SETTINGS or 'keine'}",
            flush=True,
        )
    if not TOKEN:
        print("WARNUNG: DISCORD_BOT_TOKEN fehlt – Demo-Modus", flush=True)
        asyncio.run(demo_mode())
    else:
        try:
            asyncio.run(run_real_bot())
        except ImportError:
            print("discord.py fehlt – pip install discord.py – Demo-Modus", flush=True)
            asyncio.run(demo_mode())
        except Exception as error:  # noqa: BLE001
            print(f"FEHLER beim Start: {error}", flush=True)
            raise
    logger.info(f"Beendet nach {time.time() - started:.1f}s")
