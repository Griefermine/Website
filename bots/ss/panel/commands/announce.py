"""Aktion "Status melden" – schreibt den Betriebszustand in den Log-Kanal.

Zeigt, wie ein Skript auf Daten des Bots und auf die Dashboard-Einstellungen
zugreift. Für echte Meldungen Discord hier aufrufen (`ctx.send` o. Ä.).
"""

import json
import os
import time


def main() -> int:
    stamp = time.strftime("%H:%M:%S")
    log_channel = os.environ.get("BOT_HUB_SETTING_LOG_CHANNEL", "bot-log")
    mode = os.environ.get("BOT_HUB_SETTING_MODE", "unknown")
    args = json.loads(os.environ.get("BOT_HUB_ARGS", "{}"))

    if args.get("dry"):
        print(json.dumps({"ok": True, "message": "nur geprüft, nichts gesendet"}))
        return 0

    print(
        json.dumps(
            {
                "channel": log_channel,
                "mode": mode,
                "message": f"[{stamp}] Betrieb läuft im Modus {mode}.",
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    main()
