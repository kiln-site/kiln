#!/bin/sh
# Installs Kiln on this machine, and Docker first when it's missing.
#
#   curl -fsSL https://kiln.site/install | sh
#   curl -fsSL https://kiln.site/install | sh -s -- --node
#   curl -fsSL https://kiln.site/install | sh -s -- --node --join '<link>'
#   curl -fsSL https://kiln.site/install | sh -s -- --cli
#
# kiln.site serves this file at /install (apps/marketing/src/routes/install.ts),
# so it's live once the marketing site deploys from main.
#
# It starts one Relay in platform mode, which installs Hearth, its MySQL
# database, and its cache, pairs with that Hearth, and keeps them running.
# With --node it starts a plain Relay instead, to add this machine to an
# existing Kiln; with the --join link from Hearth's Add Relay dialog, that
# Relay connects to Hearth by itself. Run it again to see an installation's
# status. With --cli it installs only the kiln command, on Linux or macOS,
# and needs no Docker.
#
# The terminal shows one line per step. Everything each step ran and printed
# goes to the install log (~/kiln-install.log), for when something fails.
#
# See docs/self-hosting.md in https://github.com/kiln-site/kiln.
set -eu

# Everything runs from main, called on the last line: `sh` reads a piped
# script as it arrives, and a download cut off partway would otherwise run
# the part that arrived. The body isn't indented, to keep the help text's.
main() {

image_prefix="ghcr.io/kiln-site"
repository="kiln-site/kiln"
channel="latest"
container="kiln-relay"
volume="kiln-relay-data"
mode="platform"
url=""
port="3000"
relay_host=""
join=""
game_host=""
image=""
hearth_image=""
namespace=""
bind_address=""
sftp_port="2022"
assume_yes=0
install_docker_allowed=1
asked=0
cli=0
proxy=""

usage() {
  cat <<'EOF'
Usage: curl -fsSL https://kiln.site/install | sh -s -- [options]

  --url URL          Where people will open Kiln, such as
                     https://kiln.example.com (default: https://<this
                     machine's public IP>)
  --proxy MODE       What serves Kiln over HTTPS: traefik (started on
                     ports 80 and 443), coolify (Coolify's proxy), or none
                     (default: coolify on a Coolify server, else traefik)
  --port PORT        Host port Kiln also listens on, without HTTPS
                     (default: 3000)
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
  --join LINK        Join the Kiln whose Add Relay dialog gave this link,
                     instead of printing an invitation (implies --node)
  --cli              Install only the kiln command-line tool, to manage
                     Kiln from this computer (Linux or macOS). With
                     --nightly, the newest nightly; with --url, it shows
                     how to sign in to that Kiln
  --skip-docker-install
                     Don't install Docker if it's missing; stop instead
  -y, --yes          Don't ask; use the defaults for anything not given,
                     and install Docker if it's missing
  -h, --help         Show this help

The install log is ~/kiln-install.log, or KILN_INSTALL_LOG.
KILN_ACME_CA_SERVER sets another ACME directory, such as Let's Encrypt's
staging one, for testing.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) url="${2:?--url needs a value}"; shift 2 ;;
    --proxy) proxy="${2:?--proxy needs a value}"; shift 2 ;;
    --port) port="${2:?--port needs a value}"; shift 2 ;;
    --game-host) game_host="${2:?--game-host needs a value}"; shift 2 ;;
    --relay-host) relay_host="${2:?--relay-host needs a value}"; shift 2 ;;
    --join) join="${2:?--join needs a value}"; mode="node"; shift 2 ;;
    --image) image="${2:?--image needs a value}"; shift 2 ;;
    --hearth-image) hearth_image="${2:?--hearth-image needs a value}"; shift 2 ;;
    --bind) bind_address="${2:?--bind needs a value}"; shift 2 ;;
    --sftp-port) sftp_port="${2:?--sftp-port needs a value}"; shift 2 ;;
    --namespace) namespace="${2:?--namespace needs a value}"; shift 2 ;;
    --nightly) channel="latest-nightly"; shift ;;
    --node) mode="node"; shift ;;
    --cli) cli=1; shift ;;
    --skip-docker-install) install_docker_allowed=0; shift ;;
    -y | --yes) assume_yes=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; printf 'kiln: unknown option %s\n' "$1" >&2; exit 1 ;;
  esac
done

if [ "$cli" -eq 1 ]; then
  [ "$mode" = "platform" ] || {
    printf 'kiln: --cli installs only the CLI. Add a Relay without it.\n' >&2
    exit 1
  }
  mode="cli"
fi

# The link from Hearth's Add Relay dialog: its address, then #kj1. and a
# code. The Relay checks it fully; this only catches a wrong paste early.
if [ -n "$join" ]; then
  case "$join" in
    http://*'#kj1.'* | https://*'#kj1.'*) ;;
    *)
      printf 'kiln: "%s" isn'"'"'t a join link.\n' "$join" >&2
      printf 'Copy the whole command from Add Relay in Hearth; it includes the link.\n' >&2
      exit 1
      ;;
  esac
fi

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
    printf '%s       ▆▆▆▆▆▆▆▆%s\n' "$orange" "$reset"
    printf '%s        ▆▆▆▆▆▆%s\n' "$orange" "$reset"
    printf '%s    ▅▅▅▅▅▅▅▅▅▅▅▅▅▅%s\n' "$orange" "$reset"
    printf '%s    █▆▆▆▆▆█████▃▃█%s\n' "$orange" "$reset"
    printf '%s    ▅▅▅▅▅▅▅▅▅▅▅▅▅▅%s     %sKiln%s\n' "$orange" "$reset" "$bold" "$reset"
    printf '%s    █▆▆▆▆▆█████▃▃█%s     %s%s%s\n' "$orange" "$reset" "$dim" "$1" "$reset"
    printf '%s    ▅▅▅▅▅▅▅▅▅▅▅▅▅▅%s\n' "$orange" "$reset"
    printf '%s    █▆▆▆▆▆█████▃▃█%s\n' "$orange" "$reset"
    printf '%s  ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇%s\n\n' "$orange" "$reset"
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
  if [ -n "${cli_work:-}" ]; then rm -rf "$cli_work"; fi
  if [ "$fancy" -eq 1 ]; then printf '\033[?25h'; fi
  exit "$code"
}
trap on_exit EXIT
trap 'printf "\n"; exit 130' INT TERM

# How far a step has got, as a short bar, or nothing. Set per step.
step_progress=""
# Set for a step the install can do without: it's marked and skipped.
step_soft=0

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
  if [ "$status" -ne 0 ] && [ "$step_soft" -eq 1 ]; then
    step_soft=0
    log "(didn't finish; carrying on)"
    printf '%s  %s!%s %-26s %s%s%s\n' "$clear_line" "$dim" "$reset" "$label" "$dim" "$took" "$reset"
    return 1
  fi
  if [ "$status" -ne 0 ]; then
    log "(failed with status $status)"
    printf '%s  %s%s%s %-26s %s%s%s\n' "$clear_line" "$red" "$cross" "$reset" "$label" "$dim" "$took" "$reset"
    # The reason: the step's own `kiln:` line, else the error Docker or a
    # command gave, so it isn't only in the log.
    output=$(tail -n +"$((step_log_start + 1))" "$log_file")
    reason=$(printf '%s\n' "$output" | sed -n 's/^kiln: //p' | tail -n 1)
    [ -n "$reason" ] || reason=$(printf '%s\n' "$output" |
      sed -n 's/.*Error response from daemon: //p; s/^\(.*[Ee]rror: .*\)$/\1/p' | tail -n 1)
    [ -n "$reason" ] || reason="$label didn't finish."
    fail "$reason"
  fi
  step_soft=0
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

# A line of text from the terminal, or the default, left in $answer. It
# reads in this shell rather than a $( ) one: sudo passes ^C on only to the
# shell it started, which can't stop while it waits on a subshell.
ask() {
  answer=$2
  if [ "$assume_yes" -eq 1 ] || ! has_terminal; then return; fi
  printf '  %s ' "$1" >/dev/tty
  read -r answer </dev/tty || answer=""
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

# Where `docker run` writes the ID of the container it created, so a run
# that fails after creating it, as when a port is taken, removes that one
# container and no other: not a Relay another install started meanwhile.
relay_cidfile=""
new_relay_cidfile() {
  relay_cidfile=$(mktemp -u "${TMPDIR:-/tmp}/kiln-relay-cid.XXXXXX")
}

# Removes that file as whoever ran Docker, which wrote it.
remove_relay_cidfile() {
  case "$docker_cmd" in
    sudo*) sudo rm -f "$relay_cidfile" ;;
    *) rm -f "$relay_cidfile" ;;
  esac
}

# The container the failed run created, if it never ran. The run fails.
remove_unstarted() {
  created=$(cat "$relay_cidfile" 2>/dev/null || true)
  remove_relay_cidfile
  if [ -n "$created" ] &&
    [ "$(dk inspect --format '{{.State.Status}}' "$created" 2>/dev/null)" = "created" ]; then
    # Not forced, so Docker refuses if it started after all.
    dk rm "$created" >/dev/null 2>&1 || true
  fi
  return 1
}

start_platform_relay() {
  dk volume create "$volume" >/dev/null
  new_relay_cidfile
  dk run --detach --cidfile "$relay_cidfile" --name "$container" --restart unless-stopped \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume "$volume:/data" \
    --publish "$sftp_port:2022" \
    --env KILN_RELAY_MODE=platform \
    --env KILN_RELAY_CONTAINER="$container" \
    --env KILN_URL="$url" \
    --env KILN_PLATFORM_HEARTH_PORT="$port" \
    --env KILN_PLATFORM_PROXY="$proxy" \
    ${KILN_ACME_CA_SERVER:+--env KILN_RELAY_ACME_CA_SERVER="$KILN_ACME_CA_SERVER"} \
    ${bind_address:+--env KILN_PLATFORM_HEARTH_BIND="$bind_address"} \
    ${hearth_image:+--env KILN_PLATFORM_HEARTH_IMAGE="$hearth_image"} \
    ${namespace:+--env KILN_RELAY_RESOURCE_NAMESPACE="$namespace"} \
    ${game_host:+--env KILN_RELAY_GAME_HOST="$game_host"} \
    "$image" || remove_unstarted
  remove_relay_cidfile
}

start_node_relay() {
  dk volume create "$volume" >/dev/null
  new_relay_cidfile
  dk run --detach --cidfile "$relay_cidfile" --name "$container" --restart unless-stopped \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume "$volume:/data" \
    --publish 4100:4100 --publish "$sftp_port:2022" \
    --env KILN_RELAY_HOST="$relay_host" \
    ${join:+--env KILN_RELAY_JOIN="$join"} \
    ${namespace:+--env KILN_RELAY_RESOURCE_NAMESPACE="$namespace"} \
    ${game_host:+--env KILN_RELAY_GAME_HOST="$game_host"} \
    "$image" || remove_unstarted
  remove_relay_cidfile
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

# A joining Relay's lines: its container's log, or the `pair join` run on a
# Relay that was already here. The link itself never shows in either.
join_output=""
join_lines() {
  if [ -n "$join_output" ]; then
    cat "$join_output" 2>/dev/null || true
  else
    dk logs "$container" 2>&1 || true
  fi
}

# Waits for a line saying the join got as far as $1, or ended. A join
# that ended badly leaves the Relay's reason as the step's.
wait_join() {
  waited=0
  while [ "$waited" -lt "$2" ]; do
    lines=$(join_lines)
    case "$lines" in
      *"$1"* | *"Paired with Hearth"*) return 0 ;;
      *"join expired"* | *"already joined with this link"* | *"Joining needs"* | *"isn't a join link"*)
        printf 'kiln: %s\n' "$(printf '%s\n' "$lines" | grep -E "expired|already joined|Joining needs|join link" | tail -n 1)"
        return 1
        ;;
    esac
    sleep 2
    waited=$((waited + 2))
  done
  printf 'kiln: %s\n' "The Relay didn't hear from Hearth. Its last line: $(printf '%s\n' "$lines" | tail -n 1)"
  return 1
}
wait_announced() { wait_join "Confirm this Relay in Hearth:" 600; }
wait_confirmed() { wait_join "Paired with Hearth" 1900; }

# Joins Hearth: until Hearth has the Relay, where to confirm it, until
# someone does, then done.
join_hearth() {
  step "Reaching Hearth" wait_announced
  confirm_url=$(join_lines | sed -n 's/.*Confirm this Relay in Hearth: //p' | tail -n 1)
  fingerprint=$(join_lines | sed -n 's/^Joining .* as //p' | tail -n 1)
  if [ -n "$confirm_url" ]; then
    say ""
    say "  Confirm this Relay in Hearth:"
    say "  $arrow $bold$confirm_url$reset"
    [ -z "$fingerprint" ] || say "  ${dim}Fingerprint $fingerprint$reset"
    say ""
    step "Waiting for confirmation" wait_confirmed
  fi
  say ""
  say "  ${green}${bold}Relay added$reset ${dim}in $(duration $(($(now) - started_at)))$reset"
  say ""
  say "  ${dim}Install log: $log_file$reset"
  say ""
}

# Whether a domain resolves to this machine's address.
points_here() {
  command -v getent >/dev/null 2>&1 || return 0
  getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | grep -qxF "$address"
}

# What's listening on a port: a container's name, "another program", or
# nothing.
port_owner() {
  owner=$(dk ps --filter "publish=$1" --format '{{.Names}}' 2>/dev/null | head -n 1)
  if [ -n "$owner" ]; then
    printf '%s' "$owner"
    return
  fi
  # Listening sockets, by port in hex: 0050 is 80.
  if awk 'NR > 1 && $4 == "0A" { split($2, local, ":"); print local[2] }' \
    /proc/net/tcp /proc/net/tcp6 2>/dev/null | grep -qx "$(printf '%04X' "$1")"; then
    printf 'another program'
  fi
}

# What's listening on ports 80 or 443, the same way.
web_ports_owner() {
  for published in 80 443; do
    owner=$(port_owner "$published")
    if [ -n "$owner" ]; then
      printf '%s' "$owner"
      return
    fi
  done
}

# Stops before starting anything when a port the Relay publishes is taken,
# naming what has it, rather than failing halfway through.
check_ports() {
  if [ "$mode" = "node" ]; then
    owner=$(port_owner 4100)
    [ -z "$owner" ] ||
      fail "Port 4100 is in use by $owner, and a Relay needs it for Kiln to reach it."
  fi
  owner=$(port_owner "$sftp_port")
  [ -n "$owner" ] || return 0
  free=$((sftp_port + 1))
  while [ -n "$(port_owner "$free")" ] && [ "$free" -lt $((sftp_port + 100)) ]; do
    free=$((free + 1))
  done
  fail "Port $sftp_port, for SFTP, is in use by $owner. Run this again with --sftp-port $free added to use $free instead."
}

# Which proxy gives Kiln HTTPS: Coolify's on a Coolify server, otherwise
# Traefik on ports 80 and 443 when they're free.
choose_proxy() {
  case "$proxy" in
    traefik | coolify | none) return 0 ;;
    "") ;;
    *) fail "--proxy must be traefik, coolify, or none." ;;
  esac
  if docker_reachable &&
    [ "$(dk inspect --format '{{.State.Running}}' coolify-proxy 2>/dev/null)" = "true" ]; then
    proxy=coolify
    say "  Coolify is running here, so Kiln will use its proxy."
    asked=1
    return 0
  fi
  owner=$(web_ports_owner)
  if [ -z "$owner" ]; then
    proxy=traefik
    return 0
  fi
  log "ports 80/443 are used by: $owner"
  say "  Port 80 or 443 is already in use by $owner,"
  say "  so Kiln can't set up HTTPS."
  asked=1
  confirm "Use http://$address:$port instead?" ||
    fail "Free ports 80 and 443, then run this again."
  proxy=none
}

# The address people will open Kiln at: what they type, or this machine's IP.
# With a proxy that's https, without a port; without one, Kiln's own port.
choose_url() {
  [ -z "$url" ] || return 0
  case "$proxy" in
    traefik) default="https://$address" ;;
    *) default="http://$address:$port" ;;
  esac
  if [ "$assume_yes" -eq 1 ] || ! has_terminal; then
    url=$default
    return 0
  fi
  asked=1
  printf '  Kiln will open at %s%s%s\n' "$bold" "$default" "$reset" >/dev/tty
  while :; do
    ask "Press Enter, or type a domain you've pointed here:" ""
    case "$answer" in
      "") url=$default; break ;;
      http://* | https://*) url=$answer; break ;;
    esac
    if points_here "$answer"; then
      if [ "$proxy" = "none" ]; then
        url="http://$answer:$port"
      else
        url="https://$answer"
      fi
      break
    fi
    printf '  %s%s doesn'"'"'t point to %s yet.%s\n' "$dim" "$answer" "$address" "$reset" >/dev/tty
  done
  log "url: $url"
}

# Waits for Kiln's address to answer over HTTPS with a valid certificate,
# which the proxy gets from Let's Encrypt once Hearth is up.
wait_https() {
  insecure=""
  # A test directory's certificates aren't trusted.
  [ -z "${KILN_ACME_CA_SERVER:-}" ] || insecure="-k"
  waited=0
  until curl -fsS $insecure --max-time 5 -o /dev/null "$url/" 2>/dev/null; do
    waited=$((waited + 3))
    if [ "$waited" -ge 180 ]; then
      curl -sS $insecure --max-time 5 -o /dev/null "$url/" || true
      stop "HTTPS isn't working yet."
    fi
    sleep 3
  done
}

# -------------------------------------------------------------------- CLI

# This machine's CLI build, as releases name it, or nothing. A shell under
# Rosetta reports x86_64 on Apple silicon, which has its own build.
cli_platform() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) return 0 ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) return 0 ;;
  esac
  if [ "$os" = "darwin" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
    arch=arm64
  fi
  printf '%s-%s' "$os" "$arch"
}

# Where the CLI goes: a directory root's PATH has, else the user's own, so
# `kiln update` can replace it without sudo.
cli_directory() {
  if [ "$(id -u)" -eq 0 ]; then
    printf '/usr/local/bin'
  else
    printf '%s/.local/bin' "$HOME"
  fi
}

# Asks GitHub for releases, into $cli_work/answer, and prints the HTTP
# status: 000 when GitHub didn't answer.
github_releases() {
  curl -sSL --max-time 30 -H 'Accept: application/vnd.github+json' \
    -o "$cli_work/answer" -w '%{http_code}' \
    "https://api.github.com/repos/$repository/$1" 2>>"$log_file" || true
}

# The CLI builds for this machine in GitHub's answer, one line each: tag,
# whether it's a prerelease, size, SHA-256 digest, and URL. Every key starts
# a line first, so this doesn't depend on how GitHub lays out its JSON.
cli_builds() {
  tr '\n' ' ' <"$cli_work/answer" | awk '{ gsub(/"[a-z_]+"[ ]*:/, "\n&"); print }' |
    awk -v platform="$cli_platform" '
      function value(line) {
        sub(/^"[a-z_]+"[ ]*:[ ]*/, "", line)
        if (line ~ /^"/) { line = substr(line, 2); sub(/".*$/, "", line) }
        else sub(/[^a-z0-9]+.*$/, "", line)
        return line
      }
      /^"tag_name"/ { tag = value($0) }
      /^"draft"/ { draft = value($0) }
      /^"prerelease"/ { prerelease = value($0) }
      /^"name"/ { name = value($0); size = ""; digest = "" }
      /^"size"/ { size = value($0) }
      /^"digest"/ { digest = value($0) }
      /^"browser_download_url"/ {
        if (draft == "false" && name == "kiln-" tag "-" platform)
          print tag, prerelease, size, digest, value($0)
      }
    '
}

# Picks the newest stable CLI, or with --nightly the newest nightly. Until
# Kiln's first stable release, the newest nightly stands in for it, as the
# images' `latest` tag does. A release can be up before its CLI builds
# are, so it's the newest one with this machine's build.
find_cli() {
  status=404
  [ "$channel" != "latest" ] || status=$(github_releases releases/latest)
  nightly=false
  if [ "$status" = 404 ]; then
    nightly=true
    status=$(github_releases 'releases?per_page=100')
  fi
  log "GitHub answered HTTP $status"
  case "$status" in
    200) ;;
    403 | 429) stop "GitHub is limiting requests from this address. Try again in an hour." ;;
    000) stop "Couldn't reach GitHub. Check this computer is online." ;;
    *) stop "GitHub didn't list Kiln's releases (HTTP $status). Try again later." ;;
  esac
  release=$(cli_builds | awk -v nightly="$nightly" '
    $2 == nightly && $1 ~ /^v[0-9]+\.[0-9]+\.[0-9]+(-nightly\.[0-9]+\.[0-9]+)?$/ &&
      ($1 ~ /-nightly\./) == (nightly == "true") { print; exit }
  ')
  [ -n "$release" ] ||
    stop "There's no CLI for $cli_platform in the newest release yet. Try again in a few minutes."
  # shellcheck disable=SC2086 # the release's fields
  set -- $release
  case "$3" in "" | *[!0-9]*) stop "GitHub listed the CLI without its size." ;; esac
  printf '%s\n' "$4" | grep -Eq '^sha256:[0-9a-f]{64}$' ||
    stop "GitHub listed the CLI without its SHA-256 digest."
  [ "$5" = "https://github.com/$repository/releases/download/$1/kiln-$1-$cli_platform" ] ||
    stop "GitHub listed the CLI at an unexpected address."
  printf '%s\n' "$release" >"$cli_work/release"
  log "release: $release"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{ print $NF }'
  else
    stop "Checking the CLI needs sha256sum, shasum, or openssl."
  fi
}

# How much of the CLI has arrived, as a bar.
cli_progress() {
  [ -f "$cli_work/kiln" ] || return 0
  progress_bar "$(wc -c <"$cli_work/kiln" | tr -d ' ')" "$cli_size"
}

# Downloads the CLI and checks it's the build GitHub listed, and that it runs
# here and is the version it should be.
download_cli() {
  curl -fsSL --max-time 600 -o "$cli_work/kiln" "$cli_url" ||
    stop "Couldn't download the CLI. Check this computer can reach github.com."
  [ "$(wc -c <"$cli_work/kiln" | tr -d ' ')" = "$cli_size" ] &&
    [ "sha256:$(sha256_of "$cli_work/kiln")" = "$cli_digest" ] ||
    stop "The CLI didn't download intact. Run this again."
  chmod 755 "$cli_work/kiln"
  reported=$("$cli_work/kiln" --version 2>&1) ||
    stop "The CLI doesn't run on this computer: $reported"
  [ "$reported" = "kiln $cli_version" ] ||
    stop "The CLI reports \"$reported\", not kiln $cli_version."
}

# Into place in one step, so a `kiln` running meanwhile keeps working. A
# link there goes first: mv would follow one to a directory, and `kiln
# update` replaces the file a link points to, which may need sudo.
place_cli() {
  [ ! -L "$cli_dir/kiln" ] || rm -f "$cli_dir/kiln"
  mv -f "$cli_work/kiln" "$cli_dir/kiln" ||
    stop "Couldn't install the CLI into $cli_dir."
}

# Whether release version $1 is newer than $2, ordered as Kiln orders them:
# by number, then a stable release after its nightlies, then the newer
# nightly.
newer_version() {
  awk -v left="$1" -v right="$2" '
    function key(version,   part, count, rank) {
      count = split(version, part, "[.-]")
      rank = count == 3 ? 2 : count == 6 ? 1 : 0
      return sprintf("%010d%010d%010d%d%010d%010d", part[1], part[2], part[3], rank, part[5], part[6])
    }
    BEGIN { exit !(key(left) > key(right)) }
  '
}

# The version of the CLI already in $cli_dir, or nothing. Only a binary of
# its own counts, not a link to one elsewhere.
installed_cli() {
  [ -f "$cli_dir/kiln" ] && [ ! -L "$cli_dir/kiln" ] && [ -x "$cli_dir/kiln" ] || return 0
  "$cli_dir/kiln" --version 2>/dev/null | sed -n 's/^kiln //p' | head -n 1 |
    grep -E '^[0-9]+\.[0-9]+\.[0-9]+(-nightly\.[0-9]+(\.[0-9]+)?)?$' || true
}

install_cli() {
  cli_platform=$(cli_platform)
  [ -n "$cli_platform" ] ||
    fail "Kiln's CLI runs on Linux and macOS (x64 or ARM64), not $(uname -sm). On Windows, download kiln.exe from https://github.com/$repository/releases"
  # Its Linux builds need glibc, which musl systems such as Alpine don't have.
  case "$cli_platform" in
    linux-*)
      getconf GNU_LIBC_VERSION >/dev/null 2>&1 ||
        fail "Kiln's CLI needs glibc, which this system doesn't have (as on Alpine)."
      ;;
  esac
  command -v curl >/dev/null 2>&1 || fail "Installing the CLI needs curl."
  cli_dir=$(cli_directory)
  log "cli: $cli_platform into $cli_dir"
  mkdir -p "$cli_dir" 2>/dev/null && [ -w "$cli_dir" ] ||
    fail "Can't write to $cli_dir. Run this again as root, or as its owner."
  if [ -d "$cli_dir/kiln" ] && [ ! -L "$cli_dir/kiln" ]; then
    fail "$cli_dir/kiln is a directory. Move it, then run this again."
  fi
  # Beside where it goes, so moving it there can't be a copy across disks.
  cli_work=$(mktemp -d "$cli_dir/.kiln-install.XXXXXX") ||
    fail "Can't write to $cli_dir."

  step "Finding the newest CLI" find_cli
  # shellcheck disable=SC2046 # the release's fields
  set -- $(cat "$cli_work/release")
  cli_version=${1#v} cli_size=$3 cli_digest=$4 cli_url=$5

  # A newer CLI stays, such as a nightly when this found a stable release.
  installed=$(installed_cli)
  if [ "$installed" = "$cli_version" ]; then
    say ""
    say "  ${green}${bold}Kiln CLI $cli_version$reset is already installed in $cli_dir."
  elif [ -n "$installed" ] && newer_version "$installed" "$cli_version"; then
    say ""
    say "  ${green}${bold}Kiln CLI $installed$reset is already installed in $cli_dir."
    say "  It's newer than $cli_version, so it stays. To install that"
    say "  version instead, delete $cli_dir/kiln and run this again."
  else
    step_progress=cli_progress
    step "Downloading the CLI" download_cli
    step "Installing the CLI" place_cli
    say ""
    say "  ${green}${bold}Kiln CLI $cli_version is ready$reset ${dim}in $(duration $(($(now) - started_at)))$reset"
  fi
  say ""

  # The kiln this shell finds first, if not this one.
  case ":$PATH:" in
    *":$cli_dir:"*)
      found=$(command -v kiln 2>/dev/null || true)
      if [ -n "$found" ] && [ "$found" != "$cli_dir/kiln" ]; then
        say "  ${dim}Another kiln comes first on your PATH: $found$reset"
        say "  ${dim}Remove it to use this one.$reset"
        say ""
      fi
      ;;
    *)
      # shellcheck disable=SC2088 # shown, not expanded
      case "${SHELL:-}" in
        */zsh) profile="~/.zshrc" ;;
        */bash)
          profile="~/.bashrc"
          # macOS's Terminal starts bash as a login shell, which reads the
          # first of these it finds and not ~/.bashrc.
          if [ "$(uname -s)" = "Darwin" ]; then
            profile="~/.bash_profile"
            for file in .bash_profile .bash_login .profile; do
              if [ -f "$HOME/$file" ]; then
                profile="~/$file"
                break
              fi
            done
          fi
          ;;
        *) profile="your shell's profile" ;;
      esac
      say "  $cli_dir isn't on your PATH yet. Add this line to $profile,"
      say "  then open a new terminal:"
      say "  $arrow ${bold}export PATH=\"$cli_dir:\$PATH\"$reset"
      say ""
      ;;
  esac
  if [ -n "$url" ]; then
    say "  Sign in to $url:"
    say "  $arrow ${bold}kiln login $url$reset"
  else
    say "  Sign in with your Kiln's address:"
    say "  $arrow ${bold}kiln login https://kiln.example.com$reset"
  fi
  say ""
  say "  ${dim}Update it later with kiln update. Install log: $log_file$reset"
  say ""
}

# ------------------------------------------------------------------- main

if [ "$mode" = "cli" ]; then
  logo "Install the CLI"
  install_cli
  exit 0
fi
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

# A Relay container that never started, left by an install that failed
# before it could, isn't a Relay; its volume, if any, stays. Removed by the
# ID inspected, and not forced, so Docker refuses if another install
# started it meanwhile.
if docker_reachable; then
  unstarted=$(dk inspect --format '{{if eq .State.Status "created"}}{{.Id}}{{end}}' "$container" 2>/dev/null || true)
  if [ -n "$unstarted" ]; then
    log "removing $container, which never started"
    dk rm "$unstarted" >/dev/null 2>&1 || true
  fi
fi

# Already here: say so, and show where it's at.
if docker_reachable && dk container inspect "$container" >/dev/null 2>&1; then
  if [ -n "$join" ]; then
    [ "$(dk inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" = "true" ] ||
      fail "A Relay is installed here but stopped. Start it with \`docker start $container\`, then run this again."
    dk exec "$container" kiln-relay pair join --check >/dev/null 2>&1 ||
      fail "This Relay is older than joining needs. Update it, or pair it by hand: run \`docker exec $container kiln-relay pair create\` and paste the link into Hearth's Pairing link tab."
    say "  A Relay is already running here; joining it to that Kiln."
    say ""
    join_output=$(mktemp)
    dk exec "$container" kiln-relay pair join "$join" >"$join_output" 2>&1 &
    join_hearth
    exit 0
  fi
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
  # Joining, Hearth's Add Relay dialog already asked, and filled in
  # --relay-host when someone changed it.
  if [ -z "$relay_host" ] && [ -z "$join" ]; then
    if [ "$assume_yes" -eq 0 ] && has_terminal; then asked=1; fi
    ask "Address Kiln will reach this machine at [$address]:" ""
    relay_host=$answer
  fi
  [ -n "$relay_host" ] || relay_host=$address
else
  choose_proxy
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
check_ports
step_progress=pull_progress
step "Downloading Kiln" pull_relay

# A Relay release older than joining starts fine but ignores the link, so
# it's asked first and falls back to an invitation to paste.
if [ "$mode" = "node" ] && [ -n "$join" ]; then
  step "Starting the Relay" start_node_relay
  if ! dk exec "$container" kiln-relay pair join --check >/dev/null 2>&1; then
    log "this Relay can't join; printing an invitation instead"
    join=""
    say ""
    say "  This Relay version can't join by itself yet."
  fi
fi

if [ "$mode" = "node" ] && [ -n "$join" ]; then
  join_hearth
  exit 0
fi

if [ "$mode" = "node" ]; then
  # Unless it was started above to join, and couldn't.
  dk container inspect "$container" >/dev/null 2>&1 ||
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
https_ok=1
case "$url" in
  https://*)
    if command -v curl >/dev/null 2>&1 && [ "$proxy" != "none" ]; then
      # Kiln works without it, at its own port; the proxy keeps trying.
      step_soft=1
      step "Turning on HTTPS" wait_https || https_ok=0
    fi
    ;;
esac

setup=$(dk exec "$container" kiln-relay platform setup-url 2>>"$log_file" || true)
[ -n "$setup" ] || fail "Kiln started, but didn't give a setup link."
log "setup link printed"
say ""
say "  ${green}${bold}Kiln is ready$reset ${dim}in $(duration $(($(now) - started_at)))$reset"
say ""
say "  Open this link to create your account:"
say "  $arrow $bold$setup$reset"
say ""
if [ "$https_ok" -eq 0 ]; then
  say "  ${dim}HTTPS can take a few minutes. Until then Kiln is at$reset"
  say "  ${dim}http://$address:$port$reset"
  say ""
fi
say "  ${dim}Install log: $log_file$reset"
say ""
}

main "$@"
