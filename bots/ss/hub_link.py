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

Dazu kommt der Bot-Speicher: ein eigener Bereich pro Bot in der Datenbank des
Hubs, erreichbar nur von diesem Prozess. SQLite oder MySQL entscheidet der
Hub, der Bot merkt davon nichts.

    from hub_link import db_get, db_set, db_list, db_remove

    db_set("notizen", f"user:{message.author.id}", {"text": "hallo"})
    wert = db_get("notizen", f"user:{message.author.id}")
"""

from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
from urllib.parse import quote, urlencode, urlparse
from typing import Any, Callable, Iterator

_raw_url = os.environ.get("BOT_HUB_URL", "").strip().rstrip("/")
_parsed_url = urlparse(_raw_url) if _raw_url else None
if _parsed_url and (
    _parsed_url.scheme not in {"http", "https"}
    or _parsed_url.username
    or _parsed_url.password
    or _parsed_url.query
    or _parsed_url.fragment
    or (
        os.environ.get("NODE_ENV") == "production"
        and _parsed_url.scheme != "https"
        and _parsed_url.hostname not in {"127.0.0.1", "::1", "localhost"}
    )
):
    raise RuntimeError("BOT_HUB_URL ist ungültig oder unsicher")

URL = _raw_url
TOKEN = os.environ.get("BOT_HUB_TOKEN", "").strip()
if TOKEN and (
    not (32 <= len(TOKEN) <= 256)
    or not all(char.isalnum() or char in "_-" for char in TOKEN)
):
    raise RuntimeError("BOT_HUB_TOKEN hat ein ungültiges Format")
CONNECTED = bool(URL and TOKEN)


def call(
    path: str,
    payload: dict | None = None,
    timeout: float = 8.0,
    method: str | None = None,
    query: dict | None = None,
    quiet: bool = False,
) -> Any:
    """Ruft einen Hub-Endpunkt auf. Ohne Hub (manueller Start) kommt None.

    `method` ist nur für PUT und DELETE nötig; ohne `payload` wird nichts
    gesendet. `quiet` unterdrückt die Fehlermeldung – für Abfragen, bei denen
    "nicht gefunden" eine normale Antwort ist.
    """
    if not CONNECTED:
        return None
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    verb = method or ("GET" if body is None else "POST")
    if body is None and verb not in {"GET", "DELETE", "HEAD"}:
        body = b"{}"
    parameter = urlencode(
        {k: v for k, v in (query or {}).items() if v not in (None, "")}
    )
    target = f"{URL}/api/hub/{path.lstrip('/')}"
    if parameter:
        target += f"?{parameter}"
    request = urllib.request.Request(
        target,
        data=body,
        headers={
            "authorization": f"Bearer {TOKEN}",
            "content-type": "application/json",
        },
        method=verb,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}
    except (urllib.error.URLError, OSError, ValueError) as error:
        if not quiet:
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


def _segment(value: str, label: str) -> str:
    """Ein Pfadsegment für den Bot-Speicher, kodiert.

    Der Hub prüft Namen gegen ein Muster und setzt sie als Parameter in die
    SQL-Abfrage; hier werden sie nur kodiert, damit ein Doppelpunkt im
    Schlüssel den Weg nicht verändert.
    """
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{label} darf nicht leer sein")
    return quote(text, safe="")


def _path(collection: str, key: str) -> str:
    return f"db/{_segment(collection, 'Sammlungsname')}/{_segment(key, 'Schlüssel')}"


def db_get(collection: str, key: str, timeout: float = 8.0) -> Any:
    """Liest einen Wert aus dem Bot-Speicher, sonst None."""
    data = call(_path(collection, key), timeout=timeout, quiet=True)
    if not data:
        return None
    return data.get("entry", {}).get("value")


def db_set(collection: str, key: str, value: Any, timeout: float = 8.0) -> Any:
    """Legt einen Wert an oder überschreibt ihn."""
    return call(_path(collection, key), {"value": value}, timeout=timeout, method="PUT")


def db_list(
    collection: str,
    prefix: str = "",
    limit: int | None = None,
    offset: int | None = None,
    timeout: float = 8.0,
) -> Any:
    """Listet Einträge einer Sammlung: {entries, total, limit, offset}."""
    return call(
        f"db/{_segment(collection, 'Sammlungsname')}",
        timeout=timeout,
        query={"prefix": prefix, "limit": limit, "offset": offset},
    )


def db_remove(collection: str, key: str, timeout: float = 8.0) -> Any:
    """Löscht einen Eintrag. Meldet {removed: True/False}."""
    return call(_path(collection, key), timeout=timeout, method="DELETE")


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
                    f"{URL}/api/hub/events",
                    headers={
                        "accept": "text/event-stream",
                        "authorization": f"Bearer {TOKEN}",
                    },
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
