"""Aktion "Rollen synchronisieren" – vom Hub als Skript ausgeführt.

Der Hub ruft `/api/bots/<id>/panel/commands/sync` auf, startet dann diese Datei
im Arbeitsordner des Bots und erwartet JSON auf stdout. Die Einstellungen aus
dem Dashboard stehen als `BOT_HUB_SETTINGS` und `BOT_HUB_SETTING_*` bereit.
"""

import json
import os
import sys

PERMISSIONS = [
    "administrator",
    "manage_roles",
    "manage_channels",
    "manage_messages",
    "view_channel",
    "attach_files",
    "embed_links",
    "mention_everyone",
    "manage_webhooks",
]


def main() -> int:
    template = [
        line.strip()
        for line in os.environ.get("BOT_HUB_SETTING_ROLE_TEMPLATE", "").splitlines()
        if line.strip()
    ]
    missing = [item for item in template if item not in PERMISSIONS]
    mode = os.environ.get("BOT_HUB_SETTING_MODE", "unknown")

    print(
        json.dumps(
            {
                "mode": mode,
                "cooldown": os.environ.get("BOT_HUB_SETTING_COOLDOWN"),
                "auto_role": os.environ.get("BOT_HUB_SETTING_AUTO_ROLE"),
                "log_channel": os.environ.get("BOT_HUB_SETTING_LOG_CHANNEL"),
                "template": template,
                "missing": missing,
                "message": (
                    "Vorlage ist gültig"
                    if not missing
                    else f"Unbekannte Berechtigungen: {', '.join(missing)}"
                ),
                "settings_json": json.loads(os.environ.get("BOT_HUB_SETTINGS", "{}")),
            },
            ensure_ascii=False,
        )
    )
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
