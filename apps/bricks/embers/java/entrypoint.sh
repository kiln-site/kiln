#!/usr/bin/env bash
set -Eeuo pipefail

cd /server

: "${KILN_ARTIFACT_URL:?KILN_ARTIFACT_URL is required}"
: "${KILN_ARTIFACT_FILE:?KILN_ARTIFACT_FILE is required}"

installation_marker="${KILN_INSTALLATION_MARKER:-}"
if [[ -n "${installation_marker}" && ! "${installation_marker}" =~ ^\.kiln-[a-zA-Z0-9._-]{1,58}$ ]]; then
  echo "[Kiln Ember] KILN_INSTALLATION_MARKER must be a reserved .kiln-* filename" >&2
  exit 64
fi
if [[ -n "${installation_marker}" ]]; then
  rm -f -- "${installation_marker}"
fi

if [[ ! -s "${KILN_ARTIFACT_FILE}" ]]; then
  temporary=".${KILN_ARTIFACT_FILE}.download"
  echo "[Kiln Ember] downloading ${KILN_IMPLEMENTATION:-server} ${KILN_VERSION:-unknown}"
  if curl --fail --location --no-progress-meter --retry 2 --retry-all-errors \
    --connect-timeout 15 --max-time 300 \
    --output "${temporary}" "${KILN_ARTIFACT_URL}"; then
    mv -- "${temporary}" "${KILN_ARTIFACT_FILE}"
  else
    status=$?
    rm -f -- "${temporary}"
    echo "[Kiln Ember] failed to download ${KILN_IMPLEMENTATION:-server} ${KILN_VERSION:-unknown} after 3 attempts. Server startup failed. Swap to a different Brick in Startup, or contact support if this keeps happening." >&2
    exit "${status}"
  fi
fi

if [[ -n "${KILN_ARTIFACT_SHA256:-}" ]]; then
  printf '%s  %s\n' "${KILN_ARTIFACT_SHA256}" "${KILN_ARTIFACT_FILE}" | sha256sum --check --status
fi

if [[ "${KILN_SERVER_KIND:-minecraft}" == "minecraft" ]]; then
  printf 'eula=true\n' > eula.txt
  if [[ ! -f server.properties ]]; then
    printf '%s\n' \
      'server-port=25565' \
      'motd=Kiln managed server' \
      'enable-rcon=false' > server.properties
  fi
fi

if [[ -n "${installation_marker}" ]]; then
  touch -- "${installation_marker}"
fi

# Split on unquoted whitespace without eval or expansion so values like
# -Dmessage="hello world" stay a single Java argument.
quoted_args=()
parse_quoted_args() {
  quoted_args=()
  local input=$1
  local current="" quote="" i=0 c
  local len=${#input}

  while ((i < len)); do
    c=${input:i:1}
    if [[ -n ${quote} ]]; then
      if [[ ${c} == "${quote}" ]]; then
        quote=""
      elif [[ ${quote} == '"' && ${c} == '\' ]]; then
        i=$((i + 1))
        if ((i >= len)); then
          echo "[Kiln Ember] unmatched backslash in KILN_JAVA_ARGS" >&2
          return 64
        fi
        current+=${input:i:1}
      else
        current+=${c}
      fi
    elif [[ ${c} == [[:space:]] ]]; then
      if [[ -n ${current} ]]; then
        quoted_args+=("${current}")
        current=""
      fi
    elif [[ ${c} == "'" ]]; then
      quote="'"
    elif [[ ${c} == '"' ]]; then
      quote='"'
    elif [[ ${c} == '\' ]]; then
      i=$((i + 1))
      if ((i >= len)); then
        echo "[Kiln Ember] unmatched backslash in KILN_JAVA_ARGS" >&2
        return 64
      fi
      current+=${input:i:1}
    else
      current+=${c}
    fi
    i=$((i + 1))
  done

  if [[ -n ${quote} ]]; then
    echo "[Kiln Ember] unmatched quote in KILN_JAVA_ARGS" >&2
    return 64
  fi
  if [[ -n ${current} ]]; then
    quoted_args+=("${current}")
  fi
  return 0
}

is_java_argument_file() {
  case "$1" in
    @@*) return 1 ;;
    @*|-XX:VMOptionsFile|-XX:VMOptionsFile=*|-XX:Flags|-XX:Flags=*) return 0 ;;
  esac
  return 1
}

is_managed_java_arg() {
  case "$1" in
    --nogui|-Xms*|-Xmx*) return 0 ;;
  esac
  local managed_pattern='^-XX:(-UseContainerSupport|-UseCGroupMemoryLimitForHeap|InitialHeapSize|MaxHeapSize|SoftMaxHeapSize|MaxRAMPercentage|MinRAMPercentage|InitialRAMPercentage|MaxRAMFraction|InitialRAMFraction|MinRAMFraction|MaxRAM)(=.*)?$'
  [[ $1 =~ ${managed_pattern} ]]
}

parse_quoted_args "${KILN_JAVA_ARGS:-}" || exit $?
extra_java_args=()
ignored_java_args=()
for ((argument_index = 0; argument_index < ${#quoted_args[@]}; argument_index++)); do
  arg=${quoted_args[argument_index]}
  if [[ ${arg} == -jar ]]; then
    ignored_java_args+=("${arg}")
    if ((argument_index + 1 < ${#quoted_args[@]})); then
      argument_index=$((argument_index + 1))
      ignored_java_args+=("${quoted_args[argument_index]}")
    fi
    continue
  fi
  if is_java_argument_file "${arg}"; then
    echo "[Kiln Ember] Java argument files are not allowed in KILN_JAVA_ARGS: ${arg}" >&2
    exit 64
  fi
  if is_managed_java_arg "${arg}"; then
    ignored_java_args+=("${arg}")
  else
    extra_java_args+=("${arg}")
  fi
done
if ((${#ignored_java_args[@]} > 0)); then
  echo "[Kiln Ember] ignoring managed JVM flags: ${ignored_java_args[*]}" >&2
fi

read -r -a server_args <<< "${KILN_SERVER_ARGS---nogui}"
java_memory_args=(-Xms"${MIN_RAM:-512M}")
if [[ -n "${MAX_RAM:-}" ]]; then
  java_memory_args+=(-Xmx"${MAX_RAM}")
else
  java_memory_args+=("-XX:MaxRAMPercentage=${KILN_JAVA_MAX_RAM_PERCENTAGE:-75.0}")
fi

echo "[Kiln Ember] starting ${KILN_IMPLEMENTATION:-server} ${KILN_VERSION:-unknown} with Java $(java -version 2>&1 | head -1)"
exec java \
  "${java_memory_args[@]}" \
  "${extra_java_args[@]}" \
  -jar "${KILN_ARTIFACT_FILE}" \
  "${server_args[@]}"
