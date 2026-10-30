#!/usr/bin/env bash
# Root-owned helper for the local Bot-Hub Docker network.
# It only changes its own chains and never flushes Docker-managed chains.
set -euo pipefail

NETWORK="bot-hub-local"
BRIDGE="br-bothublocal"
EGRESS_CHAIN="BOTHUB_LOCAL_EGRESS"
INPUT_CHAIN="BOTHUB_LOCAL_INPUT"
API_PORT="8788"
IPT="iptables"

die() {
  printf '[bot-hub-local-firewall] ERROR: %s\n' "$1" >&2
  exit 1
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "Dieses Hilfsprogramm muss als root laufen."
}

network_facts() {
  command -v docker >/dev/null 2>&1 || die "docker fehlt."
  command -v python3 >/dev/null 2>&1 || die "python3 fehlt."
  command -v ip >/dev/null 2>&1 || die "iproute2 fehlt."
  command -v "$IPT" >/dev/null 2>&1 || die "iptables fehlt."
  local json facts
  json="$(docker network inspect --format '{{json .}}' "$NETWORK" 2>/dev/null)" ||
    die "Docker-Netz $NETWORK fehlt."
  facts="$(python3 - "$json" <<'PY'
import ipaddress
import json
import sys

try:
    net = json.loads(sys.argv[1])
    options = net.get("Options") or {}
    configs = (net.get("IPAM") or {}).get("Config") or []
    if len(configs) != 1:
        raise ValueError("exactly one IPv4 subnet is required")
    cfg = configs[0]
    subnet = cfg.get("Subnet", "")
    gateway = cfg.get("Gateway", "")
    parsed = ipaddress.ip_network(subnet, strict=True)
    address = ipaddress.ip_address(gateway)
    if parsed.version != 4 or address.version != 4:
        raise ValueError("IPv4 only")
    if parsed.prefixlen < 1 or parsed.prefixlen > 30:
        raise ValueError("unsupported subnet size")
    if address not in parsed or address in (parsed.network_address, parsed.broadcast_address):
        raise ValueError("invalid gateway")
    values = [
        net.get("Driver", ""),
        net.get("Scope", ""),
        str(bool(net.get("Internal", False))).lower(),
        str(bool(net.get("EnableIPv6", False))).lower(),
        options.get("com.docker.network.bridge.name", ""),
        options.get("com.docker.network.bridge.enable_icc", ""),
        options.get("com.docker.network.bridge.enable_ip_masquerade", ""),
        subnet,
        gateway,
    ]
    print(" ".join(values))
except Exception as exc:
    print("Invalid Docker network inspection: " + str(exc), file=sys.stderr)
    sys.exit(1)
PY
)" || die "Docker-Netzwerkparameter konnten nicht gelesen werden."
  read -r DRIVER SCOPE INTERNAL IPV6 BRIDGE_OPTION ICC MASQ SUBNET GATEWAY <<< "$facts"
  [ "$DRIVER" = "bridge" ] || die "Falscher Netzwerktreiber: $DRIVER"
  [ "$SCOPE" = "local" ] || die "Das Netzwerk hat keinen lokalen Scope."
  [ "$INTERNAL" = "false" ] || die "Das Netzwerk darf nicht internal=true sein (sonst kein Internetzugang)."
  [ "$IPV6" = "false" ] || die "IPv6 muss für dieses Profil deaktiviert sein."
  [ "$BRIDGE_OPTION" = "$BRIDGE" ] || die "Unerwartete Docker-Bridge: $BRIDGE_OPTION"
  [ "$ICC" = "false" ] || die "Docker-Bridge-Peer-Kommunikation ist nicht abgeschaltet."
  [ "$MASQ" = "true" ] || die "IP-Masquerading muss für öffentlichen Ausgang aktiviert sein."
  ip -o link show dev "$BRIDGE" >/dev/null 2>&1 || die "Bridge-Interface $BRIDGE fehlt."

  # Docker's automatic address pool does not know every manually configured
  # VPN/LAN route. Refuse an overlap instead of silently shadowing that route.
  python3 - "$SUBNET" "$BRIDGE" <<'PY' || die "Docker-Subnetz kollidiert mit einer vorhandenen LAN-/VPN-Route."
import ipaddress
import subprocess
import sys

network = ipaddress.ip_network(sys.argv[1], strict=True)
bridge = sys.argv[2]
routes = subprocess.run(
    ["ip", "-4", "-o", "route", "show", "table", "all"],
    check=True,
    capture_output=True,
    text=True,
).stdout
for line in routes.splitlines():
    fields = line.split()
    if not fields or fields[0] == "default":
        continue
    dev = fields[fields.index("dev") + 1] if "dev" in fields and fields.index("dev") + 1 < len(fields) else ""
    if dev == bridge:
        continue
    try:
        route = ipaddress.ip_network(fields[0], strict=False)
    except ValueError:
        continue
    if route.version == 4 and route.overlaps(network):
        print(
            f"Docker-Subnetz {network} überschneidet sich mit Host-Route {route} ({dev or 'unbekanntes Interface'}).",
            file=sys.stderr,
        )
        sys.exit(1)
PY
}

require_docker_user_chain() {
  "$IPT" -w -nL DOCKER-USER >/dev/null 2>&1 ||
    die "DOCKER-USER fehlt. Unterstützt wird derzeit Docker Engine mit aktiviertem iptables-Backend."
}

ensure_chain() {
  local chain="$1"
  if ! "$IPT" -w -nL "$chain" >/dev/null 2>&1; then
    "$IPT" -w -N "$chain"
  fi
}

replace_jump_first() {
  local parent="$1"
  local target="$2"
  while "$IPT" -w -C "$parent" -i "$BRIDGE" -j "$target" >/dev/null 2>&1; do
    "$IPT" -w -D "$parent" -i "$BRIDGE" -j "$target"
  done
  "$IPT" -w -I "$parent" 1 -i "$BRIDGE" -j "$target"
}

remove_jump() {
  local parent="$1"
  local target="$2"
  while "$IPT" -w -C "$parent" -i "$BRIDGE" -j "$target" >/dev/null 2>&1; do
    "$IPT" -w -D "$parent" -i "$BRIDGE" -j "$target"
  done
}

while IFS= read -r CIDR; do
  [ -n "$CIDR" ] || continue
  case "$CIDR" in
    0.0.0.0/8|10.0.0.0/8|100.64.0.0/10|127.0.0.0/8|169.254.0.0/16|172.16.0.0/12|192.0.0.0/24|192.0.2.0/24|192.88.99.0/24|192.168.0.0/16|198.18.0.0/15|198.51.100.0/24|203.0.113.0/24|224.0.0.0/4|240.0.0.0/4|255.255.255.255/32) ;;
    *) die "Interner Fehler: unerwarteter Sperrbereich $CIDR" ;;
  esac
done <<'CIDRS'
0.0.0.0/8
10.0.0.0/8
100.64.0.0/10
127.0.0.0/8
169.254.0.0/16
172.16.0.0/12
192.0.0.0/24
192.0.2.0/24
192.88.99.0/24
192.168.0.0/16
198.18.0.0/15
198.51.100.0/24
203.0.113.0/24
224.0.0.0/4
240.0.0.0/4
255.255.255.255/32
CIDRS

apply_rules() {
  ensure_chain "$EGRESS_CHAIN"
  ensure_chain "$INPUT_CHAIN"
  "$IPT" -w -F "$EGRESS_CHAIN"
  "$IPT" -w -F "$INPUT_CHAIN"

  # The Docker gateway itself is RFC1918. Permit only the internal Bot API
  # tuple before the general private-address deny rules.
  "$IPT" -w -A "$EGRESS_CHAIN" -d "$GATEWAY/32" -p tcp --dport "$API_PORT" \
    -m conntrack --ctstate NEW,ESTABLISHED \
    -m comment --comment bot-hub-local-api-egress -j RETURN

  while IFS= read -r CIDR; do
    [ -n "$CIDR" ] || continue
    "$IPT" -w -A "$EGRESS_CHAIN" -d "$CIDR" -m comment --comment bot-hub-local-private-egress -j DROP
  done <<'CIDRS'
0.0.0.0/8
10.0.0.0/8
100.64.0.0/10
127.0.0.0/8
169.254.0.0/16
172.16.0.0/12
192.0.0.0/24
192.0.2.0/24
192.88.99.0/24
192.168.0.0/16
198.18.0.0/15
198.51.100.0/24
203.0.113.0/24
224.0.0.0/4
240.0.0.0/4
255.255.255.255/32
CIDRS
  "$IPT" -w -A "$EGRESS_CHAIN" -j RETURN

  "$IPT" -w -A "$INPUT_CHAIN" -d "$GATEWAY/32" -p tcp --dport "$API_PORT" \
    -m conntrack --ctstate NEW,ESTABLISHED \
    -m comment --comment bot-hub-local-api -j ACCEPT
  "$IPT" -w -A "$INPUT_CHAIN" -j DROP

  # Only the project-owned jump rules are replaced. Docker's own chains are
  # never flushed or rewritten.
  replace_jump_first DOCKER-USER "$EGRESS_CHAIN"
  replace_jump_first INPUT "$INPUT_CHAIN"
}

check_jump_first() {
  local parent="$1"
  local target="$2"
  local first
  first="$("$IPT" -w -S "$parent" | awk -v parent="$parent" '$1 == "-A" && $2 == parent { print; exit }')"
  [ "$first" = "-A $parent -i $BRIDGE -j $target" ] ||
    die "Firewall-Jump für $BRIDGE ist nicht die erste Regel in $parent."
}

check_rules() {
  local count=0
  "$IPT" -w -nL "$EGRESS_CHAIN" >/dev/null 2>&1 || die "Egress-Kette fehlt."
  "$IPT" -w -nL "$INPUT_CHAIN" >/dev/null 2>&1 || die "Input-Kette fehlt."
  check_jump_first DOCKER-USER "$EGRESS_CHAIN"
  check_jump_first INPUT "$INPUT_CHAIN"

  while IFS= read -r CIDR; do
    [ -n "$CIDR" ] || continue
    "$IPT" -w -C "$EGRESS_CHAIN" -d "$CIDR" -m comment --comment bot-hub-local-private-egress -j DROP ||
      die "Sperre für $CIDR fehlt."
    count=$((count + 1))
  done <<'CIDRS'
0.0.0.0/8
10.0.0.0/8
100.64.0.0/10
127.0.0.0/8
169.254.0.0/16
172.16.0.0/12
192.0.0.0/24
192.0.2.0/24
192.88.99.0/24
192.168.0.0/16
198.18.0.0/15
198.51.100.0/24
203.0.113.0/24
224.0.0.0/4
240.0.0.0/4
255.255.255.255/32
CIDRS
  "$IPT" -w -C "$EGRESS_CHAIN" -d "$GATEWAY/32" -p tcp --dport "$API_PORT" \
    -m conntrack --ctstate NEW,ESTABLISHED \
    -m comment --comment bot-hub-local-api-egress -j RETURN ||
    die "Ausnahme für die interne Bot-API im Egress-Filter fehlt."
  "$IPT" -w -C "$EGRESS_CHAIN" -j RETURN || die "Egress-RETURN fehlt."
  "$IPT" -w -C "$INPUT_CHAIN" -d "$GATEWAY/32" -p tcp --dport "$API_PORT" \
    -m conntrack --ctstate NEW,ESTABLISHED \
    -m comment --comment bot-hub-local-api -j ACCEPT ||
    die "Freigabe für die interne Bot-API fehlt."
  "$IPT" -w -C "$INPUT_CHAIN" -j DROP || die "Host-Input-DROP fehlt."

  # Rule presence alone is insufficient: an early RETURN would neutralize
  # the deny list. Compare the entire effective order, not only rule counts.
  local egress_rules input_rules expected_egress input_first input_second
  egress_rules="$("$IPT" -w -S "$EGRESS_CHAIN" | grep -c "^-A $EGRESS_CHAIN" || true)"
  input_rules="$("$IPT" -w -S "$INPUT_CHAIN" | grep -c "^-A $INPUT_CHAIN" || true)"
  [ "$egress_rules" -eq $((count + 2)) ] || die "Die Egress-Kette enthält unerwartete Regeln."
  [ "$input_rules" -eq 2 ] || die "Die Input-Kette enthält unerwartete Regeln."

  expected_egress="-A $EGRESS_CHAIN -d $GATEWAY/32 -p tcp -m tcp --dport $API_PORT -m conntrack --ctstate NEW,ESTABLISHED -m comment --comment bot-hub-local-api-egress -j RETURN"
  while IFS= read -r CIDR; do
    [ -n "$CIDR" ] || continue
    expected_egress="$expected_egress
-A $EGRESS_CHAIN -d $CIDR -m comment --comment bot-hub-local-private-egress -j DROP"
  done <<'CIDRS'
0.0.0.0/8
10.0.0.0/8
100.64.0.0/10
127.0.0.0/8
169.254.0.0/16
172.16.0.0/12
192.0.0.0/24
192.0.2.0/24
192.88.99.0/24
192.168.0.0/16
198.18.0.0/15
198.51.100.0/24
203.0.113.0/24
224.0.0.0/4
240.0.0.0/4
255.255.255.255/32
CIDRS
  expected_egress="$expected_egress
-A $EGRESS_CHAIN -j RETURN"
  actual_egress="$("$IPT" -w -S "$EGRESS_CHAIN" | awk -v chain="$EGRESS_CHAIN" '$1 == "-A" && $2 == chain')"
  [ "$actual_egress" = "$expected_egress" ] ||
    die "Die Egress-Regeln sind nicht vollständig und in sicherer Reihenfolge angeordnet."

  input_first="$("$IPT" -w -S "$INPUT_CHAIN" | awk -v chain="$INPUT_CHAIN" '$1 == "-A" && $2 == chain { print; exit }')"
  input_second="$("$IPT" -w -S "$INPUT_CHAIN" | awk -v chain="$INPUT_CHAIN" '$1 == "-A" && $2 == chain { count++; if (count == 2) print }')"
  [ "$input_first" = "-A $INPUT_CHAIN -d $GATEWAY/32 -p tcp -m tcp --dport $API_PORT -m conntrack --ctstate NEW,ESTABLISHED -m comment --comment bot-hub-local-api -j ACCEPT" ] ||
    die "Die interne API-Freigabe steht nicht an erster Stelle."
  [ "$input_second" = "-A $INPUT_CHAIN -j DROP" ] ||
    die "Die Host-Sperre folgt nicht direkt auf die API-Freigabe."
}

remove_rules() {
  remove_jump DOCKER-USER "$EGRESS_CHAIN"
  remove_jump INPUT "$INPUT_CHAIN"
  if "$IPT" -w -nL "$EGRESS_CHAIN" >/dev/null 2>&1; then
    "$IPT" -w -F "$EGRESS_CHAIN"
    "$IPT" -w -X "$EGRESS_CHAIN"
  fi
  if "$IPT" -w -nL "$INPUT_CHAIN" >/dev/null 2>&1; then
    "$IPT" -w -F "$INPUT_CHAIN"
    "$IPT" -w -X "$INPUT_CHAIN"
  fi
}

main() {
  require_root
  case "${1:-}" in
    validate)
      network_facts
      require_docker_user_chain
      printf 'Docker-Netz und Docker-Firewall-Backend sind vorhanden.\n'
      ;;
    apply)
      network_facts
      require_docker_user_chain
      GATEWAY="$(docker network inspect --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "$NETWORK")"
      apply_rules
      check_rules
      printf 'Lokale Docker-Isolation aktiv (%s, Gateway %s).\n' "$BRIDGE" "$GATEWAY"
      ;;
    check)
      network_facts
      require_docker_user_chain
      GATEWAY="$(docker network inspect --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "$NETWORK")"
      check_rules
      printf 'Lokale Docker-Isolation geprüft.\n'
      ;;
    remove)
      remove_rules
      printf 'Eigene lokale Docker-Firewall-Regeln entfernt.\n'
      ;;
    *)
      die "Verwendung: $0 {validate|apply|check|remove}"
      ;;
  esac
}

main "$@"
