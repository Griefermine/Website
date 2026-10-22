#!/usr/bin/env bash
set -uo pipefail

FAILED=0
check() {
  local label="$1"; shift
  if "$@"; then printf 'OK   %s\n' "$label"; else printf 'FEHLT %s\n' "$label"; FAILED=1; fi
}

if [[ $EUID -ne 0 ]]; then
  echo "Hinweis: sudo liefert vollständigen UFW-/Listener-Status."
fi
command -v ufw >/dev/null 2>&1 || { echo "UFW ist nicht installiert."; exit 1; }
ufw status verbose
echo
check "UFW aktiv" bash -c "ufw status | head -n 1 | grep -q 'Status: active'"
check "Aktive Bot-Hub-Hostfilter-Regeln" /usr/local/sbin/bot-hub-host-firewall-check
check "UFW Bot-Hub-Regelblock vorhanden" grep -Fq '# BEGIN BOT-HUB DISCORD EGRESS' /etc/ufw/before.rules
check "Host-API-Port 8788 nur über Bot-Bridge erlaubt" grep -Fq -- '-A ufw-before-input -i br-bothubdisc -d 172.30.250.1/32 -p tcp --dport 8788 -j ACCEPT' /etc/ufw/before.rules
check "Bot-Proxy nur auf privatem Gateway erlaubt" grep -Fq -- '-A ufw-before-input -i br-bothubdisc -d 172.30.250.1/32 -p tcp --dport 3128 -j ACCEPT' /etc/ufw/before.rules
check "Installer-Proxy nur auf privatem Gateway erlaubt" grep -Fq -- '-A ufw-before-input -i br-bothubdeps -d 172.30.251.1/32 -p tcp --dport 3128 -j ACCEPT' /etc/ufw/before.rules
check "Paketnetz nach Proxy-Freigabe gegen Hostzugriff gesperrt" grep -Fq -- '-A ufw-before-input -i br-bothubdeps -j DROP' /etc/ufw/before.rules

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  check "Discord-Proxy läuft" bash -c "docker inspect -f '{{.State.Running}}' bot-hub-discord-egress 2>/dev/null | grep -qx true"
  check "Proxy-Filterversion und UID stimmen" bash -c "docker inspect -f '{{index .Config.Labels \"bot-hub.discord-egress\"}} {{.Config.User}}' bot-hub-discord-egress 2>/dev/null | grep -qx 'filtered-egress-v5 13:13'"
  check "Proxy nutzt Host-Netz für private Gateway-Listener" bash -c "docker inspect -f '{{.HostConfig.NetworkMode}}' bot-hub-discord-egress 2>/dev/null | grep -qx host"
  check "Bot-Netz intern und Peer-Isolation aktiv" bash -c "docker network inspect -f '{{.Internal}}|{{index .Options \"com.docker.network.bridge.enable_icc\"}}' bot-hub-discord 2>/dev/null | grep -qx 'true|false'"
  check "Bot-Netz Gateway stimmt" bash -c "docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' bot-hub-discord 2>/dev/null | grep -qx 172.30.250.1"
  check "Bot-Peer-Isolation aktiv" bash -c "docker network inspect -f '{{index .Options \"com.docker.network.bridge.enable_icc\"}}' bot-hub-discord 2>/dev/null | grep -qx false"
  check "Paketnetz intern und Peer-Isolation aktiv" bash -c "docker network inspect -f '{{.Internal}}|{{index .Options \"com.docker.network.bridge.enable_icc\"}}' bot-hub-dependencies 2>/dev/null | grep -qx 'true|false'"
  check "Paketnetz Gateway stimmt" bash -c "docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' bot-hub-dependencies 2>/dev/null | grep -qx 172.30.251.1"
  check "Installer-Peer-Isolation aktiv" bash -c "docker network inspect -f '{{index .Options \"com.docker.network.bridge.enable_icc\"}}' bot-hub-dependencies 2>/dev/null | grep -qx false"
  check "Proxy ohne veröffentlichte Ports" bash -c "docker inspect -f '{{json .HostConfig.PortBindings}}' bot-hub-discord-egress 2>/dev/null | grep -Eq '^(null|\\{\\})$'"
  check "Docker-Daemon verwendet gefilterten Registry-Proxy" bash -c "systemctl show docker.service -p Environment --value | grep -Fq 'HTTPS_PROXY=http://127.0.0.1:3130'"
  check "APT verwendet gefilterten Paket-Proxy" grep -Fq 'http://127.0.0.1:3131' /etc/apt/apt.conf.d/90bot-hub-egress
  check "Docker-Forward-Egress-Sperre aktiv" /usr/local/sbin/bot-hub-docker-egress --check
  check "Docker-Forward-Egress-Sperre beim Boot aktiviert" systemctl is-enabled --quiet bot-hub-docker-egress.service
else
  echo "FEHLT Docker Engine/Compose v2"; FAILED=1
fi

if command -v ss >/dev/null 2>&1; then
  echo
  echo "TCP-Listener (zur Sichtprüfung; erwartet öffentlich nur Reverse-Proxy 80/443):"
  ss -lntp
fi
echo
echo "UFW-Regeln (bestehende zusätzliche Freigaben manuell prüfen):"
ufw status numbered
exit "$FAILED"
