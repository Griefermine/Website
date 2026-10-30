#!/usr/bin/env bash
set -Eeuo pipefail

# Lokales Bothub-Netz: nur Docker Engine auf nativem Linux mit dem
# iptables-/DOCKER-USER-Backend. Dieses Skript überschreibt keine von Docker
# verwalteten Chains; es hängt eigene Chains an INPUT und DOCKER-USER.
readonly NETWORK="bot-hub-local"
readonly PROFILE_LABEL="com.bothub.security-profile"
readonly PROFILE_VERSION="local-v1"
readonly INPUT_CHAIN="BOTHUB_LOCAL_INPUT"
readonly FORWARD_CHAIN="BOTHUB_LOCAL_FORWARD"
readonly INSTALL_PATH="/usr/local/sbin/bot-hub-local-network-firewall"
readonly UNIT_PATH="/etc/systemd/system/bot-hub-local-network-firewall.service"

ACTION="${1:-install}"
NETWORK_ID=""
DRIVER=""
INTERNAL=""
IPV6=""
ICC=""
MASQUERADE=""
SUBNET=""
GATEWAY=""
BRIDGE=""
LABEL=""
BLOCKED_CIDRS=()

fail() {
  printf '[bothub-local-network] FEHLER: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '[bothub-local-network] %s\n' "$*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "Benötigtes Programm fehlt: $1"
}

network_exists() {
  docker network inspect "$NETWORK" >/dev/null 2>&1
}

create_network() {
  if network_exists; then
    note "Docker-Netz $NETWORK ist bereits vorhanden; es wird nicht automatisch verändert."
    return
  fi
  note "Erstelle $NETWORK mit dynamischem Docker-Subnetz."
  docker network create \
    --driver bridge \
    --label "$PROFILE_LABEL=$PROFILE_VERSION" \
    --opt com.docker.network.bridge.enable_icc=false \
    --opt com.docker.network.bridge.enable_ip_masquerade=true \
    --ipv6=false \
    "$NETWORK" >/dev/null
}

read_network() {
  local record
  network_exists || fail "Docker-Netz $NETWORK fehlt."
  record="$(docker network inspect --format '{{.Id}}|{{.Driver}}|{{.Internal}}|{{.EnableIPv6}}|{{index .Options "com.docker.network.bridge.enable_icc"}}|{{index .Options "com.docker.network.bridge.enable_ip_masquerade"}}|{{range .IPAM.Config}}{{.Subnet}}|{{.Gateway}}{{end}}|{{index .Options "com.docker.network.bridge.name"}}|{{index .Labels "com.bothub.security-profile"}}' "$NETWORK")" ||
    fail "Docker-Netzwerk konnte nicht gelesen werden."
  IFS='|' read -r NETWORK_ID DRIVER INTERNAL IPV6 ICC MASQUERADE SUBNET GATEWAY BRIDGE LABEL <<<"$record"

  [[ "$DRIVER" == "bridge" ]] || fail "Netzwerk-Driver ist nicht bridge."
  [[ "$INTERNAL" == "false" ]] || fail "Netzwerk ist intern; der öffentliche Internetzugriff wäre blockiert."
  [[ "$IPV6" == "false" ]] || fail "IPv6 muss für dieses erste lokale Profil deaktiviert sein."
  [[ "$ICC" == "false" ]] || fail "Docker Inter-Container Communication ist nicht deaktiviert."
  [[ "$MASQUERADE" == "true" ]] || fail "IP-Masquerading muss für ausgehenden Internetzugriff aktiviert sein."
  [[ "$LABEL" == "$PROFILE_VERSION" ]] || fail "Netzwerk trägt nicht das erwartete Bothub-Sicherheitslabel."
  [[ "$NETWORK_ID" =~ ^[a-f0-9]{64}$ ]] || fail "Docker-Netzwerk-ID ist ungültig."
  [[ "$SUBNET" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([1-9]|[12][0-9]|30)$ ]] || fail "IPv4-Subnetz fehlt oder ist ungültig."
  [[ "$GATEWAY" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail "IPv4-Gateway fehlt oder ist ungültig."

  if [[ -z "$BRIDGE" || "$BRIDGE" == "<no value>" ]]; then
    BRIDGE="br-${NETWORK_ID:0:12}"
  fi
  [[ "$BRIDGE" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || fail "Bridge-Interface ist ungültig."
  ip link show dev "$BRIDGE" >/dev/null 2>&1 || fail "Bridge-Interface $BRIDGE ist nicht aktiv."
}

collect_blocked_cidrs() {
  local -a fixed=(
    "0.0.0.0/8"
    "10.0.0.0/8"
    "100.64.0.0/10"
    "127.0.0.0/8"
    "169.254.0.0/16"
    "172.16.0.0/12"
    "192.0.0.0/24"
    "192.0.2.0/24"
    "192.88.99.0/24"
    "192.168.0.0/16"
    "198.18.0.0/15"
    "198.51.100.0/24"
    "203.0.113.0/24"
    "224.0.0.0/4"
    "240.0.0.0/4"
    "255.255.255.255/32"
  )
  local routed
  local addressed
  mapfile -t BLOCKED_CIDRS < <(
    {
      printf '%s\n' "${fixed[@]}"
      # Alle aktuell gerouteten Nicht-Default-Netze sperren (LAN, VPN,
      # weitere Docker-Bridges und zusätzliche Host-Netze). Die Liste wird
      # bei jedem Setup und beim Boot neu ermittelt.
      ip -4 route show table main |
        awk '$1 != "default" && $1 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(\/[0-9]+)?$/ { print $1 }'
      # Auch lokale Host-Adressen werden explizit gesperrt, falls sie nicht
      # durch eine eigene Route abgebildet sind.
      ip -o -4 addr show |
        awk '{ for (i = 1; i <= NF; i++) if ($i == "inet") print $(i + 1) }'
    } | sort -u
  )
  [[ "${#BLOCKED_CIDRS[@]}" -gt 0 ]] || fail "Die Liste lokaler IPv4-Netze konnte nicht ermittelt werden."
  for routed in "${BLOCKED_CIDRS[@]}"; do
    [[ "$routed" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$ ]] ||
      fail "Ungültiges lokales Routenziel: $routed"
  done
  addressed="$GATEWAY/32"
  BLOCKED_CIDRS+=("$addressed")
  mapfile -t BLOCKED_CIDRS < <(printf '%s\n' "${BLOCKED_CIDRS[@]}" | sort -u)
}

ensure_chain() {
  local chain="$1"
  if ! iptables -nL "$chain" >/dev/null 2>&1; then
    iptables -N "$chain" || fail "iptables-Chain $chain konnte nicht erstellt werden."
  fi
  iptables -F "$chain" || fail "iptables-Chain $chain konnte nicht geleert werden."
}

install_jump_first() {
  local base="$1"
  local chain="$2"
  while iptables -C "$base" -j "$chain" >/dev/null 2>&1; do
    iptables -D "$base" -j "$chain" || fail "Doppelter Firewall-Verweis auf $chain konnte nicht entfernt werden."
  done
  iptables -I "$base" 1 -j "$chain" || fail "Firewall-Verweis $base -> $chain konnte nicht installiert werden."
}

apply_firewall() {
  need iptables
  iptables -nL DOCKER-USER >/dev/null 2>&1 ||
    fail "Docker-Chain DOCKER-USER fehlt. Dieses Profil benötigt Docker mit iptables-/DOCKER-USER-Backend."

  ensure_chain "$INPUT_CHAIN"
  ensure_chain "$FORWARD_CHAIN"

  # Hostzugriffe aus dem Bot-Netz: ausschließlich TCP zum internen Hub-API-
  # Listener am Gateway. Alle anderen Hostdienste werden blockiert.
  iptables -A "$INPUT_CHAIN" -i "$BRIDGE" -s "$SUBNET" -d "$GATEWAY/32" \
    -p tcp --dport 8788 -j ACCEPT
  iptables -A "$INPUT_CHAIN" -i "$BRIDGE" -s "$SUBNET" -j DROP
  iptables -A "$INPUT_CHAIN" -j RETURN

  # Weiterleitung: private, lokale, geroutete und reservierte Ziele blockieren.
  # Andere öffentliche Ziele bleiben für Bots und Paketinstallationen erreichbar.
  local cidr
  for cidr in "${BLOCKED_CIDRS[@]}"; do
    iptables -A "$FORWARD_CHAIN" -i "$BRIDGE" -s "$SUBNET" -d "$cidr" -j DROP
  done
  iptables -A "$FORWARD_CHAIN" -i "$BRIDGE" -s "$SUBNET" -j RETURN
  iptables -A "$FORWARD_CHAIN" -j RETURN

  install_jump_first INPUT "$INPUT_CHAIN"
  install_jump_first DOCKER-USER "$FORWARD_CHAIN"
}

check_firewall() {
  local -a input_rules=()
  local -a forward_rules=()
  local cidr
  local expected_forward_count=$(("${#BLOCKED_CIDRS[@]}" + 2))

  iptables -nL "$INPUT_CHAIN" >/dev/null 2>&1 || fail "Host-Firewall-Chain $INPUT_CHAIN fehlt."
  iptables -nL "$FORWARD_CHAIN" >/dev/null 2>&1 || fail "Forwarding-Firewall-Chain $FORWARD_CHAIN fehlt."
  mapfile -t input_rules < <(iptables -S "$INPUT_CHAIN" | awk '$1 == "-A"')
  mapfile -t forward_rules < <(iptables -S "$FORWARD_CHAIN" | awk '$1 == "-A"')

  [[ "${#input_rules[@]}" -eq 3 ]] || fail "Host-Firewall-Chain hat unerwartete Regeln."
  [[ "${input_rules[0]}" == *"--dport 8788"* && "${input_rules[0]}" == *"-j ACCEPT"* ]] ||
    fail "Interner API-Port 8788 ist nicht die einzige Host-Ausnahme."
  [[ "${input_rules[1]}" == *"-j DROP"* ]] || fail "Hostzugriffe aus dem Bot-Netz werden nicht vollständig verworfen."
  [[ "${input_rules[2]}" == *"-j RETURN"* ]] || fail "Host-Firewall-Chain endet nicht mit RETURN."
  iptables -C "$INPUT_CHAIN" -i "$BRIDGE" -s "$SUBNET" -d "$GATEWAY/32" \
    -p tcp --dport 8788 -j ACCEPT >/dev/null 2>&1 ||
    fail "Die Freigabe für die interne Bot-API fehlt."
  iptables -C "$INPUT_CHAIN" -i "$BRIDGE" -s "$SUBNET" -j DROP >/dev/null 2>&1 ||
    fail "Der Hostzugriff vom Bot-Netz ist nicht gesperrt."

  [[ "${#forward_rules[@]}" -eq "$expected_forward_count" ]] ||
    fail "Forwarding-Firewall-Chain enthält unerwartete oder fehlende Regeln."
  for cidr in "${BLOCKED_CIDRS[@]}"; do
    iptables -C "$FORWARD_CHAIN" -i "$BRIDGE" -s "$SUBNET" -d "$cidr" -j DROP >/dev/null 2>&1 ||
      fail "Lokales oder reserviertes Ziel $cidr ist nicht gesperrt."
  done
  [[ "${forward_rules[-2]}" == *"-j RETURN" ]] ||
    fail "Forwarding-Regeln lassen die Bot-Bridge nicht kontrolliert passieren."
  [[ "${forward_rules[-1]}" == *"-j RETURN" ]] ||
    fail "Forwarding-Firewall-Chain endet nicht mit RETURN."

  local first_input first_forward
  first_input="$(iptables -S INPUT | awk '$1 == "-A" { print; exit }')"
  first_forward="$(iptables -S DOCKER-USER | awk '$1 == "-A" { print; exit }')"
  [[ "$first_input" == "-A INPUT -j $INPUT_CHAIN" ]] ||
    fail "$INPUT_CHAIN ist nicht die erste INPUT-Regel."
  [[ "$first_forward" == "-A DOCKER-USER -j $FORWARD_CHAIN" ]] ||
    fail "$FORWARD_CHAIN ist nicht die erste DOCKER-USER-Regel."
}

setup_unit_and_checker() {
  local source
  local hub_user
  local sudoers_tmp
  source="$(readlink -f "${BASH_SOURCE[0]}")"
  hub_user="${SUDO_USER:-${BOT_HUB_RUN_USER:-}}"
  [[ -n "$hub_user" ]] ||
    fail "Hub-Benutzer nicht erkannt. Starte mit sudo oder setze BOT_HUB_RUN_USER."
  [[ "$hub_user" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] ||
    fail "Ungültiger Hub-Benutzername."
  id "$hub_user" >/dev/null 2>&1 || fail "Hub-Benutzer $hub_user existiert nicht."

  install -d -o root -g root -m 0755 /usr/local/sbin /etc/bot-hub
  if [[ "$source" != "$INSTALL_PATH" ]]; then
    install -o root -g root -m 0755 "$source" "$INSTALL_PATH"
  fi

  cat >"$UNIT_PATH" <<'UNIT'
[Unit]
Description=Bothub local Docker network isolation firewall
Requires=docker.service
After=docker.service
Before=bot-hub.service
PartOf=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/bot-hub-local-network-firewall setup
ExecReload=/usr/local/sbin/bot-hub-local-network-firewall setup
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
  chmod 0644 "$UNIT_PATH"

  sudoers_tmp="$(mktemp)"
  printf '%s ALL=(root) NOPASSWD: %s check\n' "$hub_user" "$INSTALL_PATH" >"$sudoers_tmp"
  chmod 0440 "$sudoers_tmp"
  visudo -cf "$sudoers_tmp" >/dev/null || {
    rm -f "$sudoers_tmp"
    fail "Sudoers-Regel konnte nicht validiert werden."
  }
  install -o root -g root -m 0440 "$sudoers_tmp" /etc/sudoers.d/bot-hub-local-network-check
  rm -f "$sudoers_tmp"

  systemctl daemon-reload
  systemctl enable bot-hub-local-network-firewall.service >/dev/null
}

main() {
  [[ "$EUID" -eq 0 ]] || fail "Dieses Skript muss als root laufen (z. B. sudo bash scripts/setup-local-network.sh)."
  need docker
  need ip
  need iptables

  case "$ACTION" in
    install)
      create_network
      read_network
      collect_blocked_cidrs
      apply_firewall
      check_firewall
      setup_unit_and_checker
      systemctl restart bot-hub-local-network-firewall.service ||
        systemctl start bot-hub-local-network-firewall.service
      systemctl is-active --quiet bot-hub-local-network-firewall.service ||
        fail "Systemd-Firewall-Service ist nicht aktiv."
      check_firewall
      note "Lokales Docker-Netz und Firewall sind eingerichtet."
      note "Netz: $NETWORK | Bridge: $BRIDGE | Subnetz: $SUBNET | Gateway: $GATEWAY"
      note "Öffentlicher Internetzugriff bleibt erlaubt; lokale/private Zielnetze sind gesperrt."
      ;;
    setup)
      create_network
      read_network
      collect_blocked_cidrs
      apply_firewall
      check_firewall
      note "Firewall-Regeln wurden erneut angewendet."
      ;;
    check)
      read_network
      collect_blocked_cidrs
      check_firewall
      note "Netzwerk- und Firewall-Prüfung erfolgreich."
      ;;
    *)
      fail "Unbekannte Aktion '$ACTION'. Erlaubt: setup, check."
      ;;
  esac
}

main
