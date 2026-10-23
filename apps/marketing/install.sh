#!/bin/sh
# Installs Kiln on this machine. It needs Docker, and installs it first when
# it's missing (with Docker's own install script, after asking).
#
#   curl -fsSL https://kiln.site/install | sh
#   curl -fsSL https://kiln.site/install | sh -s -- --node
#
# kiln.site serves this file at /install (apps/marketing/src/routes/install.ts),
# so it's live once the marketing site deploys from main.
#
# It starts one Relay in platform mode, which installs Hearth, its MySQL
# database, and its cache, pairs with that Hearth, and keeps them running.
# With --node it starts a plain Relay instead, to add this machine to an
# existing Kiln. Run it again to see an installation's status.
#
# See docs/self-hosting.md in https://github.com/kiln-site/kiln.
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
install_docker_allowed=1

usage() {
  cat <<'EOF'
Usage: curl -fsSL https://kiln.site/install | sh -s -- [options]

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
  --skip-docker-install
                     Don't install Docker if it's missing; stop instead
  -y, --yes          Don't ask; use the defaults for anything not given,
                     and install Docker if it's missing
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
    --skip-docker-install) install_docker_allowed=0; shift ;;
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

# Whether there's a terminal to ask on. /dev/tty can exist without one, as
# under cron or `docker run` without -t, so it has to open.
has_terminal() {
  (: </dev/tty) 2>/dev/null
}

# Asks on the terminal even when the script itself arrives on stdin.
ask() {
  prompt="$1"
  default="$2"
  if [ "$assume_yes" -eq 1 ] || ! has_terminal; then
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

# ---------------------------------------------------------------- Docker

# How this script runs Docker: `docker`, or `sudo docker` for a user who
# can't reach Docker's socket.
docker_cmd="docker"
dk() { $docker_cmd "$@"; }

# Runs a command as root: directly, or through sudo, which asks for a
# password on the terminal when it needs one.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "This needs root. Run it as root, or install sudo."
  fi
}

# Yes/no on the terminal; --yes answers yes. Without a terminal to ask on,
# it's a no.
confirm() {
  [ "$assume_yes" -eq 1 ] && return 0
  has_terminal || return 1
  printf '%s [Y/n]: ' "$1" >/dev/tty
  read -r reply </dev/tty || return 1
  case "$reply" in
    "" | [Yy] | [Yy][Ee][Ss]) return 0 ;;
    *) return 1 ;;
  esac
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    fail "Installing Docker needs curl or wget."
  fi
}

# A field of /etc/os-release, such as ID ("rocky") or ID_LIKE ("rhel centos").
os_field() {
  [ -r /etc/os-release ] || return 0
  sed -n "s/^$1=//p" /etc/os-release | tr -d '"' | head -n 1
}

install_docker() {
  case "$(uname -s)" in
    Linux) ;;
    Darwin)
      fail "Install Docker Desktop for Mac (https://docs.docker.com/desktop/setup/install/mac-install/), start it, and run this again." ;;
    *)
      fail "Install Docker (https://docs.docker.com/engine/install/) and run this again." ;;
  esac
  id=$(os_field ID)
  like=$(os_field ID_LIKE)
  say "Installing Docker…"
  case "$id" in
    alpine)
      as_root apk add --no-cache docker
      ;;
    arch | manjaro | endeavouros)
      as_root pacman -Sy --noconfirm --needed docker
      ;;
    rocky | almalinux | ol)
      # Docker publishes no packages for these; its CentOS ones are the
      # documented way.
      as_root dnf -y install dnf-plugins-core
      as_root dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
      as_root dnf -y install docker-ce docker-ce-cli containerd.io
      ;;
    *)
      case " $id $like " in
        *" debian "* | *" ubuntu "* | *" fedora "* | *" centos "* | *" rhel "* | *" raspbian "* | *" sles "*) ;;
        *)
          fail "Kiln can't install Docker on ${id:-this system} for you. Install it (https://docs.docker.com/engine/install/) and run this again." ;;
      esac
      # Docker's own script, for the distributions it supports.
      script=$(mktemp)
      download https://get.docker.com "$script"
      as_root sh "$script"
      rm -f "$script"
      ;;
  esac
  command -v docker >/dev/null 2>&1 ||
    fail "Docker's installation finished without a docker command. See https://docs.docker.com/engine/install/"
}

start_docker() {
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    as_root systemctl enable --now docker >/dev/null 2>&1 ||
      as_root systemctl start docker
  elif command -v rc-service >/dev/null 2>&1; then
    as_root rc-update add docker default >/dev/null 2>&1 || true
    as_root rc-service docker start
  elif command -v service >/dev/null 2>&1; then
    as_root service docker start
  else
    fail "Start the Docker daemon, then run this again."
  fi
}

# Finds how to reach Docker: as this user, or with sudo.
docker_reachable() {
  if docker info >/dev/null 2>&1; then
    docker_cmd="docker"
    return 0
  fi
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 &&
    sudo docker info >/dev/null 2>&1; then
    docker_cmd="sudo docker"
    return 0
  fi
  return 1
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    if [ "$install_docker_allowed" -eq 0 ]; then
      fail "Docker isn't installed. Install it (https://docs.docker.com/engine/install/) and run this again."
    fi
    say "Kiln runs on Docker, which isn't installed on this machine."
    confirm "Install Docker now, with Docker's official install script?" ||
      fail "Docker isn't installed. Install it (https://docs.docker.com/engine/install/), or run this again with --yes to let Kiln install it."
    install_docker
    installed=1
  fi

  if ! docker_reachable; then
    if [ "${installed:-0}" -eq 1 ]; then
      say "Starting Docker…"
    else
      say "Docker is installed but isn't running."
      confirm "Start Docker now, and start it when this machine boots?" ||
        fail "Start Docker, then run this again."
    fi
    start_docker
    attempts=0
    until docker_reachable; do
      attempts=$((attempts + 1))
      [ "$attempts" -lt 30 ] ||
        fail "Docker didn't start. Check it with: sudo systemctl status docker"
      sleep 1
    done
  fi
  [ "$docker_cmd" = "docker" ] ||
    say "Using sudo for Docker, since this user can't reach it directly."

  # The daemon is recent enough, and can pull and run a container.
  server_version=$(dk version --format '{{.Server.Version}}' 2>/dev/null || true)
  major=${server_version%%.*}
  case "$major" in
    "" | *[!0-9]*)
      fail "Docker didn't report its version. Check it with: docker version" ;;
  esac
  [ "$major" -ge 20 ] ||
    fail "Docker $server_version is too old for Kiln; update it to 25 or newer (https://docs.docker.com/engine/install/)."
  [ "$major" -ge 25 ] ||
    say "Docker $server_version works, but Kiln's health checks are quicker with Docker 25 or newer."
  say "Checking Docker can run containers…"
  dk run --rm --pull missing hello-world >/dev/null 2>&1 ||
    fail "Docker couldn't run a test container. Check it with: docker run --rm hello-world"
  say "Docker $server_version is ready."
}

ensure_docker

if dk container inspect "$container" >/dev/null 2>&1; then
  if [ "$mode" = "node" ]; then
    say "A Relay ($container) is already running on this machine. A new"
    say "invitation to pair it, which expires in 15 minutes:"
    say ""
    dk exec "$container" kiln-relay pair create 2>/dev/null
    exit 0
  fi
  say "Kiln's Relay ($container) is already installed on this machine."
  if dk exec "$container" kiln-relay platform status 2>/dev/null; then
    say ""
    say "Hearth's setup link, if no administrator exists yet:"
    dk exec "$container" kiln-relay platform setup-url 2>/dev/null
  fi
  exit 0
fi

address=$(public_ip)
[ -n "$address" ] || address="localhost"

if [ "$mode" = "node" ]; then
  [ -n "$relay_host" ] ||
    relay_host=$(ask "Address Hearth will reach this Relay at" "$address")
  say "Starting a Relay from $image…"
  dk volume create "$volume" >/dev/null
  dk run --detach --name "$container" --restart unless-stopped \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume "$volume:/data" \
    --publish 4100:4100 --publish "$sftp_port:2022" \
    --env KILN_RELAY_HOST="$relay_host" \
    ${namespace:+--env KILN_RELAY_RESOURCE_NAMESPACE="$namespace"} \
    ${game_host:+--env KILN_RELAY_GAME_HOST="$game_host"} \
    "$image" >/dev/null
  say "Waiting for the Relay to start…"
  attempts=0
  until [ "$(dk inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null)" = "healthy" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 120 ] || fail "The Relay didn't start. See: $docker_cmd logs $container"
    sleep 2
  done
  say ""
  say "In Hearth, open Relays, choose Add Relay, and paste this invitation."
  say "It expires in 15 minutes; run this script again for a new one."
  say ""
  dk exec "$container" kiln-relay pair create 2>/dev/null
  exit 0
fi

[ -n "$url" ] || url=$(ask "Where people will open Hearth" "http://$address:$port")
case "$url" in
  http://* | https://*) ;;
  *) fail "--url must start with http:// or https://" ;;
esac

say "Installing Kiln from $image…"
dk volume create "$volume" >/dev/null
dk run --detach --name "$container" --restart unless-stopped \
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
until [ "$(dk inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$hearth" 2>/dev/null)" = "healthy" ]; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 450 ]; then
    fail "Hearth didn't start within 15 minutes. See: $docker_cmd logs $container"
  fi
  if [ "$(dk inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]; then
    dk logs --tail 20 "$container" >&2 || true
    fail "The Relay stopped. See: $docker_cmd logs $container"
  fi
  sleep 2
done

say ""
say "Kiln is running. Open this link to create its administrator:"
say ""
say "  $(dk exec "$container" kiln-relay platform setup-url 2>/dev/null)"
say ""
say "Keep a copy of this installation's secrets somewhere safe:"
say "  $docker_cmd exec $container kiln-relay platform export-kit > kiln-recovery.json"
