"""Anbindung an den Bot-Hub – nur Standardbibliothek.

Der Hub reicht beim Start drei Variablen in die Umgebung:

    BOT_HUB_URL     Adresse des Hubs, z. B. http://127.0.0.1:8787
    BOT_HUB_ID      ID dieses Bots
    BOT_HUB_TOKEN   Kurzlebiges Token – gilt nur, solange der Prozess läuft

Damit kann der Bot seine Werte an das Dashboard schicken und die Einstellungen
lesen, die dort gepflegt werden. Läuft der Code ohne Hub (manuell gestartet),
sind alle Funktionen still und werfen nichts.

    from hub_link import publish, settings, on_settings

    publish({"status": "online", "guilds": 3})
    for wert in on_settings():
        ...
"""

from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
from typing import Any, Callable, Iterator

URL = os.environ.get("BOT_HUB_URL", "").rstrip("/")
TOKEN = os.environ.get("BOT_HUB_TOKEN", "")
CONNECTED = bool(URL and TOKEN)


def call(path: str, payload: dict | None = None, timeout: float = 8.0) -> Any:
    """Ruft einen Hub-Endpunkt auf. Ohne Hub (manueller Start) kommt None."""
    if not CONNECTED:
        return None
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{URL}/api/hub/{path.lstrip('/')}",
        data=body,
        headers={
            "authorization": f"Bearer {TOKEN}",
            "content-type": "application/json",
        },
        method="GET" if body is None else "POST",
    )
    request.add_header("authorization", f"Bearer {TOKEN}")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}
    except (urllib.error.URLError, OSError, ValueError) as error:
        print(f"hub_link: {path} fehlgeschlagen ({error})", flush=True)
        return None


def settings() -> dict[str, Any]:
    """Aktuelle Einstellungen aus dem Dashboard (inkl. Standardwerten)."""
    return (call("settings") or {}).get("settings", {})


def publish(state: dict[str, Any]) -> None:
    """Live-Werte für die Bot-Seite im Dashboard (Status, Zähler, …)."""
    call("state", {"state": state})


def notify(message: str, kind: str = "info") -> None:
    """Kurze Meldung als Toast im Dashboard."""
    call("notify", {"message": message, "kind": kind})


def register(panel: dict[str, Any]) -> Any:
    """Meldet eine eigene Seite an – nur wenn kein bot-hub.json existiert."""
    return call("panel", {"panel": panel})


def callback(url: str, token: str = "") -> Any:
    """Lokale URL, an die der Hub Aktionsklicks schickt (nur localhost)."""
    return call("callback", {"url": url, "token": token})


def on_settings(
    callback: Callable[[dict[str, Any]], None],
    on_refresh: Callable[[], None] | None = None,
) -> threading.Thread:
    """Startet einen Hintergrund-Thread, der auf Änderungen reagiert.

    Der Hub schickt bei jeder Änderung ein SSE-Ereignis `settings` und nach
    einer Aktion in der Oberfläche zusätzlich `refresh` – dann bitte sofort
    neue Live-Werte melden, statt auf den nächsten Herzschlag zu warten.
    """

    def watch() -> None:
        kind = ""
        wait = 2.0

        def handle(raw: bytes) -> None:
            nonlocal kind
            line = raw.decode("utf-8").strip()
            if line.startswith("event:"):
                kind = line[6:].strip()
            elif line.startswith("data:"):
                try:
                    data = json.loads(line[5:])
                except ValueError:
                    return
                if kind == "refresh":
                    if on_refresh is not None:
                        on_refresh()
                else:
                    callback(data.get("settings", {}))
                kind = ""

        import time

        while CONNECTED:
            try:
                request = urllib.request.Request(
                    f"{URL}/api/hub/events?token={TOKEN}",
                    headers={"accept": "text/event-stream"},
                )
                with urllib.request.urlopen(request, timeout=None) as stream:
                    wait = 2.0
                    for raw in stream:
                        handle(raw)
            except (urllib.error.URLError, OSError) as error:
                print(f"hub_link: Ereignis-Stream beendet ({error})", flush=True)
            # Ohne neuen Versuch bliebe der Bot für den Rest der Sitzung taub.
            time.sleep(wait)
            wait = min(wait * 2, 30.0)

    if not CONNECTED:
        return None  # type: ignore[return-value]
    thread = threading.Thread(target=watch, daemon=True, name="hub-settings")
    thread.start()
    return thread


def iter_settings(poll: float = 3.0) -> Iterator[dict[str, Any]]:
    """Einfachste Variante: Werte pollen (für Skripte ohne Threads)."""
    while CONNECTED:
        yield settings()
        import time

        time.sleep(poll)
