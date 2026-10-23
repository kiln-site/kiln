#!/bin/sh
# Installs Kiln on this machine with Docker as its only requirement.
#
#   curl -fsSL https://raw.githubusercontent.com/kiln-site/kiln/main/scripts/install.sh | sh
#
# It starts one Relay in platform mode, which installs Hearth, its MySQL
# database, and its cache, pairs with that Hearth, and keeps them running.
# With --node it starts a plain Relay instead, to add this machine to an
# existing Kiln. Run it again to see an installation's status.
#
# See docs/self-hosting.md.
set -eu

image_prefix="ghcr.io/kiln-site"
channel="latest"
container="kiln-relay"
volume="kiln-relay-data"
mode="platform"
url=""
port="3000"
relay_host=""
game_host=""
image=""
hearth_image=""
namespace=""
bind_address=""
sftp_port="2022"
assume_yes=0

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --url URL          Where people will open Hearth, such as
                     https://kiln.example.com (default: http://<this
                     machine's public IP>:3000)
  --port PORT        Host port Hearth listens on (default: 3000)
  --game-host HOST   Address players connect to game servers at
                     (default: the host in --url)
  --nightly          Install the newest nightly instead of the newest
                     stable release
  --image IMAGE      Relay image to run (overrides --nightly)
  --hearth-image IMAGE
                     Hearth image to install, such as a local build
  --bind ADDRESS     Host address Hearth listens on (default: all)
  --sftp-port PORT   Host port for SFTP (default: 2022)
  --namespace NAME   Prefix for every container, volume, and network, to run
                     beside another Kiln on the same machine
  --node             Add this machine to an existing Kiln: start only a
                     Relay and print the invitation to pair it with
  --relay-host HOST  With --node: the address Hearth reaches this Relay at
                     (default: this machine's public IP)
  -y, --yes          Don't ask; use the defaults for anything not given
  -h, --help         Show this help
EOF
}

say() { printf '%s\n' "$*"; }
fail() {
  printf 'kiln: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) url="${2:?--url needs a value}"; shift 2 ;;
    --port) port="${2:?--port needs a value}"; shift 2 ;;
    --game-host) game_host="${2:?--game-host needs a value}"; shift 2 ;;
    --relay-host) relay_host="${2:?--relay-host needs a value}"; shift 2 ;;
    --image) image="${2:?--image needs a value}"; shift 2 ;;
    --hearth-image) hearth_image="${2:?--hearth-image needs a value}"; shift 2 ;;
    --bind) bind_address="${2:?--bind needs a value}"; shift 2 ;;
    --sftp-port) sftp_port="${2:?--sftp-port needs a value}"; shift 2 ;;
    --namespace) namespace="${2:?--namespace needs a value}"; shift 2 ;;
    --nightly) channel="latest-nightly"; shift ;;
    --node) mode="node"; shift ;;
    -y | --yes) assume_yes=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option $1" ;;
  esac
done

[ -n "$image" ] || image="$image_prefix/relay:$channel"
prefix="${namespace:+$namespace-}"
container="$prefix$container"
volume="$prefix$volume"
hearth="${prefix}kiln-hearth"

# Asks on the terminal even when the script itself arrives on stdin.
ask() {
  prompt="$1"
  default="$2"
  if [ "$assume_yes" -eq 1 ] || ! [ -r /dev/tty ]; then
    printf '%s' "$default"
    return
  fi
  printf '%s [%s]: ' "$prompt" "$default" >/dev/tty
  read -r answer </dev/tty || answer=""
  printf '%s' "${answer:-$default}"
}

public_ip() {
  for service in https://api.ipify.org https://ifconfig.me/ip; do
    if command -v curl >/dev/null 2>&1; then
      address=$(curl -fsS --max-time 5 "$service" 2>/dev/null || true)
    elif command -v wget >/dev/null 2>&1; then
      address=$(wget -qO- -T 5 "$service" 2>/dev/null || true)
    else
      address=""
    fi
    case "$address" in
      *[!0-9.]* | "") ;;
      *) printf '%s' "$address"; return ;;
    esac
  done
  hostname -I 2>/dev/null | awk '{print $1}'
}

command -v docker >/dev/null 2>&1 ||
  fail "Docker isn't installed. Install it from https://docs.docker.com/engine/install/ and run this again."
if ! docker info >/dev/null 2>&1; then
  fail "Docker isn't running, or this user can't use it. Start Docker, or run this script with sudo."
fi

if docker container inspect "$container" >/dev/null 2>&1; then
  if [ "$mode" = "node" ]; then
    say "A Relay ($container) is already running on this machine. A new"
    say "invitation to pair it, which expires in 15 minutes:"
    say ""
    docker exec "$container" kiln-relay pair create 2>/dev/null
    exit 0
  fi
  say "Kiln's Relay ($container) is already installed on this machine."
  if docker exec "$container" kiln-relay platform status 2>/dev/null; then
    say ""
    say "Hearth's setup link, if no administrator exists yet:"
    docker exec "$container" kiln-relay platform setup-url 2>/dev/null
  fi
  exit 0
fi

address=$(public_ip)
[ -n "$address" ] || address="localhost"

if [ "$mode" = "node" ]; then
  [ -n "$relay_host" ] ||
    relay_host=$(ask "Address Hearth will reach this Relay at" "$address")
  say "Starting a Relay from $image…"
  docker volume create "$volume" >/dev/null
  docker run --detach --name "$container" --restart unless-stopped \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume "$volume:/data" \
    --publish 4100:4100 --publish "$sftp_port:2022" \
    --env KILN_RELAY_HOST="$relay_host" \
    ${namespace:+--env KILN_RELAY_RESOURCE_NAMESPACE="$namespace"} \
    ${game_host:+--env KILN_RELAY_GAME_HOST="$game_host"} \
    "$image" >/dev/null
  say "Waiting for the Relay to start…"
  attempts=0
  until [ "$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null)" = "healthy" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 120 ] || fail "The Relay didn't start. See: docker logs $container"
    sleep 2
  done
  say ""
  say "In Hearth, open Relays, choose Add Relay, and paste this invitation."
  say "It expires in 15 minutes; run this script again for a new one."
  say ""
  docker exec "$container" kiln-relay pair create 2>/dev/null
  exit 0
fi

[ -n "$url" ] || url=$(ask "Where people will open Hearth" "http://$address:$port")
case "$url" in
  http://* | https://*) ;;
  *) fail "--url must start with http:// or https://" ;;
esac

say "Installing Kiln from $image…"
docker volume create "$volume" >/dev/null
docker run --detach --name "$container" --restart unless-stopped \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume "$volume:/data" \
  --publish "$sftp_port:2022" \
  --env KILN_RELAY_MODE=platform \
  --env KILN_RELAY_CONTAINER="$container" \
  --env KILN_URL="$url" \
  --env KILN_PLATFORM_HEARTH_PORT="$port" \
  ${bind_address:+--env KILN_PLATFORM_HEARTH_BIND="$bind_address"} \
  ${hearth_image:+--env KILN_PLATFORM_HEARTH_IMAGE="$hearth_image"} \
  ${namespace:+--env KILN_RELAY_RESOURCE_NAMESPACE="$namespace"} \
  ${game_host:+--env KILN_RELAY_GAME_HOST="$game_host"} \
  "$image" >/dev/null

say "The Relay is installing Hearth, MySQL, and Valkey. The first start"
say "downloads their images, which can take a few minutes."
attempts=0
until [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$hearth" 2>/dev/null)" = "healthy" ]; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 450 ]; then
    fail "Hearth didn't start within 15 minutes. See: docker logs $container"
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]; then
    docker logs --tail 20 "$container" >&2 || true
    fail "The Relay stopped. See: docker logs $container"
  fi
  sleep 2
done

say ""
say "Kiln is running. Open this link to create its administrator:"
say ""
say "  $(docker exec "$container" kiln-relay platform setup-url 2>/dev/null)"
say ""
say "Keep a copy of this installation's secrets somewhere safe:"
say "  docker exec $container kiln-relay platform export-kit > kiln-recovery.json"
