#!/usr/bin/env python3
"""Block new bridge-container connections leaving Docker bridge networks."""

from __future__ import annotations

import os
import subprocess
import sys


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
    run([binary, "-A", CHAIN, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "RETURN"])
    run([binary, "-A", CHAIN, "-i", "docker0", "!", "-o", "docker0", "!", "-o", "br+", "-j", "DROP"])
    run([binary, "-A", CHAIN, "-i", "br+", "!", "-o", "docker0", "!", "-o", "br+", "-j", "DROP"])
    # Docker publishes ports before UFW's INPUT rules see them. Deny new
    # forwarded connections from non-bridge interfaces to every bridge.
    run([binary, "-A", CHAIN, "!", "-i", "docker0", "!", "-i", "br+", "-o", "docker0", "-m", "conntrack", "--ctstate", "NEW", "-j", "DROP"])
    run([binary, "-A", CHAIN, "!", "-i", "docker0", "!", "-i", "br+", "-o", "br+", "-m", "conntrack", "--ctstate", "NEW", "-j", "DROP"])
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
    expected = [
        f"-A {CHAIN} -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN",
        f"-A {CHAIN} -i docker0 ! -o docker0 ! -o br+ -j DROP",
        f"-A {CHAIN} -i br+ ! -o docker0 ! -o br+ -j DROP",
        f"-A {CHAIN} ! -i docker0 ! -i br+ -o docker0 -m conntrack --ctstate NEW -j DROP",
        f"-A {CHAIN} ! -i docker0 ! -i br+ -o br+ -m conntrack --ctstate NEW -j DROP",
        f"-A {CHAIN} -j RETURN",
    ]
    return chain.stdout.splitlines() == expected and run(
        [binary, "-C", "DOCKER-USER", "-j", CHAIN], check=False
    ).returncode == 0


def main() -> None:
    if sys.argv[1:] not in ([], ["--check"]):
        raise SystemExit("Erlaubt ist ausschließlich --check.")
    if os.geteuid() != 0:
        raise SystemExit("Bitte mit sudo/root ausführen.")
    docker_ipv6 = run(["docker", "info", "--format", "{{.IPv6}}"], check=False)
    if docker_ipv6.returncode or docker_ipv6.stdout.strip() not in {"true", "false"}:
        raise RuntimeError("Docker-IPv6-Status lässt sich nicht sicher bestimmen.")
    require_ipv6_chain = docker_ipv6.stdout.strip() == "true"
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
