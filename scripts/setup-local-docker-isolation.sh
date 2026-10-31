#!/usr/bin/env bash
set -Eeuo pipefail

NETWORK="bot-hub-local"
BRIDGE="br-bothublocal"
HELPER="/usr/local/sbin/bot-hub-local-firewall"
SUDOERS_FILE="/etc/sudoers.d/bot-hub-local-firewall"
SYSTEMD_DIR="/etc/systemd/system/docker.service.d"
SYSTEMD_DROPIN="$SYSTEMD_DIR/20-bot-hub-local-firewall.conf"

die() {
  printf '[bot-hub-local-setup] ERROR: %s\n' "$1" >&2
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  die "Bitte mit sudo ausführen: sudo BOT_HUB_USER=<Hub-Benutzer> bash scripts/setup-local-docker-isolation.sh"
fi

TARGET_USER="$(printenv BOT_HUB_USER || true)"
if [ -z "$TARGET_USER" ]; then
  TARGET_USER="$(printenv SUDO_USER || true)"
fi
[ -n "$TARGET_USER" ] || die "BOT_HUB_USER fehlt. Gib den Linux-Benutzer an, unter dem der Hub läuft."
id "$TARGET_USER" >/dev/null 2>&1 || die "Hub-Benutzer $TARGET_USER existiert nicht."
case "$TARGET_USER" in
  *[!a-zA-Z0-9_.-]*|'') die "Ungültiger Benutzername." ;;
esac

for command_name in docker iptables ip python3 sysctl systemctl visudo install; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name fehlt."
done

systemctl is-active --quiet docker.service ||
  die "docker.service läuft nicht. Nur native Docker Engine mit systemd wird unterstützt."
iptables -w -nL DOCKER-USER >/dev/null 2>&1 ||
  die "DOCKER-USER fehlt. Das Docker-iptables-Backend muss aktiviert sein; nftables-Backend und Rootless Docker werden noch nicht unterstützt."

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_HELPER="$SCRIPT_DIR/local-docker-firewall.sh"
[ -f "$SOURCE_HELPER" ] || die "local-docker-firewall.sh fehlt neben diesem Setup-Skript."

if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  printf '[bot-hub-local-setup] Erstelle isoliertes Docker-Netz %s ...\n' "$NETWORK"
  docker network create \
    --driver bridge \
    --opt "com.docker.network.bridge.name=$BRIDGE" \
    --opt com.docker.network.bridge.enable_icc=false \
    --opt com.docker.network.bridge.enable_ip_masquerade=true \
    --ipv6=false \
    "$NETWORK" >/dev/null
fi

install -o root -g root -m 0755 "$SOURCE_HELPER" "$HELPER"
"$HELPER" validate

# Bereits vorhandene Bot-Container hängen möglicherweise noch am alten
# Standardnetz. Sie werden nur nach ausdrücklicher Bestätigung entfernt;
# Workspace-Dateien und Hub-Daten liegen außerhalb dieser Container.
if [ "${1:-}" = "--migrate" ]; then
  STALE=()
  while IFS= read -r container_id; do
    [ -n "$container_id" ] || continue
    mode="$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container_id")"
    if [ "$mode" != "$NETWORK" ]; then
      STALE+=("$container_id")
    fi
  done < <(docker ps -aq --filter label=bot-hub.config)
  if [ "${#STALE[@]}" -gt 0 ]; then
    printf '[bot-hub-local-setup] Folgende alte Bot-Container werden entfernt: %s\n' "${STALE[*]}"
    printf 'Es werden keine Workspace- oder data/-Dateien gelöscht. Hub vorher vollständig stoppen.\n'
    [ -t 0 ] || die "Nicht-interaktiv: stoppe den Hub und entferne diese Container manuell oder starte das Setup interaktiv mit --migrate."
    read -r -p 'Fortfahren und nur diese Container entfernen? [y/N] ' answer
    case "$answer" in
      y|Y|yes|YES) docker rm -f "${STALE[@]}" >/dev/null ;;
      *) die "Migration abgebrochen." ;;
    esac
  fi
fi

"$HELPER" apply
"$HELPER" check

install -d -o root -g root -m 0755 "$SYSTEMD_DIR"
cat > "$SYSTEMD_DROPIN" <<'EOF'
[Service]
# Docker recreates its firewall chains at daemon start. Re-apply the
# Bot-Hub-owned policy after Docker initializes them; failure is also checked
# by Bot-Hub itself before any bot container can start.
ExecStartPost=/usr/local/sbin/bot-hub-local-firewall apply
EOF
chmod 0644 "$SYSTEMD_DROPIN"

printf '%s ALL=(root) NOPASSWD: %s apply, %s check\n' "$TARGET_USER" "$HELPER" "$HELPER" > "$SUDOERS_FILE"
chmod 0440 "$SUDOERS_FILE"
visudo -cf "$SUDOERS_FILE" >/dev/null || die "Sudoers-Regel ist ungültig."
systemctl daemon-reload

printf '\n[bot-hub-local-setup] Einrichtung abgeschlossen.\n'
printf 'Hub-Benutzer: %s\n' "$TARGET_USER"
printf 'Docker-Netz:  %s\n' "$NETWORK"
printf 'Bridge:       %s\n' "$BRIDGE"
printf 'Firewall:     geprüft und aktiv\n'
printf '\nStarte den Hub danach als %s neu. Bei einem Docker-Neustart wird die\n' "$TARGET_USER"
printf 'Firewall über den systemd-Drop-in erneut eingerichtet.\n'
printf 'Mehr Details: documents/lokale-docker-netzwerkisolation.md\n'
