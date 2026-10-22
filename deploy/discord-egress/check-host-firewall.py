#!/usr/bin/python3
"""Verify that the live host firewall begins with the Bot-Hub bridge guard."""

from __future__ import annotations

import os
import ipaddress
import pathlib
import re
import shlex
import subprocess
import sys


EXPECTED_UFW_RULES = [
    ["-A", "ufw-before-input", "-i", "br-bothubdisc", "-d", "172.30.250.1/32", "-p", "tcp", "--dport", "8788", "-j", "ACCEPT"],
    ["-A", "ufw-before-input", "-i", "br-bothubdisc", "-d", "172.30.250.1/32", "-p", "tcp", "--dport", "3128", "-j", "ACCEPT"],
    ["-A", "ufw-before-input", "-i", "br-bothubdisc", "-j", "DROP"],
    ["-A", "ufw-before-input", "-i", "br-bothubdeps", "-d", "172.30.251.1/32", "-p", "tcp", "--dport", "3128", "-j", "ACCEPT"],
    ["-A", "ufw-before-input", "-i", "br-bothubdeps", "-j", "DROP"],
    ["-A", "ufw-before-input", "!", "-i", "lo", "-p", "tcp", "-m", "multiport", "--dports", "8787,8788,3128,3129,3130,3131,5173,3306,3307,8081", "-j", "DROP"],
]
EXPECTED_OUTPUT_PREFIX = [
    ["-A", "ufw-before-output", "-o", "lo", "-j", "ACCEPT"],
    ["-A", "ufw-before-output", "-o", "br+", "-p", "tcp", "-m", "multiport", "--dports", "80,3306", "-j", "ACCEPT"],
    ["-A", "ufw-before-output", "-m", "owner", "--uid-owner", "13", "-p", "udp", "--dport", "53", "-j", "ACCEPT"],
    ["-A", "ufw-before-output", "-m", "owner", "--uid-owner", "13", "-p", "tcp", "--dport", "53", "-j", "ACCEPT"],
    ["-A", "ufw-before-output", "-m", "owner", "--uid-owner", "13", "-p", "tcp", "--dport", "443", "-j", "ACCEPT"],
]
CHECK_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}


def run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args, check=False, capture_output=True, text=True, env=CHECK_ENV
    )


def configured_ssh_allow() -> tuple[str, str] | None:
    path = pathlib.Path("/etc/bot-hub/ssh-management.allow")
    if not path.exists():
        return None
    fields = path.read_text(encoding="utf-8").split()
    if len(fields) != 2:
        return None
    try:
        return str(ipaddress.ip_network(fields[0], strict=False)), str(int(fields[1]))
    except ValueError:
        return None


def check_configured_inbound() -> bool:
    expected_ssh = configured_ssh_allow()
    for path in (pathlib.Path("/etc/ufw/user.rules"), pathlib.Path("/etc/ufw/user6.rules")):
        if not path.exists():
            return False
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.startswith("-A ufw-user-input "):
                continue
            tokens = shlex.split(line)
            if "-j" not in tokens:
                return False
            jump = tokens[tokens.index("-j") + 1]
            if jump != "ACCEPT":
                continue
            proto = tokens[tokens.index("-p") + 1] if "-p" in tokens else "all"
            port = tokens[tokens.index("--dport") + 1] if "--dport" in tokens else ""
            source = tokens[tokens.index("-s") + 1] if "-s" in tokens else ""
            if proto == "tcp" and port in {"80", "443"}:
                continue
            if expected_ssh and proto == "tcp" and port == expected_ssh[1] and source:
                try:
                    if str(ipaddress.ip_network(source, strict=False)) == expected_ssh[0]:
                        continue
                except ValueError:
                    pass
            return False
    return True


def check_ufw() -> bool:
    status = run(["ufw", "status"])
    if status.returncode or not status.stdout.startswith("Status: active"):
        return False
    rules = run(["iptables", "-S", "ufw-before-input"])
    if rules.returncode:
        return False
    actual = [shlex.split(line) for line in rules.stdout.splitlines() if line.startswith("-A ufw-before-input ")]
    # iptables may print the implicit TCP match explicitly; normalize that
    # representation before comparing the exact top-of-chain sequence.
    actual = [
        [token for index, token in enumerate(rule) if not (token == "-m" and rule[index + 1 : index + 2] == ["tcp"]) and not (index > 0 and rule[index - 1] == "-m" and token == "tcp")]
        for rule in actual
    ]
    input_ok = actual[: len(EXPECTED_UFW_RULES)] == EXPECTED_UFW_RULES
    def output_guard(binary: str) -> bool:
        output = run([binary, "-S", "ufw-before-output"])
        if output.returncode:
            return False
        outgoing = [shlex.split(line) for line in output.stdout.splitlines() if line.startswith("-A ufw-before-output ")]
        outgoing = [
            [token for index, token in enumerate(rule) if not (token == "-m" and rule[index + 1 : index + 2] == ["tcp"]) and not (index > 0 and rule[index - 1] == "-m" and token == "tcp")]
            for rule in outgoing
        ]
        if outgoing[: len(EXPECTED_OUTPUT_PREFIX)] != EXPECTED_OUTPUT_PREFIX:
            return False
        tail = [
            ["-A", "ufw-before-output", "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"],
            ["-A", "ufw-before-output", "-j", "DROP"],
        ]
        return any(
            outgoing[index : index + len(tail)] == tail
            for index in range(len(EXPECTED_OUTPUT_PREFIX), len(outgoing) - len(tail) + 1)
        )

    output_ok = output_guard("iptables")
    defaults = pathlib.Path("/etc/default/ufw").read_text(encoding="utf-8")
    if re.search(r"^IPV6=yes\s*$", defaults, re.MULTILINE):
        output_ok = output_ok and output_guard("ip6tables")
    verbose = run(["ufw", "status", "verbose"])
    deny_default = "deny (incoming)" in verbose.stdout.lower() and "deny (outgoing)" in verbose.stdout.lower()
    numbered = run(["ufw", "status", "numbered"])
    inbound_ok = numbered.returncode == 0
    ssh_allow = pathlib.Path("/etc/bot-hub/ssh-management.allow")
    expected_ssh = configured_ssh_allow()
    if ssh_allow.exists() and expected_ssh is None:
        inbound_ok = False
    for line in numbered.stdout.splitlines():
        if "ALLOW IN" not in line:
            continue
        rule, source = line.split("ALLOW IN", 1)
        rule = re.sub(r"^\s*\[\s*\d+\s*\]\s*", "", rule).strip()
        rule = rule.removesuffix(" (v6)").strip()
        if rule in {"80/tcp", "443/tcp"}:
            continue
        # Permit exactly the SSH port/CIDR recorded by setup; an arbitrary
        # private-source allow is still outside the public Hub policy.
        if expected_ssh and rule == f"{expected_ssh[1]}/tcp" and expected_ssh[0] in source and "Anywhere" not in source:
            continue
        else:
            inbound_ok = False
            break
    docker_guard = run(["/usr/local/sbin/bot-hub-docker-egress", "--check"])
    docker_unit = run(["systemctl", "is-enabled", "--quiet", "bot-hub-docker-egress.service"])
    docker_proxy = run(["systemctl", "show", "docker.service", "-p", "Environment", "--value"])
    apt_proxy = pathlib.Path("/etc/apt/apt.conf.d/90bot-hub-egress")
    apt_text = apt_proxy.read_text(encoding="utf-8") if apt_proxy.exists() else ""
    proxy_process = run(["ss", "-H", "-lnt"])
    expected_local = {"127.0.0.1:3129", "127.0.0.1:3130", "127.0.0.1:3131"}
    listeners = {line.split()[3] for line in proxy_process.stdout.splitlines() if len(line.split()) >= 4}
    local_proxies = expected_local <= listeners and not any(
        local_port in address and address not in expected_local
        for local_port in (":3129", ":3130", ":3131")
        for address in listeners
    )
    return (
        input_ok
        and output_ok
        and deny_default
        and inbound_ok
        and docker_guard.returncode == 0
        and docker_unit.returncode == 0
        and "HTTPS_PROXY=http://127.0.0.1:3130" in docker_proxy.stdout
        and "http://127.0.0.1:3131" in apt_text
        and local_proxies
    )


def main() -> None:
    if len(sys.argv) != 1:
        if sys.argv[1:] == ["--check-inbound-config"] and os.geteuid() == 0:
            if check_configured_inbound():
                print("UFW-Regeldateien erlauben nur Hub-HTTPS und die konfigurierte SSH-Gegenstelle.")
                return
            print("FEHLER: UFW-Regeldateien enthalten weitere eingehende Freigaben.", file=sys.stderr)
            raise SystemExit(1)
        raise SystemExit("Erlaubt ist ausschließlich --check-inbound-config.")
    if os.geteuid() != 0:
        raise SystemExit("Host-Firewall-Prüfung benötigt root.")
    if check_ufw():
        print("Aktive UFW-Eingangs-, Ausgangs- und Docker-Forward-Regeln sind vorhanden.")
        return
    print(
        "FEHLER: Vollständige UFW-Ein-/Ausgangs- und Docker-Forward-Sperren fehlen.",
        file=sys.stderr,
    )
    raise SystemExit(1)


if __name__ == "__main__":
    main()
