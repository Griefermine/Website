#!/usr/bin/env python3
"""Install the Bot-Hub host-input guard into UFW's before.rules."""

from __future__ import annotations

import datetime
import os
import pathlib
import pwd
import tempfile


PATHS = ((pathlib.Path("/etc/ufw/before.rules"), True), (pathlib.Path("/etc/ufw/before6.rules"), False))
BEGIN = "# BEGIN BOT-HUB DISCORD EGRESS"
END = "# END BOT-HUB DISCORD EGRESS"
BLOCK = [
    BEGIN,
    "# Permit only the private Bot API and filtered proxy from the bot bridge.",
    "-A ufw-before-input -i br-bothubdisc -d 172.30.250.1/32 -p tcp --dport 8788 -j ACCEPT",
    "-A ufw-before-input -i br-bothubdisc -d 172.30.250.1/32 -p tcp --dport 3128 -j ACCEPT",
    "-A ufw-before-input -i br-bothubdisc -j DROP",
    "# Temporary dependency runners may use only the filtered proxy.",
    "-A ufw-before-input -i br-bothubdeps -d 172.30.251.1/32 -p tcp --dport 3128 -j ACCEPT",
    "-A ufw-before-input -i br-bothubdeps -j DROP",
    "# Keep internal application/admin ports off every non-loopback interface.",
    "-A ufw-before-input ! -i lo -p tcp -m multiport --dports 8787,8788,3128,3129,3130,3131,5173,3306,3307,8081 -j DROP",
    END,
]
OUTPUT_BEGIN = "# BEGIN BOT-HUB EGRESS"
OUTPUT_END = "# END BOT-HUB EGRESS"


def output_block() -> list[str]:
    # Squid runs as the fixed unprivileged UID 13 in the pinned Debian image.
    # systemd-resolved is the only other process permitted to resolve names;
    # all other host egress is denied at the start of ufw-before-output.
    resolver_uid = None
    for name in ("systemd-resolve", "_systemd-resolve"):
        try:
            resolver_uid = pwd.getpwnam(name).pw_uid
            break
        except KeyError:
            continue
    lines = [
        OUTPUT_BEGIN,
        "-A ufw-before-output -o lo -j ACCEPT",
        "-A ufw-before-output -o br+ -p tcp -m multiport --dports 80,3306 -j ACCEPT",
        "-A ufw-before-output -m owner --uid-owner 13 -p udp --dport 53 -j ACCEPT",
        "-A ufw-before-output -m owner --uid-owner 13 -p tcp --dport 53 -j ACCEPT",
        "-A ufw-before-output -m owner --uid-owner 13 -p tcp --dport 443 -j ACCEPT",
    ]
    if resolver_uid is not None:
        lines.extend(
            [
                f"-A ufw-before-output -m owner --uid-owner {resolver_uid} -p udp --dport 53 -j ACCEPT",
                f"-A ufw-before-output -m owner --uid-owner {resolver_uid} -p tcp --dport 53 -j ACCEPT",
            ]
        )
    lines.extend(
        [
            "-A ufw-before-output -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
            "-A ufw-before-output -j DROP",
            OUTPUT_END,
        ]
    )
    return lines


def update_path(path: pathlib.Path, *, with_input: bool) -> pathlib.Path | None:
    original = path.read_text(encoding="utf-8")
    lines = original.splitlines()
    if with_input:
        if lines.count(BEGIN) > 1 or lines.count(END) > 1:
            raise SystemExit("Mehrere verwaltete UFW-Blöcke gefunden; breche ohne Änderung ab.")
        if (BEGIN in lines) != (END in lines):
            raise SystemExit("Unvollständiger verwalteter UFW-Block; breche ohne Änderung ab.")
        if BEGIN in lines:
            start, finish = lines.index(BEGIN), lines.index(END)
            if finish < start:
                raise SystemExit("UFW-Marker stehen in falscher Reihenfolge.")
            del lines[start : finish + 1]
    if lines.count(OUTPUT_BEGIN) > 1 or lines.count(OUTPUT_END) > 1:
        raise SystemExit("Mehrere verwaltete UFW-Egress-Blöcke gefunden.")
    if (OUTPUT_BEGIN in lines) != (OUTPUT_END in lines):
        raise SystemExit("Unvollständiger verwalteter UFW-Egress-Block.")
    if OUTPUT_BEGIN in lines:
        start, finish = lines.index(OUTPUT_BEGIN), lines.index(OUTPUT_END)
        if finish < start:
            raise SystemExit("UFW-Egress-Marker stehen in falscher Reihenfolge.")
        del lines[start : finish + 1]
    # Bridge protections must precede every user-supplied UFW allow rule.
    anchors = []
    if with_input:
        anchors.append((":ufw-before-input - [0:0]", BLOCK))
    anchors.append((":ufw-before-output - [0:0]", output_block()))
    for anchor, block in anchors:
        if lines.count(anchor) != 1:
            raise SystemExit(f"Erwartete UFW-Regel fehlt/ist mehrdeutig: {anchor}")
        lines[lines.index(anchor) + 1 : lines.index(anchor) + 1] = block
    updated = "\n".join(lines) + "\n"
    if updated == original:
        return None
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"{path.name}.bot-hub-{stamp}.bak")
    backup.write_text(original, encoding="utf-8")
    os.chmod(backup, 0o600)
    fd, temp_name = tempfile.mkstemp(prefix=f"{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(updated)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp_name, path.stat().st_mode & 0o777)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return backup


def main() -> None:
    if os.geteuid() != 0:
        raise SystemExit("Bitte mit sudo/root ausführen.")
    changed = []
    for path, with_input in PATHS:
        backup = update_path(path, with_input=with_input)
        if backup:
            changed.append(backup)
    for backup in changed:
        print(f"UFW-Regeln aktualisiert. Sicherung: {backup}")
    if not changed:
        print("UFW-Eingangs- und Ausgangsregeln sind bereits aktuell.")


if __name__ == "__main__":
    main()
