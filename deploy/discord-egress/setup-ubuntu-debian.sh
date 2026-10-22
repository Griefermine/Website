#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Bot-Hub Discord-Egress und Host-Firewall-Prüfung auf Ubuntu/Debian einrichten.

Aufruf:
  sudo ./deploy/discord-egress/setup-ubuntu-debian.sh [--enable] [--ssh-cidr CIDR] [--ssh-port PORT] [--hub-user USER] [--callback-host HOST[:PORT] ...]

Ohne --enable wird UFW niemals aktiviert. Bei einer bestehenden SSH-Sitzung
wird beim Aktivieren der aktuelle Client auf den lokalen SSH-Port begrenzt,
falls --ssh-cidr nicht angegeben ist.
EOF
}

ENABLE=0
SSH_CIDR=""
SSH_PORT=""
SSH_ALLOW_CIDR=""
SSH_ALLOW_PORT=""
HUB_USER="${SUDO_USER:-}"
CALLBACK_HOSTS=()
while (($#)); do
  case "$1" in
    --enable) ENABLE=1; shift ;;
    --ssh-cidr) (($# >= 2)) || { usage >&2; exit 2; }; SSH_CIDR="$2"; shift 2 ;;
    --ssh-port) (($# >= 2)) || { usage >&2; exit 2; }; SSH_PORT="$2"; shift 2 ;;
    --hub-user) (($# >= 2)) || { usage >&2; exit 2; }; HUB_USER="$2"; shift 2 ;;
    --callback-host)
      (($# >= 2)) || { usage >&2; exit 2; }
      CALLBACK_HOSTS+=("$2")
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Bitte mit sudo/root ausführen." >&2; exit 1; }
[[ -r /etc/os-release ]] || { echo "Ubuntu/Debian nicht erkannt." >&2; exit 1; }
# shellcheck disable=SC1091
source /etc/os-release
[[ ${ID:-} == ubuntu || ${ID:-} == debian || " ${ID_LIKE:-} " == *" debian "* ]] || {
  echo "Unterstützt werden Ubuntu und Debian." >&2; exit 1;
}

if ! command -v ufw >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ufw
fi
command -v python3 >/dev/null 2>&1 || { echo "python3 fehlt." >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker Engine fehlt; bitte zuerst Docker installieren." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 fehlt." >&2; exit 1; }
if [[ -n "$HUB_USER" ]]; then
  [[ "$HUB_USER" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || { echo "Ungültiger Hub-Benutzername." >&2; exit 2; }
  getent passwd "$HUB_USER" >/dev/null || { echo "Hub-Benutzer $HUB_USER existiert nicht." >&2; exit 2; }
  if [[ "$HUB_USER" != root ]]; then
    command -v visudo >/dev/null 2>&1 || { echo "visudo fehlt; sudoers-Regel kann nicht sicher geprüft werden." >&2; exit 1; }
  fi
fi

if [[ -n "$SSH_PORT" ]]; then
  if ! [[ "$SSH_PORT" =~ ^[0-9]{1,5}$ ]] || (( 10#$SSH_PORT < 1 || 10#$SSH_PORT > 65535 )); then
    echo "Ungültiger SSH-Port." >&2; exit 2
  fi
  SSH_PORT=$((10#$SSH_PORT))
fi
if [[ -n "$SSH_CIDR" ]]; then
  [[ -n "$SSH_PORT" ]] || SSH_PORT=22
  ufw allow in proto tcp from "$SSH_CIDR" to any port "$SSH_PORT" comment 'Bot-Hub SSH management'
  SSH_ALLOW_CIDR="$SSH_CIDR"
  SSH_ALLOW_PORT="$SSH_PORT"
elif [[ -n "${SSH_CONNECTION:-}" ]]; then
  read -r remote_ip _ local_ip local_port <<<"$SSH_CONNECTION"
  [[ -n "$SSH_PORT" ]] || SSH_PORT="$local_port"
  if [[ "$remote_ip" == *:* ]]; then remote_cidr="$remote_ip/128"; else remote_cidr="$remote_ip/32"; fi
  ufw allow in proto tcp from "$remote_cidr" to any port "$SSH_PORT" comment 'Bot-Hub current SSH client'
  SSH_ALLOW_CIDR="$remote_cidr"
  SSH_ALLOW_PORT="$SSH_PORT"
  echo "SSH-Freigabe nur für aktuelle Gegenstelle $remote_cidr, TCP/$SSH_PORT."
elif [[ -n "$SSH_PORT" ]]; then
  echo "Hinweis: --ssh-port öffnet SSH nicht ohne --ssh-cidr oder erkannte SSH-Sitzung." >&2
fi

for callback_host in "${CALLBACK_HOSTS[@]}"; do
  if ! [[ "$callback_host" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(:[0-9]{1,5})?$ ]]; then
    echo "Ungültiger Callback-Hostname (nur exakte DNS-Namen, keine IPs/Wildcards): $callback_host" >&2
    exit 2
  fi
  if [[ "$callback_host" == *:* ]]; then
    callback_port="${callback_host##*:}"
    if [[ "$callback_port" != 443 ]]; then
      echo "Externe HTTPS-Callbacks sind aus Sicherheitsgründen nur auf Port 443 erlaubt: $callback_host" >&2
      exit 2
    fi
  fi
done

# The callback file contains public hostnames only, no credentials. Squid and
# the Hub read the same source; host:port entries retain the Hub's exact policy.
install -d -o root -g root -m 0755 /etc/bot-hub
if [[ -n "$SSH_ALLOW_CIDR" ]]; then
  printf '%s %s\n' "$SSH_ALLOW_CIDR" "$SSH_ALLOW_PORT" >/etc/bot-hub/ssh-management.allow
else
  : >/etc/bot-hub/ssh-management.allow
fi
chmod 0644 /etc/bot-hub/ssh-management.allow
if ((${#CALLBACK_HOSTS[@]})); then
  callback_tmp=$(mktemp /etc/bot-hub/.callback-egress.allow.XXXXXX)
  printf '%s\n' "${CALLBACK_HOSTS[@],,}" | sort -u >"$callback_tmp"
  install -o root -g root -m 0644 "$callback_tmp" /etc/bot-hub/callback-egress.allow
  rm -f "$callback_tmp"
  domain_tmp=$(mktemp /etc/bot-hub/.callback-domains.txt.XXXXXX)
  awk -F: '{print $1}' /etc/bot-hub/callback-egress.allow | sort -u >"$domain_tmp"
  install -o root -g root -m 0644 "$domain_tmp" /etc/bot-hub/callback-domains.txt
  rm -f "$domain_tmp"
elif [[ ! -e /etc/bot-hub/callback-domains.txt ]]; then
  install -o root -g root -m 0644 /dev/null /etc/bot-hub/callback-domains.txt
  install -o root -g root -m 0644 /dev/null /etc/bot-hub/callback-egress.allow
fi

# Build before enforcing default-deny egress (fresh installations need the
# package mirrors). The final runtime build/pulls are then constrained below.
cd "$(dirname "$0")/../.."
docker compose -f deploy/discord-egress/compose.yaml build

# Package management and Docker image pulls use separate loopback-only Squid
# listeners with separate domain ACLs. Docker is deliberately restarted when
# egress policy changes; existing containers will be interrupted.
install -o root -g root -m 0755 "$(dirname "$0")/apply-docker-egress.py" /usr/local/sbin/bot-hub-docker-egress
APT_PROXY=/etc/apt/apt.conf.d/90bot-hub-egress
if [[ -e "$APT_PROXY" ]] && ! grep -Fq '# BOT-HUB MANAGED EGRESS PROXY' "$APT_PROXY"; then
  echo "$APT_PROXY existiert ohne Bot-Hub-Markierung; breche ohne Überschreiben ab." >&2
  exit 1
fi
cat >"$APT_PROXY" <<'EOF'
# BOT-HUB MANAGED EGRESS PROXY
Acquire::http::Proxy "http://127.0.0.1:3131";
Acquire::https::Proxy "http://127.0.0.1:3131";
EOF
chmod 0644 "$APT_PROXY"

DOCKER_DROPIN=/etc/systemd/system/docker.service.d/90-bot-hub-egress-proxy.conf
install -d -o root -g root -m 0755 "$(dirname "$DOCKER_DROPIN")"
if [[ -e "$DOCKER_DROPIN" ]] && ! grep -Fq '# BOT-HUB MANAGED EGRESS PROXY' "$DOCKER_DROPIN"; then
  echo "$DOCKER_DROPIN existiert ohne Bot-Hub-Markierung; breche ohne Überschreiben ab." >&2
  exit 1
fi
cat >"$DOCKER_DROPIN" <<'EOF'
# BOT-HUB MANAGED EGRESS PROXY
[Service]
Environment="HTTP_PROXY=http://127.0.0.1:3130"
Environment="HTTPS_PROXY=http://127.0.0.1:3130"
Environment="NO_PROXY=localhost,127.0.0.1,::1"
ExecStartPost=/usr/local/sbin/bot-hub-docker-egress
EOF
chmod 0644 "$DOCKER_DROPIN"

# Caddy renewals use the same narrow Hub/ACME proxy policy. Reverse-proxy
# upstream requests to loopback bypass it by NO_PROXY.
if systemctl list-unit-files caddy.service --no-legend 2>/dev/null | grep -q '^caddy.service'; then
  CADDY_DROPIN=/etc/systemd/system/caddy.service.d/90-bot-hub-egress-proxy.conf
  install -d -o root -g root -m 0755 "$(dirname "$CADDY_DROPIN")"
  if [[ -e "$CADDY_DROPIN" ]] && ! grep -Fq '# BOT-HUB MANAGED EGRESS PROXY' "$CADDY_DROPIN"; then
    echo "$CADDY_DROPIN existiert ohne Bot-Hub-Markierung; breche ohne Überschreiben ab." >&2
    exit 1
  fi
  cat >"$CADDY_DROPIN" <<'EOF'
# BOT-HUB MANAGED EGRESS PROXY
[Service]
Environment="HTTP_PROXY=http://127.0.0.1:3129"
Environment="HTTPS_PROXY=http://127.0.0.1:3129"
Environment="NO_PROXY=localhost,127.0.0.1,::1"
EOF
  chmod 0644 "$CADDY_DROPIN"
fi
systemctl daemon-reload
systemctl restart docker
docker info >/dev/null

# UFW's default deny applies only where no earlier explicit allow exists.
# Preserve user rules and make their review explicit before exposing the host.
ufw default deny incoming
ufw default deny outgoing
ufw allow in 80/tcp comment 'Bot-Hub HTTPS redirect and ACME'
ufw allow in 443/tcp comment 'Bot-Hub HTTPS reverse proxy'
python3 "$(dirname "$0")/update-ufw-rules.py"

# Install a root-owned, read-only checker. The Hub calls only this fixed
# command via sudo -n; it cannot pass arguments or run arbitrary root commands.
install -o root -g root -m 0755 "$(dirname "$0")/check-host-firewall.py" \
  /usr/local/sbin/bot-hub-host-firewall-check
if [[ -n "$HUB_USER" && "$HUB_USER" != root ]]; then
  SUDOERS_FILE=/etc/sudoers.d/bot-hub-host-firewall-check
  if [[ -e "$SUDOERS_FILE" ]] && ! grep -Fq '# BOT-HUB MANAGED HOST FIREWALL CHECK' "$SUDOERS_FILE"; then
    echo "$SUDOERS_FILE existiert und wird nicht von Bot-Hub verwaltet; breche ohne Überschreiben ab." >&2
    exit 1
  fi
  sudoers_tmp=$(mktemp /etc/sudoers.d/.bot-hub-host-firewall-check.XXXXXX)
  trap 'rm -f "$sudoers_tmp"' EXIT
  printf '# BOT-HUB MANAGED HOST FIREWALL CHECK\n%s ALL=(root) NOPASSWD: /usr/local/sbin/bot-hub-host-firewall-check\n' "$HUB_USER" >"$sudoers_tmp"
  chmod 0440 "$sudoers_tmp"
  visudo -cf "$sudoers_tmp"
  install -o root -g root -m 0440 "$sudoers_tmp" "$SUDOERS_FILE"
  rm -f "$sudoers_tmp"
  trap - EXIT
elif [[ -z "$HUB_USER" && $EUID -eq 0 ]]; then
  echo "Kein --hub-user angegeben: Der Hub kann den Root-Prüfer nur direkt als root ausführen." >&2
fi

if ! /usr/local/sbin/bot-hub-host-firewall-check --check-inbound-config; then
  echo "Entferne unerwartete UFW-ALLOW-IN-Regeln mit 'sudo ufw status numbered' und starte das Setup erneut." >&2
  exit 1
fi

if (( ENABLE )); then
  echo "Vorhandene UFW-Freigaben prüfen; aktiviert wird UFW jetzt." >&2
  ufw status numbered
  if ! ufw status | head -n 1 | grep -q 'Status: active'; then
    ufw --force enable
  else
    ufw reload
  fi
elif ufw status | head -n 1 | grep -q 'Status: active'; then
  ufw reload
else
  echo "UFW ist noch inaktiv. Regeln wurden vorbereitet, Firewall und Proxy bleiben aus."
  echo "Hinweis: Dockerd wurde neu gestartet und nutzt den gefilterten Registry-Proxy."
  echo "Prüfe SSH-Zugang und 'sudo ufw status numbered', dann erneut mit --enable starten."
  exit 0
fi

ensure_isolated_network() {
  local name="$1" bridge="$2" subnet="$3" gateway="$4"
  if docker network inspect "$name" >/dev/null 2>&1; then
    local actual
    actual=$(docker network inspect -f '{{.Internal}}|{{index .Options "com.docker.network.bridge.name"}}|{{index .Options "com.docker.network.bridge.enable_icc"}}|{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}' "$name")
    if [[ "$actual" != "true|$bridge|false|$subnet $gateway" ]]; then
      echo "Docker-Netz $name hat eine alte oder unsichere Konfiguration: $actual" >&2
      echo "Stoppe den Hub und die Bots, entferne die alten Bot-Container und das Netz, dann führe dieses Setup erneut aus." >&2
      return 1
    fi
    return 0
  fi
  docker network create --driver bridge --internal \
    --opt "com.docker.network.bridge.name=$bridge" \
    --opt com.docker.network.bridge.enable_icc=false \
    --subnet "$subnet" --gateway "$gateway" "$name" >/dev/null
}

ensure_isolated_network bot-hub-discord br-bothubdisc 172.30.250.0/24 172.30.250.1
ensure_isolated_network bot-hub-dependencies br-bothubdeps 172.30.251.0/24 172.30.251.1
docker compose -f deploy/discord-egress/compose.yaml up -d
/usr/local/sbin/bot-hub-docker-egress
DOCKER_EGRESS_UNIT=/etc/systemd/system/bot-hub-docker-egress.service
cat >"$DOCKER_EGRESS_UNIT" <<'EOF'
[Unit]
Description=Bot-Hub Docker bridge egress guard
After=docker.service ufw.service
Requires=docker.service ufw.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/bot-hub-docker-egress
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$DOCKER_EGRESS_UNIT"
systemctl daemon-reload
systemctl enable --now bot-hub-docker-egress.service
if ! /usr/local/sbin/bot-hub-host-firewall-check; then
  echo "Host-Firewall-Prüfung fehlgeschlagen; Produktionsbetrieb bleibt gesperrt." >&2
  exit 1
fi
if systemctl is-active --quiet caddy.service; then systemctl restart caddy.service; fi
if (( ENABLE )); then
  echo "Docker wurde beim Anwenden der Egress-Proxy-Konfiguration neu gestartet; Hub-Dienst anschließend neu starten."
fi
echo "UFW aktiv; Discord-Egress-Proxy wurde gestartet. Prüfung: sudo ./deploy/discord-egress/check-ubuntu-debian.sh"
