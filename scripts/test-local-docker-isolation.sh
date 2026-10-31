#!/usr/bin/env bash
# Real Linux/Docker integration test for the local Bot-Hub network profile.
# Intended only for a disposable CI runner: it adds project-owned iptables
# chains and removes them again in the EXIT trap.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
NETWORK="bot-hub-local"
BRIDGE="br-bothublocal"
HELPER="/usr/local/sbin/bot-hub-local-firewall"
PEER="bot-hub-isolation-peer"
HOST_SERVER_PID=""

die() {
  printf '[local-isolation-integration] ERROR: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  set +e
  if [ -n "$HOST_SERVER_PID" ]; then
    kill "$HOST_SERVER_PID" >/dev/null 2>&1
    wait "$HOST_SERVER_PID" >/dev/null 2>&1
  fi
  docker rm -f "$PEER" >/dev/null 2>&1
  if [ -x "$HELPER" ]; then
    sudo "$HELPER" remove >/dev/null 2>&1
  fi
  docker network rm "$NETWORK" >/dev/null 2>&1
}
trap cleanup EXIT

docker info >/dev/null 2>&1 || die "Docker daemon ist nicht erreichbar."
sudo modprobe br_netfilter ||
  die "br_netfilter konnte auf dem Integration-Runner nicht geladen werden."
sudo sysctl -w net.bridge.bridge-nf-call-iptables=1 >/dev/null ||
  die "Bridge-Firewall-Hook konnte nicht aktiviert werden."

docker rm -f "$PEER" >/dev/null 2>&1 || true
docker network rm "$NETWORK" >/dev/null 2>&1 || true
docker pull node:22-alpine >/dev/null

docker network create \
  --driver bridge \
  --opt "com.docker.network.bridge.name=$BRIDGE" \
  --opt com.docker.network.bridge.enable_icc=false \
  --opt com.docker.network.bridge.enable_ip_masquerade=true \
  --ipv6=false \
  "$NETWORK" >/dev/null

sudo install -o root -g root -m 0755 \
  "$ROOT/scripts/local-docker-firewall.sh" "$HELPER"
sudo "$HELPER" validate
sudo "$HELPER" apply
sudo "$HELPER" check

GATEWAY="$(docker network inspect --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "$NETWORK")"
[ -n "$GATEWAY" ] || die "Docker hat kein Gateway geliefert."

# Simulate the Hub's route guard on 8788 and an unrelated host service on
# 2222. The host's own connection is allowed; Bot-bridge traffic to 2222 must
# not reach it, while 8788 is the only allowed host destination.
python3 -u - "$GATEWAY" > /tmp/bot-hub-local-isolation-http.log 2>&1 <<'PY' &
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import sys
from urllib.parse import urlsplit

gateway = sys.argv[1]

class HubHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/hub" or path.startswith("/api/hub/"):
            self.send_response(200)
            body = b"runtime-api"
        else:
            self.send_response(404)
            body = b"not available"
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass

class OtherHostService(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"host service"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass

servers = [
    ThreadingHTTPServer((gateway, 8788), HubHandler),
    ThreadingHTTPServer((gateway, 2222), OtherHostService),
]
for server in servers:
    Thread(target=server.serve_forever, daemon=True).start()
# Stay alive until the parent trap terminates this process.
import time
while True:
    time.sleep(60)
PY
HOST_SERVER_PID=$!

ready=0
for _ in $(seq 1 40); do
  if curl --noproxy '*' --silent --show-error --max-time 1 "http://$GATEWAY:8788/api/hub" >/dev/null 2>&1 &&
     curl --noproxy '*' --silent --show-error --max-time 1 "http://$GATEWAY:2222/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
done
[ "$ready" -eq 1 ] || {
  cat /tmp/bot-hub-local-isolation-http.log >&2 || true
  die "Testdienste konnten nicht am Docker-Gateway binden."
}

docker run --rm --network "$NETWORK" \
  --sysctl net.ipv6.conf.all.disable_ipv6=1 \
  --sysctl net.ipv6.conf.default.disable_ipv6=1 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  node:22-alpine node --input-type=module -e "
    const base = 'http://$GATEWAY:8788';
    const check = async (path, expected) => {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(3000) });
      if (response.status !== expected) throw new Error(path + ' expected HTTP ' + expected + ', got ' + response.status);
    };
    await check('/api/hub', 200);
    await check('/api/hub/events', 200);
    await check('/api/bots', 404);
    console.log('PASS: gateway allows only the internal Bot-API route family');
  "

docker run --rm --network "$NETWORK" \
  --sysctl net.ipv6.conf.all.disable_ipv6=1 \
  --sysctl net.ipv6.conf.default.disable_ipv6=1 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  node:22-alpine node -e "
    fetch('http://$GATEWAY:2222/', { signal: AbortSignal.timeout(2500) })
      .then(() => { console.error('Host service unexpectedly reachable'); process.exit(1); })
      .catch((error) => {
        if (error.message === 'Host service unexpectedly reachable') process.exit(1);
        console.log('PASS: non-API host port is blocked (' + error.name + ')');
      });
  "

docker run -d --name "$PEER" --network "$NETWORK" \
  --sysctl net.ipv6.conf.all.disable_ipv6=1 \
  --sysctl net.ipv6.conf.default.disable_ipv6=1 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  node:22-alpine node -e \
  'require("http").createServer((_req, res) => { res.end("peer"); }).listen(3333, "0.0.0.0")' >/dev/null
PEER_IP="$(docker inspect --format '{{(index .NetworkSettings.Networks "bot-hub-local").IPAddress}}' "$PEER")"
[ -n "$PEER_IP" ] || die "Peer-Container hat keine IPv4-Adresse."
sleep 1

docker run --rm --network "$NETWORK" \
  --sysctl net.ipv6.conf.all.disable_ipv6=1 \
  --sysctl net.ipv6.conf.default.disable_ipv6=1 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  node:22-alpine node -e "
    fetch('http://$PEER_IP:3333/', { signal: AbortSignal.timeout(2500) })
      .then(() => { console.error('Peer container unexpectedly reachable'); process.exit(1); })
      .catch((error) => {
        if (error.message === 'Peer container unexpectedly reachable') process.exit(1);
        console.log('PASS: direct bot-to-bot connection is blocked (' + error.name + ')');
      });
  "

docker run --rm --network "$NETWORK" \
  --sysctl net.ipv6.conf.all.disable_ipv6=1 \
  --sysctl net.ipv6.conf.default.disable_ipv6=1 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  node:22-alpine node --input-type=module -e "
    const response = await fetch('https://discord.com/api/v10/gateway', { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('Discord gateway returned HTTP ' + response.status);
    console.log('PASS: public Discord HTTPS egress works');
  " || die "Öffentlicher Discord-HTTPS-Ausgang ist fehlgeschlagen."

printf '[local-isolation-integration] All Linux/Docker integration checks passed.\n'
