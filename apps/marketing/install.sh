#!/bin/sh
# Installs Kiln on this machine, and Docker first when it's missing.
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
# The terminal shows one line per step. Everything each step ran and printed
# goes to the install log (~/kiln-install.log), for when something fails.
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
asked=0

usage() {
  cat <<'EOF'
Usage: curl -fsSL https://kiln.site/install | sh -s -- [options]

  --url URL          Where people will open Kiln, such as
                     http://kiln.example.com:3000 (default: http://<this
                     machine's public IP>:3000)
  --port PORT        Host port Kiln listens on (default: 3000)
  --game-host HOST   Address players connect to game servers at
                     (default: the host in --url)
  --nightly          Install the newest nightly instead of the newest
                     stable release
  --image IMAGE      Relay image to run (overrides --nightly)
  --hearth-image IMAGE
                     Hearth image to install, such as a local build
  --bind ADDRESS     Host address Kiln listens on (default: all)
  --sftp-port PORT   Host port for SFTP (default: 2022)
  --namespace NAME   Prefix for every container, volume, and network, to run
                     beside another Kiln on the same machine
  --node             Add this machine to an existing Kiln: start only a
                     Relay and print the invitation to pair it with
  --relay-host HOST  With --node: the address Kiln reaches this Relay at
                     (default: this machine's public IP)
  --skip-docker-install
                     Don't install Docker if it's missing; stop instead
  -y, --yes          Don't ask; use the defaults for anything not given,
                     and install Docker if it's missing
  -h, --help         Show this help

The install log is ~/kiln-install.log, or KILN_INSTALL_LOG.
EOF
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
    *) usage >&2; printf 'kiln: unknown option %s\n' "$1" >&2; exit 1 ;;
  esac
done

[ -n "$image" ] || image="$image_prefix/relay:$channel"
prefix="${namespace:+$namespace-}"
container="$prefix$container"
volume="$prefix$volume"
hearth="${prefix}kiln-hearth"
database="${prefix}kiln-hearth-mysql"

# ------------------------------------------------------------- the screen

# Spinners, colors, and redrawn lines only on a terminal; plain lines
# otherwise, such as when the output is saved to a file.
fancy=0
[ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ] && fancy=1
unicode=0
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in *UTF-8* | *utf8* | *UTF8*) unicode=1 ;; esac

if [ "$fancy" -eq 1 ]; then
  clear_line=$(printf '\r\033[K')
  reset=$(printf '\033[0m')
  bold=$(printf '\033[1m')
  dim=$(printf '\033[2m')
  red=$(printf '\033[31m')
  green=$(printf '\033[32m')
  orange=$(printf '\033[38;5;208m')
else
  clear_line="" reset="" bold="" dim="" red="" green="" orange=""
fi
if [ "$unicode" -eq 1 ]; then
  tick="✓" cross="✗" arrow="→" bar_full="█" bar_empty="░"
  spinner="⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏"
else
  tick="ok" cross="x" arrow="->" bar_full="#" bar_empty="-"
  spinner="| / - \\"
fi

say() { printf '%s\n' "$*"; }

logo() {
  if [ "$unicode" -eq 1 ]; then
    printf '\n'
    printf '%s        ▄▄▄%s\n' "$orange" "$reset"
    printf '%s      ▄▄▄▄▄▄▄%s\n' "$orange" "$reset"
    printf '%s   ▐▀▀▀▀▀▀▀▀▀▀▀▌%s\n' "$orange" "$reset"
    printf '%s   ▐ ▬▬▬     ■ ▌%s   %sKiln%s\n' "$orange" "$reset" "$bold" "$reset"
    printf '%s   ▐ ▬▬▬     ■ ▌%s   %s%s%s\n' "$orange" "$reset" "$dim" "$1" "$reset"
    printf '%s   ▐ ▬▬▬     ■ ▌%s\n' "$orange" "$reset"
    printf '%s  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀%s\n\n' "$orange" "$reset"
  else
    printf '\nKiln - %s\n\n' "$1"
  fi
}

now() { date +%s; }
started_at=$(now)

duration() {
  seconds=$1
  if [ "$seconds" -ge 60 ]; then
    printf '%dm %02ds' $((seconds / 60)) $((seconds % 60))
  else
    printf '%ds' "$seconds"
  fi
}

# ---------------------------------------------------------------- the log

# Readable only by this user, since a failed step adds the Relay's own logs.
# A log someone else owns, or a link to one, gives way to a new file: even
# root's chmod wouldn't keep its owner out.
log_file="${KILN_INSTALL_LOG:-${HOME:-/tmp}/kiln-install.log}"
owned_by_me() {
  # shellcheck disable=SC2012 # one path, and only its owner's uid
  [ "$(ls -ldn -- "$1" 2>/dev/null | awk '{print $3}')" = "$(id -u)" ]
}
if [ -L "$log_file" ] || { [ -e "$log_file" ] && ! owned_by_me "$log_file"; } ||
  ! (umask 077 && : >>"$log_file") 2>/dev/null || ! chmod 600 "$log_file" 2>/dev/null; then
  log_file=$(mktemp "${TMPDIR:-/tmp}/kiln-install.XXXXXX") || {
    printf 'kiln: there is nowhere to write the install log\n' >&2
    exit 1
  }
fi
log() { printf '%s\n' "$*" >>"$log_file"; }
{
  printf '\n========== Kiln install, %s ==========\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  printf 'user: %s (uid %s)\n' "$(id -un 2>/dev/null || echo '?')" "$(id -u)"
  printf 'system: %s\n' "$(uname -a)"
  [ -r /etc/os-release ] && sed -n 's/^PRETTY_NAME=//p' /etc/os-release | tr -d '"' | sed 's/^/os: /'
  printf 'mode: %s, image: %s\n' "$mode" "$image"
} >>"$log_file"

# Stops with a short reason, the last lines it logged, and where the rest is.
fail() {
  log "kiln: $*"
  printf '\n  %s%s %s%s\n' "$red" "$cross" "$*" "$reset" >&2
  printf '\n  %sThe full install log is %s%s\n\n' "$dim" "$log_file" "$reset" >&2
  exit 1
}

# ------------------------------------------------------------------ steps

# A process's children, through pgrep or /proc.
children_of() {
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -P "$1" 2>/dev/null || true
  else
    awk -v parent="$1" '$4 == parent { print $1 }' /proc/[0-9]*/stat 2>/dev/null || true
  fi
}

# Sends a signal to a process, through sudo for one running as root.
signal() {
  kill "-$1" "$2" 2>/dev/null ||
    { [ "$(id -u)" -ne 0 ] && sudo -n kill "-$1" "$2" 2>/dev/null; } || true
}

# Stops a step and everything it started, such as Docker's installer, so
# nothing keeps changing the machine after the script ends. Each process is
# paused first so it can't start another while its children go.
kill_tree() {
  signal STOP "$1"
  for child in $(children_of "$1"); do kill_tree "$child"; done
  signal TERM "$1"
  signal CONT "$1"
}

step_pid=""
# Keeps the script's own exit status, so cleanup can't turn success into
# failure.
on_exit() {
  code=$?
  if [ -n "$step_pid" ]; then kill_tree "$step_pid"; fi
  if [ -n "${sudo_keeper:-}" ]; then kill "$sudo_keeper" 2>/dev/null || true; fi
  if [ "$fancy" -eq 1 ]; then printf '\033[?25h'; fi
  exit "$code"
}
trap on_exit EXIT
trap 'printf "\n"; exit 130' INT TERM

# How far a step has got, as a short bar, or nothing. Set per step.
step_progress=""

progress_bar() {
  done_count=$1
  total=$2
  [ "$total" -gt 0 ] || return 0
  [ "$done_count" -le "$total" ] || done_count=$total
  filled=$((done_count * 12 / total))
  bar=""
  i=0
  while [ "$i" -lt 12 ]; do
    if [ "$i" -lt "$filled" ]; then bar="$bar$bar_full"; else bar="$bar$bar_empty"; fi
    i=$((i + 1))
  done
  printf '%s %3d%%' "$bar" $((done_count * 100 / total))
}

# Runs one step: its command's output goes to the log, and the terminal shows
# one line with a spinner and a timer, then a tick and how long it took.
step() {
  label=$1
  shift
  step_started=$(now)
  log ""
  log "---------- $label ----------"
  log "\$ $*"
  step_log_start=$(wc -l <"$log_file")
  # In the background even without a terminal: a `||` here would turn off
  # `set -e` inside the step, so a failed command wouldn't stop it.
  ("$@") >>"$log_file" 2>&1 </dev/null &
  step_pid=$!
  if [ "$fancy" -eq 1 ]; then
    printf '\033[?25l'
    frame=1
    # shellcheck disable=SC2086 # one frame per word
    frames=$(printf '%s\n' $spinner | wc -l)
    while kill -0 "$step_pid" 2>/dev/null; do
      # shellcheck disable=SC2086
      symbol=$(printf '%s\n' $spinner | sed -n "${frame}p")
      frame=$((frame % frames + 1))
      extra=""
      [ -z "$step_progress" ] || extra=$($step_progress 2>/dev/null || true)
      [ -z "$extra" ] || extra="$extra "
      printf '%s  %s%s%s %-26s %s%s%s%s' "$clear_line" "$orange" "$symbol" "$reset" "$label" \
        "$dim" "$extra" "$(duration $(($(now) - step_started)))" "$reset"
      sleep 0.15 2>/dev/null || sleep 1
    done
    printf '\033[?25h'
  fi
  status=0
  wait "$step_pid" || status=$?
  step_pid=""
  step_progress=""
  took=$(duration $(($(now) - step_started)))
  if [ "$status" -ne 0 ]; then
    log "(failed with status $status)"
    printf '%s  %s%s%s %-26s %s%s%s\n' "$clear_line" "$red" "$cross" "$reset" "$label" "$dim" "$took" "$reset"
    # The reason, when the step gave one: its own `kiln:` line, or its last.
    reason=$(tail -n +"$((step_log_start + 1))" "$log_file" | sed -n 's/^kiln: //p' | tail -n 1)
    [ -n "$reason" ] || reason="$label didn't finish."
    fail "$reason"
  fi
  printf '%s  %s%s%s %-26s %s%s%s\n' "$clear_line" "$green" "$tick" "$reset" "$label" "$dim" "$took" "$reset"
}

# Exits a step's command with a reason the step shows.
stop() {
  printf 'kiln: %s\n' "$*"
  exit 1
}

# ----------------------------------------------------------------- asking

# Whether there's a terminal to ask on. /dev/tty can exist without one, as
# under cron or `docker run` without -t, so it has to open.
has_terminal() {
  (: </dev/tty) 2>/dev/null
}

# Yes/no on the terminal; --yes answers yes. Without a terminal to ask on,
# it's a no.
confirm() {
  [ "$assume_yes" -eq 1 ] && return 0
  has_terminal || return 1
  asked=1
  printf '  %s [Y/n] ' "$1" >/dev/tty
  read -r reply </dev/tty || return 1
  case "$reply" in
    "" | [Yy] | [Yy][Ee][Ss]) return 0 ;;
    *) return 1 ;;
  esac
}

# A line of text from the terminal, or the default.
ask() {
  if [ "$assume_yes" -eq 1 ] || ! has_terminal; then
    printf '%s' "$2"
    return
  fi
  printf '  %s ' "$1" >/dev/tty
  read -r answer </dev/tty || answer=""
  printf '%s' "$answer"
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

# ----------------------------------------------------------------- Docker

# How this script runs Docker: `docker`, or `sudo docker` for a user who
# can't reach Docker's socket.
docker_cmd="docker"
dk() { $docker_cmd "$@"; }

# Runs a command as root: directly, or through sudo.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

# Asks for the sudo password now, if it needs one, rather than mid-step
# behind a spinner, and keeps it fresh until the script ends.
need_root() {
  [ "$(id -u)" -eq 0 ] && return 0
  command -v sudo >/dev/null 2>&1 ||
    fail "Kiln needs to run as root here. Run it as root, or install sudo."
  if ! sudo -n true 2>/dev/null; then
    has_terminal || fail "Kiln needs sudo. Run it again from a terminal, or as root."
    printf '  Kiln needs your password to set things up.\n' >/dev/tty
    # shellcheck disable=SC2024 # the terminal is for sudo's prompt
    sudo -v </dev/tty || fail "Kiln needs sudo to continue."
  fi
  if [ -z "${sudo_keeper:-}" ]; then
    (while kill -0 $$ 2>/dev/null; do sudo -n true 2>/dev/null; sleep 50; done) >/dev/null 2>&1 &
    sudo_keeper=$!
  fi
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2" || stop "Couldn't download $1. Check this machine is online."
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1" || stop "Couldn't download $1. Check this machine is online."
  else
    stop "Installing Docker needs curl or wget."
  fi
}

# A field of /etc/os-release, such as ID ("rocky") or ID_LIKE ("rhel centos").
os_field() {
  [ -r /etc/os-release ] || return 0
  sed -n "s/^$1=//p" /etc/os-release | tr -d '"' | head -n 1
}

# Which way this system gets Docker, or nothing when Kiln can't install it.
docker_installer() {
  [ "$(uname -s)" = "Linux" ] || return 0
  id=$(os_field ID)
  like=$(os_field ID_LIKE)
  case "$id" in
    alpine) echo apk ;;
    arch | manjaro | endeavouros) echo pacman ;;
    rocky | almalinux | ol) echo centos-repo ;;
    *)
      case " $id $like " in
        *" debian "* | *" ubuntu "* | *" fedora "* | *" centos "* | *" rhel "* | *" raspbian "* | *" sles "*)
          echo get-docker ;;
      esac
      ;;
  esac
}

install_docker() {
  case "$(docker_installer)" in
    apk) as_root apk add --no-cache docker ;;
    pacman) as_root pacman -Sy --noconfirm --needed docker ;;
    centos-repo)
      # Docker publishes no packages for these; its CentOS ones are the
      # documented way.
      as_root dnf -y install dnf-plugins-core
      as_root dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
      as_root dnf -y install docker-ce docker-ce-cli containerd.io
      ;;
    get-docker)
      # Docker's own script, for the distributions it supports.
      script=$(mktemp)
      download https://get.docker.com "$script"
      as_root sh "$script"
      rm -f "$script"
      ;;
  esac
  command -v docker >/dev/null 2>&1 ||
    stop "Docker installed without a docker command. See https://docs.docker.com/engine/install/"
}

start_docker() {
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    as_root systemctl enable --now docker || as_root systemctl start docker
  elif command -v rc-service >/dev/null 2>&1; then
    as_root rc-update add docker default || true
    as_root rc-service docker start
  elif command -v service >/dev/null 2>&1; then
    as_root service docker start
  else
    stop "Start Docker, then run this again."
  fi
  attempts=0
  until docker_reachable; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 30 ] || stop "Docker didn't start."
    sleep 1
  done
}

# Finds how to reach Docker: as this user, or with sudo.
docker_reachable() {
  if docker info >/dev/null 2>&1; then
    docker_cmd="docker"
    return 0
  fi
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 &&
    sudo -n docker info >/dev/null 2>&1; then
    docker_cmd="sudo docker"
    return 0
  fi
  return 1
}

# The daemon is recent enough, and can pull and run a container.
check_docker() {
  version=$(dk version --format '{{.Server.Version}}' 2>/dev/null || true)
  echo "Docker $version, run as: $docker_cmd"
  major=${version%%.*}
  case "$major" in
    "" | *[!0-9]*) stop "Docker didn't say which version it is." ;;
  esac
  [ "$major" -ge 20 ] ||
    stop "Docker $version is too old. Update it to 25 or newer."
  dk run --rm --pull missing hello-world ||
    stop "Docker couldn't run a test container."
}

# What needs doing before Docker works; asked up front, so the rest runs
# without stopping.
plan_docker() {
  docker_missing=0
  docker_stopped=0
  if ! command -v docker >/dev/null 2>&1; then
    docker_missing=1
    [ "$install_docker_allowed" -eq 1 ] ||
      fail "Docker isn't installed. Install it, then run this again."
    if [ "$(uname -s)" = "Darwin" ]; then
      fail "Install Docker Desktop for Mac, start it, then run this again."
    fi
    [ -n "$(docker_installer)" ] ||
      fail "Kiln can't install Docker on this system. Install it, then run this again."
    confirm "Kiln needs Docker. Install it now?" ||
      fail "Kiln needs Docker. Run this again and choose Y, or add --yes."
    need_root
  elif ! docker_reachable; then
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
      need_root
      docker_reachable && return 0
    fi
    docker_stopped=1
    confirm "Docker isn't running. Start it?" ||
      fail "Start Docker, then run this again."
    need_root
  fi
}

# ------------------------------------------------------------------- Kiln

# Pulls the Relay image, with a bar from the layers Docker reports.
pull_progress() {
  tail -n +"$((step_log_start + 1))" "$log_file" | awk -F': ' '
    /: (Pulling fs layer|Waiting|Downloading|Already exists|Download complete|Pull complete)/ { seen[$1] = 1 }
    /: (Already exists|Download complete|Pull complete)$/ { done[$1] = 1 }
    END { t = 0; d = 0; for (l in seen) t++; for (l in done) d++; print d, t }
  ' | {
    read -r finished total
    progress_bar "$finished" "$total"
  }
}

pull_relay() {
  # A local image (a build, or one already here) is fine when the registry
  # doesn't have it.
  dk pull "$image" || dk image inspect "$image" >/dev/null ||
    stop "Couldn't download Kiln. Check this machine can reach ghcr.io."
}

# Waits for a container's health check to pass, or the Relay to stop.
wait_healthy() {
  name=$1
  limit=$2
  waited=0
  until [ "$(dk inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$name" 2>/dev/null)" = "healthy" ]; do
    if [ "$(dk inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]; then
      dk logs --tail 40 "$container" 2>&1 || true
      stop "Kiln's Relay stopped. Its last lines are in the install log."
    fi
    waited=$((waited + 2))
    if [ "$waited" -ge "$limit" ]; then
      dk logs --tail 40 "$container" 2>&1 || true
      stop "This is taking too long. The Relay's last lines are in the install log."
    fi
    sleep 2
  done
  dk inspect --format '{{.Name}} {{.Config.Image}} healthy' "$name"
}

start_platform_relay() {
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
    "$image"
}

start_node_relay() {
  dk volume create "$volume" >/dev/null
  dk run --detach --name "$container" --restart unless-stopped \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume "$volume:/data" \
    --publish 4100:4100 --publish "$sftp_port:2022" \
    --env KILN_RELAY_HOST="$relay_host" \
    ${namespace:+--env KILN_RELAY_RESOURCE_NAMESPACE="$namespace"} \
    ${game_host:+--env KILN_RELAY_GAME_HOST="$game_host"} \
    "$image"
  waited=0
  until [ "$(dk inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null)" = "healthy" ]; do
    waited=$((waited + 2))
    if [ "$waited" -ge 240 ]; then
      dk logs --tail 40 "$container" 2>&1 || true
      stop "The Relay didn't start. Its last lines are in the install log."
    fi
    sleep 2
  done
}

# Whether a domain resolves to this machine's address.
points_here() {
  command -v getent >/dev/null 2>&1 || return 0
  getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | grep -qxF "$address"
}

# The address people will open Kiln at: what they type, or this machine's IP.
choose_url() {
  default="http://$address:$port"
  [ -z "$url" ] || return 0
  if [ "$assume_yes" -eq 1 ] || ! has_terminal; then
    url=$default
    return 0
  fi
  asked=1
  printf '  Kiln will open at %s%s%s\n' "$bold" "$default" "$reset" >/dev/tty
  while :; do
    answer=$(ask "Press Enter, or type a domain you've pointed here:" "")
    case "$answer" in
      "") url=$default; break ;;
      http://* | https://*) url=$answer; break ;;
    esac
    if points_here "$answer"; then
      url="http://$answer:$port"
      break
    fi
    printf '  %s%s doesn'"'"'t point to %s yet.%s\n' "$dim" "$answer" "$address" "$reset" >/dev/tty
  done
  log "url: $url"
}

# ------------------------------------------------------------------- main

if [ "$mode" = "node" ]; then logo "Add this machine"; else logo "Install"; fi

plan_docker
# A stopped Docker starts first, so a rerun still finds what's installed.
if [ "$docker_stopped" -eq 1 ]; then
  say ""
  step "Starting Docker" start_docker
  docker_reachable || fail "Docker didn't start."
  say ""
  asked=0
fi
address=$(public_ip)
[ -n "$address" ] || address="localhost"
log "public address: $address"

# Already here: say so, and show where it's at.
if docker_reachable && dk container inspect "$container" >/dev/null 2>&1; then
  if [ "$mode" = "node" ]; then
    say "  A Relay is already running here. A new invitation to pair it"
    say "  (it expires in 15 minutes):"
    say ""
    dk exec "$container" kiln-relay pair create 2>>"$log_file"
    exit 0
  fi
  say "  Kiln is already installed here."
  say ""
  dk exec "$container" kiln-relay platform status 2>>"$log_file" | sed 's/^/  /'
  setup=$(dk exec "$container" kiln-relay platform setup-url 2>>"$log_file" || true)
  if [ -n "$setup" ]; then
    say ""
    say "  If you haven't created your account yet:"
    say "  $arrow $bold$setup$reset"
  fi
  say ""
  exit 0
fi

if [ "$mode" = "node" ]; then
  if [ -z "$relay_host" ] && [ "$assume_yes" -eq 0 ] && has_terminal; then asked=1; fi
  [ -n "$relay_host" ] ||
    relay_host=$(ask "Address Kiln will reach this machine at [$address]:" "")
  [ -n "$relay_host" ] || relay_host=$address
else
  choose_url
  case "$url" in
    http://* | https://*) ;;
    *) fail "The address must start with http:// or https://" ;;
  esac
fi
[ "$asked" -eq 0 ] || say ""

if [ "$docker_missing" -eq 1 ]; then
  step "Installing Docker" install_docker
  step "Starting Docker" start_docker
  docker_reachable || fail "Docker didn't start."
fi
step "Checking Docker" check_docker
step_progress=pull_progress
step "Downloading Kiln" pull_relay

if [ "$mode" = "node" ]; then
  step "Starting the Relay" start_node_relay
  paired=$(dk exec "$container" kiln-relay pair create 2>>"$log_file" || true)
  # Not the invitation itself: it grants full access to this Relay.
  log "$(printf '%s\n' "$paired" | grep -v '^kiln-relay://' || true)"
  invitation=$(printf '%s\n' "$paired" | grep '^kiln-relay://' | head -n 1 || true)
  [ -n "$invitation" ] ||
    fail "The Relay started, but couldn't make an invitation."
  say ""
  say "  ${green}Ready in $(duration $(($(now) - started_at))).$reset In Kiln, open Relays, choose"
  say "  Add Relay, and paste this (it expires in 15 minutes):"
  say ""
  say "  $invitation"
  say ""
  say "  ${dim}Install log: $log_file$reset"
  say ""
  exit 0
fi

step "Starting Kiln's Relay" start_platform_relay
step "Setting up the database" wait_healthy "$database" 600
step "Starting Kiln" wait_healthy "$hearth" 900

setup=$(dk exec "$container" kiln-relay platform setup-url 2>>"$log_file" || true)
[ -n "$setup" ] || fail "Kiln started, but didn't give a setup link."
log "setup link printed"
say ""
say "  ${green}${bold}Kiln is ready$reset ${dim}in $(duration $(($(now) - started_at)))$reset"
say ""
say "  Open this link to create your account:"
say "  $arrow $bold$setup$reset"
say ""
say "  ${dim}Install log: $log_file$reset"
say ""
