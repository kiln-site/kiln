import {
  relayHostPackagesSchema,
  type RelayHostPackageManager,
  type RelayHostPackages,
  type RelayHostPackagesRequest,
} from "@workspace/contracts"

import type { HostShell } from "./host-shell.js"

// Updates the OS packages on the Relay's host with the host's own package
// manager, as someone at its root shell would.
//
// A run outlives the Relay: it's detached on the host, under systemd where
// that's there, so it isn't killed if the Relay or Docker restarts, and it
// keeps its progress on the host, where the Relay reads it back. That's also
// what keeps one run at a time.
//
// It changes only what the host's package manager offers among the packages
// already installed, keeping their configuration. It leaves the container
// engine alone, since updating that restarts every container on the host, and
// never restarts anything itself: a new kernel waits for someone to reboot.

// Under a directory only root can write to: what's kept here is run as root,
// so nobody else may get to create it first.
const RUN_DIRECTORY = "/var/lib/kiln-host-packages"
// Enough to refuse a stuck mirror, not to hold the Relay's request.
const REFRESH_TIMEOUT_MS = 100_000
// The tail of the run's log a person is shown.
const OUTPUT_BYTES = 8_000
// `apt`'s `Inst` and `dnf`'s listings give packages with their architecture.
const ENGINE_PACKAGES =
  "^(containerd|containerd\\.io|docker|docker\\.io|docker-buildx.*|docker-ce|docker-ce-cli|docker-ce-rootless-extras|docker-compose.*|docker-engine|moby-.*|podman|runc)(:[a-z0-9]+)?$"

const PRELUDE = `export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1
directory=${RUN_DIRECTORY}
# The run itself, not whatever has since been given its PID.
running() {
  tr '\\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -q "$directory/run.sh"
}
engine='${ENGINE_PACKAGES}'
manager=
for candidate in apt-get dnf yum zypper apk; do
  if command -v "$candidate" >/dev/null 2>&1; then manager=$candidate; break; fi
done
refresh() {
  case "$manager" in
    apt-get) apt-get -qq -o DPkg::Lock::Timeout=60 update ;;
    dnf|yum) "$manager" -q makecache ;;
    zypper) zypper -q -n refresh ;;
    apk) apk -q update ;;
  esac
}
# What the package manager would update, one to a line. Fails if it can't say:
# no list isn't the same as an empty one.
available() {
  case "$manager" in
    apt-get)
      listing=$(apt-get -s -o Debug::NoLocking=1 upgrade) || return 1
      printf '%s\\n' "$listing" | awk '/^Inst /{print $2}' ;;
    dnf|yum)
      listing=$("$manager" -q -C check-update)
      # 100 is how they say there are updates.
      status=$?
      if [ "$status" -ne 0 ] && [ "$status" -ne 100 ]; then return 1; fi
      printf '%s\\n' "$listing" | awk 'NF==3 && $1 ~ /\\./ {sub(/\\.[^.]*$/, "", $1); print $1}' ;;
    zypper)
      listing=$(zypper -q -n --no-refresh list-updates) || return 1
      printf '%s\\n' "$listing" | awk -F'|' '$1 ~ /^v/ {gsub(/ /, "", $3); print $3}' ;;
    apk)
      listing=$(apk upgrade -s) || return 1
      printf '%s\\n' "$listing" | awk '$2 == "Upgrading" {print $3}' ;;
  esac
}`

// Runs on the host, detached. The last thing it writes says how it ended.
const RUN_SCRIPT = `${PRELUDE}
echo "running $$ $(date +%s)" > "$directory/status"
started=$(date +%s)
exec > "$directory/log" 2>&1
refresh
code=$?
if [ "$code" -eq 0 ]; then
  packages=$(available)
  code=$?
fi
if [ "$code" -eq 0 ]; then
  list=$(printf '%s\\n' "$packages" | grep -Ev "$engine" | sort -u | tr '\\n' ' ')
  if [ -z "$(echo $list)" ]; then
    echo "Nothing to update"
  else
    case "$manager" in
      apt-get) apt-get -y -o DPkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install --only-upgrade $list ;;
      dnf|yum) "$manager" -y upgrade $list ;;
      zypper) zypper -n update -l $list ;;
      apk) apk add --upgrade $list ;;
    esac
    code=$?
  fi
fi
echo "finished $code $started $(date +%s)" > "$directory/status"`

// Hands the run to the host and waits for it to say it's running, so someone
// asking right after finds it.
const START_SCRIPT = `${PRELUDE}
if [ -z "$manager" ]; then echo unsupported; exit 0; fi
mkdir -p "$directory"
chmod 700 "$directory"
if read -r state pid _ < "$directory/status" 2>/dev/null; then
  if [ "$state" = running ] && running "$pid"; then echo running; exit 0; fi
fi
rm -f "$directory/status"
cat > "$directory/run.sh" <<'KILN_RUN'
${RUN_SCRIPT}
KILN_RUN
if [ -d /run/systemd/system ] && command -v systemd-run >/dev/null 2>&1; then
  systemctl reset-failed kiln-host-packages >/dev/null 2>&1
  systemd-run --quiet --collect --unit=kiln-host-packages sh "$directory/run.sh"
else
  setsid nohup sh "$directory/run.sh" >/dev/null 2>&1 </dev/null &
fi
tries=0
while [ ! -s "$directory/status" ] && [ "$tries" -lt 50 ]; do
  tries=$((tries + 1))
  sleep 0.1
done
if [ -s "$directory/status" ]; then echo started; else echo failed; fi`

// Sections of what a read prints, each after a line naming it.
const readScript = (refresh: boolean) => `${PRELUDE}
echo "@manager"
echo "$manager"
echo "@reboot"
if [ -f /var/run/reboot-required ]; then echo yes
elif command -v needs-restarting >/dev/null 2>&1 && ! needs-restarting -r >/dev/null 2>&1; then echo yes
fi
echo "@status"
status=$(cat "$directory/status" 2>/dev/null)
echo "$status"
case "$status" in
  running*) set -- $status; if running "$2"; then echo alive; busy=1; fi ;;
esac
echo "@output"
tail -c ${OUTPUT_BYTES} "$directory/log" 2>/dev/null
${
  refresh
    ? `echo
if [ -n "$manager" ] && [ -z "\${busy:-}" ]; then
  if refresh >/dev/null 2>&1 && packages=$(available 2>/dev/null); then
    echo "@updates"
    printf '%s\\n' "$packages" | grep -Ev "$engine"
    echo "@held"
    printf '%s\\n' "$packages" | grep -E "$engine"
  fi
fi`
    : ""
}
exit 0`

const managers: Readonly<Record<string, RelayHostPackageManager>> = {
  "apt-get": "apt",
  apk: "apk",
  dnf: "dnf",
  yum: "yum",
  zypper: "zypper",
}

function sections(stdout: string): Map<string, Array<string>> {
  const found = new Map<string, Array<string>>()
  let current: Array<string> | null = null
  for (const line of stdout.split("\n")) {
    if (/^@[a-z]+$/u.test(line)) {
      current = []
      found.set(line.slice(1), current)
    } else {
      current?.push(line)
    }
  }
  return found
}

// Progress bars redraw a line with carriage returns; only the last drawn is
// worth showing.
const lastFrames = (lines: ReadonlyArray<string>) =>
  lines.map((line) => line.split("\r").filter(Boolean).at(-1) ?? "").join("\n")

const packageList = (lines: ReadonlyArray<string> | undefined) =>
  lines === undefined
    ? null
    : [...new Set(lines.map((line) => line.trim()).filter(Boolean))].sort()

function readRun(
  status: ReadonlyArray<string>,
  output: string
): RelayHostPackages["run"] {
  const [state, first, second, third] = (status[0] ?? "").split(" ")
  if (state === "running") {
    // Interrupted, as by the host rebooting, it left nothing to say so.
    const alive = status[1] === "alive"
    return {
      finishedAt: null,
      output,
      startedAt: Number(second) * 1000 || null,
      state: alive ? "running" : "failed",
    }
  }
  if (state === "finished") {
    return {
      finishedAt: Number(third) * 1000 || null,
      output,
      startedAt: Number(second) * 1000 || null,
      state: first === "0" ? "succeeded" : "failed",
    }
  }
  return { finishedAt: null, output: "", startedAt: null, state: "idle" }
}

export class HostPackages {
  readonly #shell: Pick<HostShell, "runningContainer" | "runScript">

  constructor(shell: Pick<HostShell, "runningContainer" | "runScript">) {
    this.#shell = shell
  }

  /** What the host runs, with what would change when `refresh` asks it. */
  async read(input: RelayHostPackagesRequest): Promise<RelayHostPackages> {
    const stdout = await this.#shell.runScript(
      readScript(input.refresh),
      input.refresh ? REFRESH_TIMEOUT_MS : 15_000
    )
    const parts = sections(stdout)
    const manager = parts.get("manager")?.[0]?.trim() ?? ""
    return relayHostPackagesSchema.parse({
      heldBack: packageList(parts.get("held"))?.slice(0, 100) ?? null,
      manager: managers[manager] ?? null,
      rebootRequired: parts.get("reboot")?.[0]?.trim() === "yes",
      run: readRun(
        parts.get("status") ?? [],
        lastFrames(parts.get("output") ?? [])
          .trim()
          .slice(-OUTPUT_BYTES)
      ),
      updates: packageList(parts.get("updates"))?.slice(0, 5_000) ?? null,
    })
  }

  /**
   * When an update last finished. This is asked every few minutes, so it's
   * never worth starting the host's helper for: one that stopped, as with a
   * reboot, leaves the day's own inventory to notice.
   */
  async updatedAt(): Promise<number | null> {
    if ((await this.#shell.runningContainer()) === null) return null
    const { run } = await this.read({ refresh: false })
    return run.state === "succeeded" ? run.finishedAt : null
  }

  /** Starts an update on the host, unless it's already running one. */
  async update(): Promise<{ readonly started: boolean }> {
    const answer = (await this.#shell.runScript(START_SCRIPT, 30_000)).trim()
    if (answer === "started") return { started: true }
    if (answer === "running") return { started: false }
    throw new Error(
      answer === "unsupported"
        ? "Kiln doesn't know this host's package manager"
        : "The host didn't start updating its packages"
    )
  }
}
