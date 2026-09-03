#!/usr/bin/env bash

set -Eeuo pipefail

INSTALL_DIR="${KILN_INSTALL_DIR:-/opt/kiln}"
ENV_FILE="${INSTALL_DIR}/.env"
COMPOSE_FILE="${INSTALL_DIR}/compose.yaml"
PROXY_COMPOSE_FILE="${INSTALL_DIR}/compose.proxy.yaml"
INSTALL_MARKER_FILE="${INSTALL_DIR}/.installed"
DRY_RUN="${KILN_INSTALL_DRY_RUN:-false}"
SKIP_PULL="${KILN_INSTALL_SKIP_PULL:-false}"
MODE=""
PROXY="${KILN_PROXY:-auto}"
PROXY_REQUESTED="$([[ -n "${KILN_PROXY:-}" ]] && printf true || printf false)"
DOMAIN="${KILN_DOMAIN:-}"
HEARTH_HOST="${KILN_HEARTH_HOST:-}"
RELAY_HOST="${KILN_RELAY_HOST:-}"
HEARTH_HOST_REQUESTED="$([[ -n "${KILN_HEARTH_HOST:-}" ]] && printf true || printf false)"
RELAY_HOST_REQUESTED="$([[ -n "${KILN_RELAY_HOST:-}" ]] && printf true || printf false)"
GAME_HOST="${KILN_RELAY_GAME_HOST:-}"
ACME_EMAIL="${KILN_ACME_EMAIL:-}"
ACME_EMAIL_REQUESTED="$([[ -n "${KILN_ACME_EMAIL+x}" ]] && printf true || printf false)"
RELAY_PORT=""
SFTP_PORT=""
GAME_PORT_RANGE=""
SFTP_PUBLISH_ADDRESS=""
TRAEFIK_IMAGE="traefik:v3.6.6"
TEMP_FILES=()

log() {
  printf '\n\033[1;36mKiln\033[0m %s\n' "$*"
}

warn() {
  printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2
}

die() {
  printf '\033[1;31mError:\033[0m %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local path
  for path in "${TEMP_FILES[@]:-}"; do
    if [[ -n "$path" && -f "$path" ]]; then
      rm -f -- "$path"
    fi
  done
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Install or repair Kiln on a Linux host.

Usage:
  install.sh kiln [options]    Install Hearth and a provisioning Relay
  install.sh hearth [options]  Install Hearth with a non-provisioning Relay
  install.sh relay [options]   Install a Relay and print a pairing URI

Options:
  --proxy auto|coolify|traefik  Select the HTTPS edge (default: auto)
  --domain example.com          Use hearth.example.com and relay.example.com
  --hearth-host HOST            Set the Hearth hostname
  --relay-host HOST             Set the Relay hostname
  --acme-email EMAIL            Set the Let's Encrypt contact email
  -h, --help                    Show this help

The same command is safe to rerun. It recreates application containers while
preserving /opt/kiln/.env, the MySQL volume, and all Relay state.
EOF
}

parse_arguments() {
  [[ $# -gt 0 ]] || die "Choose an install mode: kiln, hearth, or relay."
  MODE="$1"
  shift
  case "$MODE" in
    kiln | hearth | relay) ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "Unknown install mode '$MODE'. Choose kiln, hearth, or relay." ;;
  esac

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --proxy)
        [[ $# -ge 2 ]] || die "--proxy requires a value."
        PROXY="$2"
        PROXY_REQUESTED=true
        shift 2
        ;;
      --domain)
        [[ $# -ge 2 ]] || die "--domain requires a value."
        DOMAIN="$2"
        shift 2
        ;;
      --hearth-host)
        [[ $# -ge 2 ]] || die "--hearth-host requires a value."
        HEARTH_HOST="$2"
        HEARTH_HOST_REQUESTED=true
        shift 2
        ;;
      --relay-host)
        [[ $# -ge 2 ]] || die "--relay-host requires a value."
        RELAY_HOST="$2"
        RELAY_HOST_REQUESTED=true
        shift 2
        ;;
      --acme-email)
        [[ $# -ge 2 ]] || die "--acme-email requires a value."
        ACME_EMAIL="$2"
        ACME_EMAIL_REQUESTED=true
        shift 2
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "Unknown option '$1'." ;;
    esac
  done

  case "$PROXY" in
    auto | coolify | traefik) ;;
    *) die "--proxy must be auto, coolify, or traefik." ;;
  esac
}

check_platform() {
  if [[ "$DRY_RUN" == "true" ]]; then
    return
  fi
  [[ "$(id -u)" -eq 0 ]] || die "Run this installer as root (usually with sudo)."
  [[ "$(uname -s)" == "Linux" ]] || die "Kiln's installer currently supports Linux only."
  case "$(uname -m)" in
    x86_64 | amd64 | aarch64 | arm64) ;;
    *) die "Kiln supports x86_64 and arm64 Linux hosts." ;;
  esac
  command -v curl >/dev/null 2>&1 || die "curl is required to install Kiln."
}

acquire_lock() {
  if [[ "$DRY_RUN" == "true" ]]; then
    return
  fi
  command -v flock >/dev/null 2>&1 || die "flock is required to serialize Kiln installation."
  exec 9>/run/lock/kiln-installer.lock
  flock -n 9 || die "Another Kiln installer is already running."
}

docker_is_valid() {
  command -v docker >/dev/null 2>&1 || return 1
  local endpoint
  endpoint="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)}"
  [[ "$endpoint" == "unix:///var/run/docker.sock" || "$endpoint" == "unix:///run/docker.sock" ]] || return 1
  docker info --format '{{.OSType}}' 2>/dev/null | grep -qx linux || return 1
  docker compose version >/dev/null 2>&1 || return 1
  local major
  major="$(docker version --format '{{.Server.Version}}' 2>/dev/null | cut -d. -f1)"
  [[ "$major" =~ ^[0-9]+$ && "$major" -ge 24 ]]
}

install_docker() {
  if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then
    die "Snap Docker is not supported. Remove it before installing the system Docker Engine."
  fi

  if docker_is_valid; then
    log "Using Docker $(docker version --format '{{.Server.Version}}')."
    return
  fi

  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    local endpoint
    endpoint="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)}"
    if [[ "$endpoint" != "unix:///var/run/docker.sock" && "$endpoint" != "unix:///run/docker.sock" ]]; then
      die "Kiln requires the system Docker Engine at /var/run/docker.sock; rootless and remote Docker contexts are not supported."
    fi
  fi

  if command -v systemctl >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
    systemctl enable --now docker >/dev/null 2>&1 || true
    if docker_is_valid; then
      log "Started the existing Docker Engine."
      return
    fi
  fi

  log "Installing Docker Engine and Compose."
  local docker_installer
  docker_installer="$(mktemp)"
  TEMP_FILES+=("$docker_installer")
  curl --proto '=https' --tlsv1.2 -fsSL https://get.docker.com -o "$docker_installer"
  sh "$docker_installer"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker
  fi
  docker_is_valid || die "Docker was installed but its Linux daemon or Compose v2 is not ready."
}

read_env() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
}

set_env() {
  local key="$1"
  local value="$2"
  local target="$3"
  local escaped
  escaped="$(printf '%s' "$value" | sed 's/[&|\\]/\\&/g')"
  if grep -q "^${key}=" "$target" 2>/dev/null; then
    sed -i.bak "s|^${key}=.*$|${key}=${escaped}|" "$target"
    rm -f -- "${target}.bak"
  else
    printf '%s=%s\n' "$key" "$value" >>"$target"
  fi
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

valid_hostname() {
  local hostname="$1"
  [[ ${#hostname} -le 253 ]] || return 1
  [[ "$hostname" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || return 1
  [[ "$hostname" == *.* ]] || return 1
  [[ "$hostname" != *..* ]]
}

valid_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]]
}

valid_game_port_range() {
  local range="$1"
  [[ "$range" =~ ^([0-9]+)-([0-9]+)$ ]] || return 1
  local first="${BASH_REMATCH[1]}"
  local last="${BASH_REMATCH[2]}"
  valid_port "$first" && valid_port "$last" && [[ "$first" -le "$last" ]]
}

prompt_value() {
  local prompt="$1"
  local value=""
  if [[ -r /dev/tty && -w /dev/tty ]]; then
    printf '%s: ' "$prompt" >/dev/tty
    IFS= read -r value </dev/tty
  fi
  printf '%s' "$value"
}

resolve_hosts() {
  local saved_hearth saved_relay
  saved_hearth="$(read_env KILN_HEARTH_HOST)"
  saved_relay="$(read_env KILN_RELAY_HOST)"
  [[ "$saved_hearth" != "hearth.invalid" ]] || saved_hearth=""
  if [[ -n "$DOMAIN" ]]; then
    [[ "$HEARTH_HOST_REQUESTED" == "true" ]] || HEARTH_HOST="hearth.${DOMAIN}"
    [[ "$RELAY_HOST_REQUESTED" == "true" ]] || RELAY_HOST="relay.${DOMAIN}"
  else
    [[ -n "$HEARTH_HOST" ]] || HEARTH_HOST="$saved_hearth"
    [[ -n "$RELAY_HOST" ]] || RELAY_HOST="$saved_relay"
  fi

  if [[ -z "$RELAY_HOST" ]]; then
    RELAY_HOST="$(prompt_value "Public Relay hostname (for example relay.example.com)")"
  fi
  [[ -n "$RELAY_HOST" ]] || die "Set KILN_DOMAIN or KILN_RELAY_HOST for a non-interactive install."

  if [[ "$MODE" != "relay" && -z "$HEARTH_HOST" ]]; then
    HEARTH_HOST="$(prompt_value "Public Hearth hostname (for example hearth.example.com)")"
  fi
  if [[ "$MODE" == "relay" && -z "$HEARTH_HOST" ]]; then
    HEARTH_HOST="hearth.invalid"
  fi
  [[ -n "$HEARTH_HOST" ]] || die "Set KILN_DOMAIN or KILN_HEARTH_HOST for a non-interactive install."

  HEARTH_HOST="$(printf '%s' "$HEARTH_HOST" | tr '[:upper:]' '[:lower:]')"
  RELAY_HOST="$(printf '%s' "$RELAY_HOST" | tr '[:upper:]' '[:lower:]')"
  valid_hostname "$HEARTH_HOST" || die "Invalid Hearth hostname '$HEARTH_HOST'."
  valid_hostname "$RELAY_HOST" || die "Invalid Relay hostname '$RELAY_HOST'."
  [[ "$HEARTH_HOST" != "$RELAY_HOST" ]] || die "Hearth and Relay need different hostnames."
  if [[ -f "$INSTALL_MARKER_FILE" && -n "$saved_hearth" && "$HEARTH_HOST" != "$saved_hearth" ]]; then
    die "Changing an installed Hearth hostname is not yet supported because it requires rotating the Relay client origin. Keep $saved_hearth or perform a documented migration."
  fi
  if [[ -f "$INSTALL_MARKER_FILE" && -n "$saved_relay" && "$RELAY_HOST" != "$saved_relay" ]]; then
    die "Changing an installed Relay hostname is not yet supported. Keep $saved_relay or perform a documented migration."
  fi
}

coolify_available() {
  docker inspect coolify-proxy --format '{{.State.Running}} {{.Config.Image}}' 2>/dev/null |
    grep -Eq '^true traefik(:|@)' || return 1
  docker network inspect coolify >/dev/null 2>&1
}

resolve_proxy() {
  local saved_proxy="$1"
  if [[ "$PROXY" == "auto" && "$PROXY_REQUESTED" != "true" ]] &&
    [[ "$saved_proxy" == "coolify" || "$saved_proxy" == "traefik" ]]; then
    PROXY="$saved_proxy"
  elif [[ "$DRY_RUN" == "true" && "$PROXY" == "auto" ]]; then
    PROXY="traefik"
  elif [[ "$PROXY" == "auto" ]]; then
    if coolify_available; then
      PROXY="coolify"
    else
      PROXY="traefik"
    fi
  fi
  if [[ "$PROXY" == "coolify" && "$DRY_RUN" != "true" ]] && ! coolify_available; then
    die "Coolify mode requires a running official Traefik container named coolify-proxy and the coolify network."
  fi
}

prepare_directory() {
  umask 077
  [[ ! -L "$INSTALL_DIR" ]] || die "$INSTALL_DIR must not be a symbolic link."
  install -d -m 700 "$INSTALL_DIR"
  [[ ! -L "$ENV_FILE" ]] || die "$ENV_FILE must not be a symbolic link."
  [[ ! -L "$INSTALL_MARKER_FILE" ]] || die "$INSTALL_MARKER_FILE must not be a symbolic link."
  local env_work
  env_work="$(mktemp "${INSTALL_DIR}/.env.XXXXXX")"
  TEMP_FILES+=("$env_work")
  if [[ -f "$ENV_FILE" ]]; then
    cp -p "$ENV_FILE" "$env_work"
  fi

  local db_password mysql_root_password auth_secret backup_key bootstrap_token installation_id
  local saved_mode publish_address sftp_publish_address
  db_password="$(read_env DB_PASSWORD)"
  mysql_root_password="$(read_env MYSQL_ROOT_PASSWORD)"
  auth_secret="$(read_env BETTER_AUTH_SECRETS)"
  backup_key="$(read_env KILN_PLATFORM_BACKUP_KEY)"
  bootstrap_token="$(read_env KILN_RELAY_BOOTSTRAP_TOKEN)"
  installation_id="$(read_env KILN_INSTALLATION_ID)"
  saved_mode="$(read_env KILN_INSTALL_MODE)"

  if [[ "$DRY_RUN" != "true" ]] && docker volume inspect kiln-hearth-mysql >/dev/null 2>&1; then
    [[ -n "$db_password" && -n "$mysql_root_password" && -n "$auth_secret" && -n "$backup_key" && -n "$installation_id" ]] ||
      die "The existing Kiln MySQL volume has incomplete credentials or no KILN_INSTALLATION_ID in $ENV_FILE; refusing to replace its identity or secrets."
  fi

  [[ -n "$db_password" ]] || db_password="$(generate_secret)"
  [[ -n "$mysql_root_password" ]] || mysql_root_password="$(generate_secret)"
  [[ -n "$auth_secret" ]] || auth_secret="1:$(generate_secret)"
  [[ -n "$backup_key" ]] || backup_key="$(generate_secret)"
  [[ -n "$bootstrap_token" ]] || bootstrap_token="$(generate_secret)"
  [[ -n "$installation_id" ]] || installation_id="kiln-$(generate_secret | cut -c1-24)"

  set_env COMPOSE_PROJECT_NAME kiln "$env_work"
  set_env KILN_INSTALL_MODE "$MODE" "$env_work"
  set_env KILN_INSTALLATION_ID "$installation_id" "$env_work"
  set_env DB_PASSWORD "$db_password" "$env_work"
  set_env MYSQL_ROOT_PASSWORD "$mysql_root_password" "$env_work"
  set_env BETTER_AUTH_SECRETS "$auth_secret" "$env_work"
  set_env KILN_PLATFORM_BACKUP_KEY "$backup_key" "$env_work"
  set_env KILN_RELAY_BOOTSTRAP_TOKEN "$bootstrap_token" "$env_work"
  set_env KILN_HEARTH_HOST "$HEARTH_HOST" "$env_work"
  if [[ "$MODE" == "relay" ]]; then
    set_env KILN_HEARTH_PUBLIC_URL "" "$env_work"
    set_env KILN_HEARTH_INTERNAL_URL "" "$env_work"
  else
    set_env KILN_HEARTH_PUBLIC_URL "https://${HEARTH_HOST}" "$env_work"
    set_env KILN_HEARTH_INTERNAL_URL "http://hearth:3000" "$env_work"
  fi
  set_env KILN_RELAY_HOST "$RELAY_HOST" "$env_work"
  set_env KILN_RELAY_PUBLIC_URL "https://${RELAY_HOST}" "$env_work"
  if [[ -z "$GAME_HOST" ]]; then
    local saved_game_host saved_relay_host
    saved_game_host="$(read_env KILN_RELAY_GAME_HOST)"
    saved_relay_host="$(read_env KILN_RELAY_HOST)"
    if [[ ! -f "$INSTALL_MARKER_FILE" ]] &&
      [[ -n "$saved_relay_host" && "$saved_game_host" == "$saved_relay_host" ]]; then
      GAME_HOST="$RELAY_HOST"
    else
      GAME_HOST="$saved_game_host"
    fi
  fi
  [[ -n "$GAME_HOST" ]] || GAME_HOST="$RELAY_HOST"
  ACME_EMAIL="${ACME_EMAIL:-$(read_env KILN_RELAY_ACME_EMAIL)}"
  RELAY_PORT="${KILN_RELAY_PORT:-$(read_env KILN_RELAY_PORT)}"
  SFTP_PORT="${KILN_RELAY_SFTP_PORT:-$(read_env KILN_RELAY_SFTP_PORT)}"
  GAME_PORT_RANGE="${KILN_RELAY_GAME_PORT_RANGE:-$(read_env KILN_RELAY_GAME_PORT_RANGE)}"
  publish_address="${KILN_RELAY_PUBLISH_ADDRESS:-$(read_env KILN_RELAY_PUBLISH_ADDRESS)}"
  if [[ "$MODE" == "hearth" ]]; then
    sftp_publish_address="127.0.0.1"
  elif [[ -n "${KILN_RELAY_SFTP_PUBLISH_ADDRESS:-}" ]]; then
    sftp_publish_address="$KILN_RELAY_SFTP_PUBLISH_ADDRESS"
  elif [[ "$saved_mode" != "hearth" ]]; then
    sftp_publish_address="$(read_env KILN_RELAY_SFTP_PUBLISH_ADDRESS)"
  else
    sftp_publish_address=""
  fi
  RELAY_PORT="${RELAY_PORT:-4100}"
  SFTP_PORT="${SFTP_PORT:-2022}"
  GAME_PORT_RANGE="${GAME_PORT_RANGE:-30000-39999}"
  publish_address="${publish_address:-127.0.0.1}"
  sftp_publish_address="${sftp_publish_address:-0.0.0.0}"
  [[ "$GAME_HOST" == "public-ip" ]] || valid_hostname "$GAME_HOST" ||
    die "Invalid game-server hostname '$GAME_HOST'."
  valid_port "$RELAY_PORT" || die "KILN_RELAY_PORT must be between 1 and 65535."
  valid_port "$SFTP_PORT" || die "KILN_RELAY_SFTP_PORT must be between 1 and 65535."
  valid_game_port_range "$GAME_PORT_RANGE" ||
    die "KILN_RELAY_GAME_PORT_RANGE must be an ascending range between 1 and 65535."
  [[ "$publish_address" == "127.0.0.1" ]] ||
    die "KILN_RELAY_PUBLISH_ADDRESS must be 127.0.0.1 when Coolify or bundled Traefik terminates TLS."
  [[ "$sftp_publish_address" == "127.0.0.1" || "$sftp_publish_address" == "0.0.0.0" ]] ||
    die "KILN_RELAY_SFTP_PUBLISH_ADDRESS must be 127.0.0.1 or 0.0.0.0."
  if [[ -n "$ACME_EMAIL" ]]; then
    [[ "$ACME_EMAIL" != *[[:space:]]* && "$ACME_EMAIL" == *@*.* ]] ||
      die "KILN_ACME_EMAIL must be a valid email address."
  fi
  set_env KILN_RELAY_GAME_HOST "$GAME_HOST" "$env_work"
  set_env KILN_RELAY_PROXY "$PROXY" "$env_work"
  set_env KILN_RELAY_ALLOW_PROVISIONING "$([[ "$MODE" == "hearth" ]] && printf false || printf true)" "$env_work"
  set_env KILN_RELAY_PUBLISH_ADDRESS "$publish_address" "$env_work"
  SFTP_PUBLISH_ADDRESS="$sftp_publish_address"
  set_env KILN_RELAY_SFTP_PUBLISH_ADDRESS "$SFTP_PUBLISH_ADDRESS" "$env_work"
  set_env KILN_RELAY_PORT "$RELAY_PORT" "$env_work"
  set_env KILN_RELAY_SFTP_PORT "$SFTP_PORT" "$env_work"
  set_env KILN_RELAY_GAME_PORT_RANGE "$GAME_PORT_RANGE" "$env_work"
  set_env KILN_RELAY_ACME_EMAIL "$ACME_EMAIL" "$env_work"
  chmod 600 "$env_work"
  mv -f "$env_work" "$ENV_FILE"
}

fetch_manifests() {
  log "Refreshing the installer-managed Compose files."
  local core_work proxy_work
  core_work="$(mktemp "${INSTALL_DIR}/.compose.yaml.XXXXXX")"
  proxy_work="$(mktemp "${INSTALL_DIR}/.compose.proxy.yaml.XXXXXX")"
  TEMP_FILES+=("$core_work" "$proxy_work")

  cat >"$core_work" <<'COMPOSE'
services:
  cache:
    container_name: kiln-cache
    image: valkey/valkey:9.1.0-alpine
    restart: unless-stopped
    command:
      - /bin/sh
      - -ec
      - exec valkey-server --save "" --appendonly no
    tmpfs:
      - /data
    healthcheck:
      test: ["CMD-SHELL", "valkey-cli ping | grep -q PONG"]
      interval: 3s
      timeout: 3s
      retries: 20

  mysql:
    container_name: kiln-mysql
    image: mysql:8.4
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: hearth
      MYSQL_PASSWORD: ${DB_PASSWORD:?DB_PASSWORD is required}
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:?MYSQL_ROOT_PASSWORD is required}
      MYSQL_USER: kiln
    volumes:
      - hearth-mysql:/var/lib/mysql
    labels:
      io.kiln.installation: ${KILN_INSTALLATION_ID:?KILN_INSTALLATION_ID is required}
      io.kiln.resource: hearth-database
    healthcheck:
      test:
        [
          "CMD-SHELL",
          'mysqladmin ping -h 127.0.0.1 -u"$${MYSQL_USER}" -p"$${MYSQL_PASSWORD}"',
        ]
      interval: 3s
      timeout: 3s
      retries: 30

  relay:
    container_name: kiln-relay
    image: ghcr.io/kiln-site/relay:latest
    restart: unless-stopped
    environment:
      KILN_INSTALLATION_ID: ${KILN_INSTALLATION_ID:?KILN_INSTALLATION_ID is required}
      KILN_RELAY_ALLOW_PROVISIONING: ${KILN_RELAY_ALLOW_PROVISIONING:-true}
      KILN_RELAY_BOOTSTRAP_TOKEN: ${KILN_RELAY_BOOTSTRAP_TOKEN:?KILN_RELAY_BOOTSTRAP_TOKEN is required}
      KILN_RELAY_HOST: ${KILN_RELAY_HOST:?KILN_RELAY_HOST is required}
      KILN_RELAY_GAME_HOST: ${KILN_RELAY_GAME_HOST:-}
      KILN_RELAY_GAME_PORT_RANGE: ${KILN_RELAY_GAME_PORT_RANGE:-30000-39999}
      KILN_RELAY_PROXY: ${KILN_RELAY_PROXY:?KILN_RELAY_PROXY is required}
      KILN_RELAY_ACME_EMAIL: ${KILN_RELAY_ACME_EMAIL:-}
      KILN_RELAY_PORT: ${KILN_RELAY_PORT:-4100}
      KILN_RELAY_PUBLIC_URL: ${KILN_RELAY_PUBLIC_URL:?KILN_RELAY_PUBLIC_URL is required}
      KILN_RELAY_SFTP_PORT: ${KILN_RELAY_SFTP_PORT:-2022}
      KILN_HEARTH_PUBLIC_URL: ${KILN_HEARTH_PUBLIC_URL:-}
      KILN_HEARTH_INTERNAL_URL: ${KILN_HEARTH_INTERNAL_URL:-}
      KILN_PLATFORM_BACKUP_KEY: ${KILN_PLATFORM_BACKUP_KEY:?KILN_PLATFORM_BACKUP_KEY is required}
    ports:
      - "${KILN_RELAY_PUBLISH_ADDRESS:-127.0.0.1}:${KILN_RELAY_PORT:-4100}:${KILN_RELAY_PORT:-4100}"
      - "${KILN_RELAY_SFTP_PUBLISH_ADDRESS:-0.0.0.0}:${KILN_RELAY_SFTP_PORT:-2022}:${KILN_RELAY_SFTP_PORT:-2022}"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - relay-data:/data
    labels:
      io.kiln.installation: ${KILN_INSTALLATION_ID:?KILN_INSTALLATION_ID is required}

  hearth:
    container_name: kiln-hearth
    image: ghcr.io/kiln-site/hearth:latest
    restart: unless-stopped
    depends_on:
      cache:
        condition: service_healthy
      mysql:
        condition: service_healthy
      relay:
        condition: service_healthy
    environment:
      DB_HOST: mysql
      DB_PORT: 3306
      DB_NAME: hearth
      DB_USERNAME: kiln
      DB_PASSWORD: ${DB_PASSWORD:?DB_PASSWORD is required}
      CACHE_HOST: cache
      CACHE_PORT: 6379
      KILN_ENVIRONMENT: prod
      KILN_INSTALLATION_ID: ${KILN_INSTALLATION_ID:?KILN_INSTALLATION_ID is required}
      KILN_ENABLE_SIGNUPS: ${KILN_ENABLE_SIGNUPS:-false}
      KILN_RELAY_BOOTSTRAP_TOKEN: ${KILN_RELAY_BOOTSTRAP_TOKEN:?KILN_RELAY_BOOTSTRAP_TOKEN is required}
      KILN_RELAY_CONTROL_URL: ws://relay:${KILN_RELAY_PORT:-4100}
      KILN_RELAY_HOST: ${KILN_RELAY_HOST:?KILN_RELAY_HOST is required}
      KILN_RELAY_PORT: ${KILN_RELAY_PORT:-4100}
      KILN_RELAY_PUBLIC_URL: ${KILN_RELAY_PUBLIC_URL:?KILN_RELAY_PUBLIC_URL is required}
      KILN_PLATFORM_BACKUP_KEY: ${KILN_PLATFORM_BACKUP_KEY:?KILN_PLATFORM_BACKUP_KEY is required}
      KILN_URL: ${KILN_HEARTH_PUBLIC_URL:-https://hearth.invalid}
      BETTER_AUTH_SECRETS: ${BETTER_AUTH_SECRETS:?BETTER_AUTH_SECRETS is required}
    extra_hosts:
      - "${KILN_RELAY_HOST}:host-gateway"
    ports:
      - "127.0.0.1:${KILN_HEARTH_PORT:-3000}:3000"
    labels:
      io.kiln.installation: ${KILN_INSTALLATION_ID:?KILN_INSTALLATION_ID is required}
      io.kiln.resource: hearth

volumes:
  hearth-mysql:
    name: kiln-hearth-mysql
  relay-data:
    name: kiln-relay-data
COMPOSE

  if [[ "$PROXY" == "coolify" ]]; then
    cat >"$proxy_work" <<'COMPOSE'
services:
  relay:
    networks:
      default: {}
      coolify: {}
    labels:
      traefik.enable: "true"
      traefik.docker.network: coolify
      traefik.http.routers.kiln-relay-http.entrypoints: http
      traefik.http.routers.kiln-relay-http.middlewares: kiln-relay-redirect
      traefik.http.routers.kiln-relay-http.rule: Host(`${KILN_RELAY_HOST}`)
      traefik.http.routers.kiln-relay-http.service: kiln-relay
      traefik.http.middlewares.kiln-relay-redirect.redirectscheme.scheme: https
      traefik.http.middlewares.kiln-relay-redirect.redirectscheme.permanent: "true"
      traefik.http.routers.kiln-relay-https.entrypoints: https
      traefik.http.routers.kiln-relay-https.rule: Host(`${KILN_RELAY_HOST}`)
      traefik.http.routers.kiln-relay-https.service: kiln-relay
      traefik.http.routers.kiln-relay-https.tls: "true"
      traefik.http.routers.kiln-relay-https.tls.certresolver: letsencrypt
      traefik.http.services.kiln-relay.loadbalancer.server.port: "${KILN_RELAY_PORT:-4100}"

  hearth:
    networks:
      default: {}
      coolify: {}
    labels:
      traefik.enable: "true"
      traefik.docker.network: coolify
      traefik.http.routers.kiln-hearth-http.entrypoints: http
      traefik.http.routers.kiln-hearth-http.middlewares: kiln-hearth-redirect
      traefik.http.routers.kiln-hearth-http.rule: Host(`${KILN_HEARTH_HOST}`)
      traefik.http.routers.kiln-hearth-http.service: kiln-hearth
      traefik.http.middlewares.kiln-hearth-redirect.redirectscheme.scheme: https
      traefik.http.middlewares.kiln-hearth-redirect.redirectscheme.permanent: "true"
      traefik.http.routers.kiln-hearth-https.entrypoints: https
      traefik.http.routers.kiln-hearth-https.rule: Host(`${KILN_HEARTH_HOST}`)
      traefik.http.routers.kiln-hearth-https.service: kiln-hearth
      traefik.http.routers.kiln-hearth-https.tls: "true"
      traefik.http.routers.kiln-hearth-https.tls.certresolver: letsencrypt
      traefik.http.services.kiln-hearth.loadbalancer.server.port: "3000"

networks:
  coolify:
    external: true
    name: coolify
COMPOSE
  else
    cat >"$proxy_work" <<'COMPOSE'
services:
  hearth:
    networks:
      default: {}
      relay-edge:
        aliases:
          - hearth

networks:
  relay-edge:
    external: true
    name: kiln-relay-edge
COMPOSE
  fi

  chmod 600 "$core_work" "$proxy_work"
  mv -f "$core_work" "$COMPOSE_FILE"
  mv -f "$proxy_work" "$PROXY_COMPOSE_FILE"
}

compose() {
  docker compose --project-name kiln --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" -f "$PROXY_COMPOSE_FILE" "$@"
}

relay_edge_network_is_owned() {
  local kind owner
  kind="$(
    docker network inspect kiln-relay-edge \
      --format '{{index .Labels "kiln.relay.network"}}' 2>/dev/null
  )" || return 1
  owner="$(
    docker network inspect kiln-relay-edge \
      --format '{{index .Labels "kiln.relay.owner"}}' 2>/dev/null
  )" || return 1
  [[ "$kind" == "relay-edge" && -z "$owner" ]]
}

ensure_relay_edge_network() {
  [[ "$PROXY" == "traefik" ]] || return 0
  if docker network inspect kiln-relay-edge >/dev/null 2>&1; then
    relay_edge_network_is_owned ||
      die "Docker network kiln-relay-edge exists but is not owned by this Kiln Relay."
    return
  fi
  docker network create --label kiln.relay.network=relay-edge kiln-relay-edge >/dev/null
}

update_persisted_proxy_settings() {
  docker volume inspect kiln-relay-data >/dev/null 2>&1 || return 0
  log "Synchronizing the persisted Relay edge with the installer topology."
  compose stop relay >/dev/null 2>&1 || true
  docker run --rm --entrypoint /nodejs/bin/node \
    --volume kiln-relay-data:/data \
    ghcr.io/kiln-site/relay:latest \
    -e 'const fs=require("node:fs");const p="/data/proxy.json";if(fs.existsSync(p)){const v=JSON.parse(fs.readFileSync(p,"utf8"));v.mode=process.argv[1];if(process.argv[3]==="true")v.acmeEmail=process.argv[2]||null;const t=p+".installer";fs.writeFileSync(t,JSON.stringify(v,null,2)+"\n",{mode:0o600});fs.renameSync(t,p)}' \
    "$PROXY" "$ACME_EMAIL" "$ACME_EMAIL_REQUESTED"
}

detach_relay_edge_dependents() {
  [[ "$PROXY" != "traefik" ]] || return 0
  docker network inspect kiln-relay-edge >/dev/null 2>&1 || return 0
  relay_edge_network_is_owned ||
    die "Docker network kiln-relay-edge is not owned by this Kiln Relay; refusing to disconnect its containers."
  local container
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    case "$container" in
      kiln-relay | kiln-traefik) ;;
      *) docker network disconnect -f kiln-relay-edge "$container" ;;
    esac
  done < <(
    docker network inspect kiln-relay-edge \
      --format '{{range .Containers}}{{println .Name}}{{end}}'
  )
}

wait_for_container() {
  local container="$1"
  local deadline=$((SECONDS + 240))
  while ((SECONDS < deadline)); do
    local status
    status="$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
    case "$status" in
      healthy | running) return ;;
      exited | dead)
        docker logs --tail 100 "$container" >&2 || true
        die "$container failed its health check."
        ;;
    esac
    sleep 2
  done
  docker logs --tail 100 "$container" >&2 || true
  die "Timed out waiting for $container to become healthy."
}

wait_for_url() {
  local url="$1"
  local expected="$2"
  local deadline=$((SECONDS + 300))
  while ((SECONDS < deadline)); do
    local code
    code="$(curl --proto '=https' --tlsv1.2 -sS -o /dev/null -w '%{http_code}' --max-time 8 "$url" 2>/dev/null || true)"
    [[ "$code" == "$expected" ]] && return
    sleep 3
  done
  die "Timed out waiting for $url (expected HTTP $expected). Check DNS, ports 80/443, and the proxy logs."
}

hearth_relay_client_id() {
  local rows browser_origin client_id matched=""
  rows="$(
    compose exec -T mysql sh -ec \
      'exec mysql --batch --skip-column-names --user="$MYSQL_USER" --password="$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "SELECT browser_origin, client_id FROM kiln_relay WHERE enabled = TRUE"' \
      2>/dev/null || true
  )"
  while IFS=$'\t' read -r browser_origin client_id; do
    [[ "$browser_origin" == "https://${RELAY_HOST}" ]] || continue
    [[ "$client_id" =~ ^[A-Za-z0-9_-]{43}$ ]] || return 1
    [[ -z "$matched" ]] || return 1
    matched="$client_id"
  done <<<"$rows"
  [[ -n "$matched" ]] || return 1
  printf '%s' "$matched"
}

relay_has_current_hearth_client() {
  local started_at="$1"
  local client_id
  client_id="$(hearth_relay_client_id)" || return 1
  compose exec -T relay /nodejs/bin/node -e '
const { execFileSync } = require("node:child_process")
const output = execFileSync("/usr/local/bin/kiln-relay", ["hearth", "list"], {
  encoding: "utf8",
})
const jsonStart = output.indexOf("[")
if (jsonStart === -1) process.exit(1)
const clients = JSON.parse(output.slice(jsonStart))
const clientId = process.argv[1]
const origin = process.argv[2]
const startedAt = Number(process.argv[3])
const current = clients.some(
  (client) =>
    client.id === clientId &&
    client.origins.includes(origin) &&
    typeof client.lastSeenAt === "number" &&
    client.lastSeenAt >= startedAt
)
process.exit(current ? 0 : 1)
' -- "$client_id" "https://${HEARTH_HOST}" "$started_at" >/dev/null 2>&1
}

manual_pairing_recovery() {
  log "Manual Relay pairing is required."
  printf '1. Open https://%s/infra/relays and choose Add Relay.\n' "$HEARTH_HOST" >&2
  printf '2. Paste the 15-minute pairing URI printed below and confirm the Relay identity.\n\n' >&2
  compose exec -T relay kiln-relay pair create ||
    die "Could not create a manual Relay pairing invitation. Check the Relay logs and retry."
  printf '\n3. After Hearth accepts the URI, rerun this installer to verify the connection.\n' >&2
  die "Automatic pairing could not safely replace or bypass an existing Hearth client. Complete the manual pairing steps above."
}

wait_for_automatic_pairing() {
  local started_at="$1"
  local deadline=$((SECONDS + 60))
  while ((SECONDS < deadline)); do
    relay_has_current_hearth_client "$started_at" && return
    sleep 2
  done

  warn "Automatic Relay pairing is still pending; restarting Hearth once."
  compose restart hearth
  wait_for_container kiln-hearth
  deadline=$((SECONDS + 60))
  while ((SECONDS < deadline)); do
    relay_has_current_hearth_client "$started_at" && return
    sleep 2
  done
  manual_pairing_recovery
}

check_dns() {
  local hostname="$1"
  if command -v getent >/dev/null 2>&1 && ! getent ahosts "$hostname" >/dev/null 2>&1; then
    die "$hostname does not resolve. Create its DNS record before running the installer."
  fi
}

mark_installation_complete() {
  [[ ! -L "$INSTALL_MARKER_FILE" ]] || die "$INSTALL_MARKER_FILE must not be a symbolic link."
  local marker_work
  marker_work="$(mktemp "${INSTALL_DIR}/.installed.XXXXXX")"
  TEMP_FILES+=("$marker_work")
  printf 'Kiln installer topology committed\n' >"$marker_work"
  chmod 600 "$marker_work"
  mv -f "$marker_work" "$INSTALL_MARKER_FILE"
}

assert_proxy_ports_available() {
  [[ "$PROXY" == "traefik" ]] || return 0
  local port owner owners
  for port in 80 443; do
    owners="$(docker ps --filter "publish=${port}" --format '{{.Names}}')"
    while IFS= read -r owner; do
      [[ -n "$owner" ]] || continue
      [[ "$owner" == "kiln-traefik" ]] ||
        die "Bundled Traefik needs ports 80 and 443, but container $owner already publishes port $port. Stop that proxy or use --proxy coolify."
    done <<<"$owners"
    if [[ -z "$owners" ]] && command -v ss >/dev/null 2>&1 &&
      ss -H -ltn "sport = :${port}" | grep -q .; then
      die "Bundled Traefik needs ports 80 and 443, but a host process already listens on port $port."
    fi
  done
}

deploy() {
  compose config --quiet
  assert_proxy_ports_available
  ensure_relay_edge_network

  local services=(relay)
  if [[ "$MODE" != "relay" ]]; then
    services=(cache mysql relay hearth)
  fi
  if [[ "$SKIP_PULL" != "true" ]]; then
    log "Pulling the latest Kiln images."
    compose pull "${services[@]}"
    if [[ "$PROXY" == "traefik" ]]; then
      docker pull "$TRAEFIK_IMAGE"
    fi
  fi
  detach_relay_edge_dependents
  update_persisted_proxy_settings

  log "Recreating Relay and its dependencies without removing data."
  if [[ "$MODE" == "relay" ]]; then
    compose stop hearth cache mysql >/dev/null 2>&1 || true
    compose up -d --force-recreate relay
  else
    compose up -d --force-recreate cache mysql relay
  fi
  wait_for_container kiln-relay
  wait_for_url "https://${RELAY_HOST}/health" 204

  if [[ "$MODE" == "relay" ]]; then
    log "Relay is ready. Copy this one-time URI into Hearth:"
    compose exec -T relay kiln-relay pair create
    return
  fi

  log "Starting Hearth after the Relay edge is ready."
  local pairing_started_at
  pairing_started_at="$(( $(date +%s) * 1000 ))"
  compose up -d --force-recreate hearth
  wait_for_container kiln-hearth
  wait_for_url "https://${HEARTH_HOST}/api/health" 200
  wait_for_automatic_pairing "$pairing_started_at"
}

summary() {
  log "Installation complete."
  if [[ "$MODE" != "relay" ]]; then
    printf 'Hearth: https://%s\n' "$HEARTH_HOST"
  fi
  printf 'Relay:  https://%s\n' "$RELAY_HOST"
  printf 'State:  %s (kept across installer reruns)\n' "$INSTALL_DIR"
  printf 'Logs:   cd %q && docker compose --env-file .env -f compose.yaml -f compose.proxy.yaml logs\n' "$INSTALL_DIR"
  if [[ "$MODE" == "kiln" || "$MODE" == "relay" ]]; then
    printf 'Allow TCP %s and TCP/UDP %s through the host firewall for SFTP and game servers.\n' \
      "$SFTP_PORT" "$GAME_PORT_RANGE"
  fi
}

main() {
  parse_arguments "$@"
  check_platform
  acquire_lock
  if [[ "$DRY_RUN" != "true" ]]; then
    install_docker
  fi

  local previous_proxy=""
  if [[ -f "$ENV_FILE" ]]; then
    previous_proxy="$(read_env KILN_RELAY_PROXY)"
  fi
  resolve_hosts
  resolve_proxy "$previous_proxy"
  prepare_directory
  fetch_manifests

  if [[ "$DRY_RUN" == "true" ]]; then
    log "Dry run complete. Generated installer state in $INSTALL_DIR."
    return
  fi

  check_dns "$RELAY_HOST"
  if [[ "$MODE" != "relay" ]]; then
    check_dns "$HEARTH_HOST"
  fi
  deploy
  mark_installation_complete
  summary
}

main "$@"
