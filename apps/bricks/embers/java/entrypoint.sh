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

# A Brick that pins a build names where that build is downloaded from.
artifact_url=${KILN_ARTIFACT_URL}
artifact_label="${KILN_IMPLEMENTATION:-server} ${KILN_VERSION:-unknown}"
if [[ -n "${KILN_ARTIFACT_BUILD:-}" ]]; then
  : "${KILN_ARTIFACT_BUILD_URL:?KILN_ARTIFACT_BUILD_URL is required with KILN_ARTIFACT_BUILD}"
  artifact_url=${KILN_ARTIFACT_BUILD_URL}
  artifact_label+=" build ${KILN_ARTIFACT_BUILD}"
fi

installer="${KILN_ARTIFACT_INSTALLER:-}"
if [[ -n "${installer}" && "${installer}" != forge ]]; then
  echo "[Kiln Ember] KILN_ARTIFACT_INSTALLER must be empty or forge" >&2
  exit 64
fi

download_artifact() {
  local destination=$1
  local temporary=".${destination}.download"
  echo "[Kiln Ember] downloading ${artifact_label}"
  if curl --fail --location --no-progress-meter --retry 2 --retry-all-errors \
    --connect-timeout 15 --max-time 300 \
    --output "${temporary}" "${artifact_url}"; then
    mv -- "${temporary}" "${destination}"
  else
    local status=$?
    rm -f -- "${temporary}"
    echo "[Kiln Ember] failed to download ${artifact_label} after 3 attempts. Server startup failed. Swap to a different Brick in Startup, or contact support if this keeps happening." >&2
    exit "${status}"
  fi
  if [[ -n "${KILN_ARTIFACT_SHA256:-}" ]]; then
    printf '%s  %s\n' "${KILN_ARTIFACT_SHA256}" "${destination}" | sha256sum --check --status
  fi
}

# Forge 1.17 and newer start from the argument file its installer writes.
forge_arguments_file() {
  local files=(libraries/net/minecraftforge/forge/*/unix_args.txt)
  if [[ -f "${files[-1]}" ]]; then
    printf '%s' "${files[-1]}"
  fi
}

if [[ "${installer}" == forge ]]; then
  # The artifact is Forge's installer, run once to lay the server out.
  if [[ ! -s "${KILN_ARTIFACT_FILE}" && -z "$(forge_arguments_file)" ]]; then
    forge_installer=.kiln-forge-installer.jar
    download_artifact "${forge_installer}"
    echo "[Kiln Ember] installing ${artifact_label}"
    if ! java -jar "${forge_installer}" --installServer; then
      rm -f -- "${forge_installer}"
      echo "[Kiln Ember] the Forge installer failed for ${artifact_label}; see ${forge_installer}.log. Server startup failed." >&2
      exit 1
    fi
    # Its start scripts and JVM arguments file are Kiln's to manage here.
    rm -f -- "${forge_installer}" "${forge_installer}.log" run.sh run.bat user_jvm_args.txt
    if [[ -z "$(forge_arguments_file)" ]]; then
      # Before 1.17 the installer leaves a server jar to start instead.
      forge_jar=""
      for candidate in forge-*.jar; do
        if [[ -f "${candidate}" && "${candidate}" != *-installer.jar ]]; then
          forge_jar=${candidate}
          break
        fi
      done
      if [[ -z "${forge_jar}" ]]; then
        echo "[Kiln Ember] the Forge installer left no server to start for ${artifact_label}. Server startup failed." >&2
        exit 1
      fi
      mv -- "${forge_jar}" "${KILN_ARTIFACT_FILE}"
    fi
  fi
else
  if [[ ! -s "${KILN_ARTIFACT_FILE}" ]]; then
    download_artifact "${KILN_ARTIFACT_FILE}"
  elif [[ -n "${KILN_ARTIFACT_SHA256:-}" ]]; then
    printf '%s  %s\n' "${KILN_ARTIFACT_SHA256}" "${KILN_ARTIFACT_FILE}" | sha256sum --check --status
  fi
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

launch_args=(-jar "${KILN_ARTIFACT_FILE}")
if [[ "${installer}" == forge ]]; then
  forge_arguments=$(forge_arguments_file)
  if [[ -n "${forge_arguments}" ]]; then
    launch_args=("@${forge_arguments}")
  fi
fi

echo "[Kiln Ember] starting ${artifact_label} with Java $(java -version 2>&1 | head -1)"
exec java \
  "${java_memory_args[@]}" \
  "${extra_java_args[@]}" \
  "${launch_args[@]}" \
  "${server_args[@]}"
