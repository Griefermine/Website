#!/usr/bin/env python3
"""Block new bridge-container connections leaving Docker bridge networks."""

from __future__ import annotations

import os
import subprocess
import sys
import time


CHAIN = "BOT-HUB-DOCKER-EGRESS"


def run(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, text=True, capture_output=True, check=False)
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or f"Befehl fehlgeschlagen: {args[0]}")
    return result


def install_family(binary: str, *, optional: bool) -> None:
    if subprocess.run([binary, "-S", "DOCKER-USER"], capture_output=True).returncode:
        if optional:
            return
        raise RuntimeError(f"{binary}: Docker-USER-Kette fehlt.")
    run([binary, "-N", CHAIN], check=False)
    run([binary, "-F", CHAIN])
    # Aufgeteilt, nicht `! -o docker0 ! -o br+`: der iptables-nft-Backend
    # (Ubuntu 22.04+) lehnt wiederholte -o/-i-Flags ab ("multiple -o flags
    # not allowed"). Einzel-Regeln ergeben dieselbe Filter-Semantik.
    run([binary, "-A", CHAIN, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "RETURN"])
    run([binary, "-A", CHAIN, "-i", "docker0", "-o", "docker0", "-j", "RETURN"])
    run([binary, "-A", CHAIN, "-i", "docker0", "-o", "br+", "-j", "RETURN"])
    run([binary, "-A", CHAIN, "-i", "docker0", "-j", "DROP"])
    run([binary, "-A", CHAIN, "-i", "br+", "-o", "docker0", "-j", "RETURN"])
    # Audit SEC-05 (Maßnahme 40): ein pauschales `br+ -> br+ RETURN` ließ
    # Bot-Container quer über Brücken laufen – z. B. direkt zum MySQL-Container
    # im Pflege-Netz, vollständig an Squid und Hub-API vorbei. Gleichnetz-/
    # Gateway-Verkehre (Bot -> Squid 172.30.x.1, Bot -> Hub 8788) betreffen
    # diese Kette gar nicht: Ziel-IP ist der Host selbst (INPUT) bzw. derselbe
    # Bridge-Port (L2-Switching, kein FORWARD). Also: kein RETURN für br+ ->
    # br+, es fällt auf das DROP darunter.
    run([binary, "-A", CHAIN, "-i", "br+", "-j", "DROP"])
    # Ab hier kann die Eingabe weder docker0 noch br+ sein – die vorherigen
    # Regeln haben beide vollständig abgearbeitet. Das entspricht dem
    # ursprünglichen `! -i docker0 ! -i br+`.
    # Docker publishes ports before UFW's INPUT rules see them. Deny new
    # forwarded connections from non-bridge interfaces to every bridge.
    run([binary, "-A", CHAIN, "-o", "docker0", "-m", "conntrack", "--ctstate", "NEW", "-j", "DROP"])
    run([binary, "-A", CHAIN, "-o", "br+", "-m", "conntrack", "--ctstate", "NEW", "-j", "DROP"])
    run([binary, "-A", CHAIN, "-j", "RETURN"])
    while run([binary, "-D", "DOCKER-USER", "-j", CHAIN], check=False).returncode == 0:
        pass
    run([binary, "-I", "DOCKER-USER", "1", "-j", CHAIN])


def check_family(binary: str, *, optional: bool) -> bool:
    if subprocess.run([binary, "-S", "DOCKER-USER"], capture_output=True).returncode:
        return optional
    chain = run([binary, "-S", CHAIN], check=False)
    if chain.returncode:
        return False
    # `iptables -S <chain>` beginnt mit der `-N`-Deklaration – die gehört
    # nicht zur Regelmenge und würde den exakten Vergleich sonst immer
    # fehlschlagen lassen.
    rules = [line for line in chain.stdout.splitlines() if not line.startswith("-N ")]
    expected = [
        f"-A {CHAIN} -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN",
        f"-A {CHAIN} -i docker0 -o docker0 -j RETURN",
        f"-A {CHAIN} -i docker0 -o br+ -j RETURN",
        f"-A {CHAIN} -i docker0 -j DROP",
        f"-A {CHAIN} -i br+ -o docker0 -j RETURN",
        f"-A {CHAIN} -i br+ -j DROP",
        f"-A {CHAIN} -o docker0 -m conntrack --ctstate NEW -j DROP",
        f"-A {CHAIN} -o br+ -m conntrack --ctstate NEW -j DROP",
        f"-A {CHAIN} -j RETURN",
    ]
    return rules == expected and run(
        [binary, "-C", "DOCKER-USER", "-j", CHAIN], check=False
    ).returncode == 0


def detect_ipv6() -> str | None:
    """Ermittelt den IPv6-Status des Docker-Daemons als 'true'/'false' oder None.

    Der Daemon ist beim Aufruf als ExecStartPost oft noch nicht bereit, und
    ab Docker 25 fehlt das Info-Feld `.IPv6`. Deshalb zuerst der belastbare
    Bridge-Scope, dann das alte `docker info` als Fallback; sonst None.
    """
    result = run(
        ["docker", "network", "inspect", "bridge", "--format", "{{.EnableIPv6}}"],
        check=False,
    )
    value = result.stdout.strip().lower()
    if value in {"true", "false"}:
        return value
    result = run(["docker", "info", "--format", "{{.IPv6}}"], check=False)
    value = result.stdout.strip().lower()
    if value in {"true", "false"}:
        return value
    return None


def main() -> None:
    if sys.argv[1:] not in ([], ["--check"]):
        raise SystemExit("Erlaubt ist ausschließlich --check.")
    if os.geteuid() != 0:
        raise SystemExit("Bitte mit sudo/root ausführen.")
    # Als systemd ExecStartPost läuft dieses Skript, während dockerd gerade
    # erst hochfährt (Type=simple -> sofort). Ohne Warten schlägt die Abfrage
    # ins Leere und die Fail-Safe-Prüfung bricht den Docker-Start ab.
    # Ab Docker 25/29 existiert das Info-Feld `.IPv6` nicht mehr – zuerst wird
    # deshalb der Bridge-Scope gelesen, das alte `docker info` bleibt Fallback.
    docker_ipv6_state = None
    deadline = time.monotonic() + 60
    while True:
        docker_ipv6_state = detect_ipv6()
        if docker_ipv6_state is not None:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("Docker-IPv6-Status lässt sich nicht sicher bestimmen.")
        time.sleep(1)
    require_ipv6_chain = docker_ipv6_state == "true"
    checking = sys.argv[1:] == ["--check"]
    if checking:
        valid = check_family("iptables", optional=False)
        if os.path.exists("/proc/net/if_inet6"):
            valid = valid and check_family("ip6tables", optional=not require_ipv6_chain)
        if not valid:
            raise RuntimeError("Docker-Egress-Regeln fehlen oder sind veraltet.")
    else:
        install_family("iptables", optional=False)
        if os.path.exists("/proc/net/if_inet6"):
            install_family("ip6tables", optional=not require_ipv6_chain)
    print("Docker-Bridge-Egress ist für neue Verbindungen gesperrt.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError) as error:
        print(f"FEHLER: {error}", file=sys.stderr)
        raise SystemExit(1) from error
