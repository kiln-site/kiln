import { Effect } from "effect"

import type { RelayConfig } from "./config.js"
import {
  DockerEngine,
  ensureImage,
  isDockerNotFound,
  type DockerContainerInspect,
} from "./docker-engine.js"
import { ensuringPromise } from "./effect/promise.js"
import { RELAY_OWNER_LABEL, relayOwnsLabels } from "./relay-resources.js"
import type { TerminalTarget } from "./container-terminal.js"

// BusyBox's nsenter is all the helper needs. Pinned, as it runs as root on
// the host.
export const HOST_SHELL_IMAGE =
  "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8"
const HOST_SHELL_LABEL = "kiln.relay.infrastructure"
// Raised whenever the helper's configuration changes, so older helpers are
// replaced rather than reused.
const HOST_SHELL_REVISION_LABEL = "kiln.relay.host-shell.revision"
const HOST_SHELL_REVISION = "1"

export class HostAccessDisabledError extends Error {
  constructor() {
    super(
      "Host access is turned off on this Relay. Set KILN_RELAY_HOST_ACCESS=true to allow it."
    )
  }
}

// Shells on the Relay's host run in a small helper container that shares the
// host's processes and is privileged, so it can enter the namespaces of the
// host's init process: a root shell on the host, as SSH would give. The
// helper only sleeps between sessions and is created on first use.
export class HostShell {
  readonly #config: Pick<RelayConfig, "hostAccess" | "resourceNamespace">
  readonly #engine: DockerEngine
  readonly #name: string
  #pending: Promise<string> | null = null

  constructor(
    config: Pick<
      RelayConfig,
      "dockerSocket" | "hostAccess" | "resourceNamespace"
    >
  ) {
    this.#config = config
    this.#engine = new DockerEngine(config.dockerSocket)
    this.#name = config.resourceNamespace
      ? `${config.resourceNamespace}-kiln-host-shell`
      : "kiln-host-shell"
  }

  get enabled(): boolean {
    return this.#config.hostAccess
  }

  // The running helper's ID, started if it isn't. Concurrent callers share
  // one start.
  container(): Promise<string> {
    if (!this.#config.hostAccess) {
      return Promise.reject(new HostAccessDisabledError())
    }
    this.#pending ??= ensuringPromise(
      () => this.#ensure(),
      () => {
        this.#pending = null
      }
    )
    return this.#pending
  }

  // The helper if it's running, without starting it, for sweeping sessions
  // a previous Relay process left behind.
  async runningContainer(): Promise<string | null> {
    const existing = await this.#inspect()
    return existing && this.#owns(existing) && existing.State.Running
      ? existing.Id
      : null
  }

  // Reboots the host with its own tools. The reboot waits a moment, so the
  // caller hears back before the host's network goes down.
  async restartHost(): Promise<void> {
    const container = await this.container()
    await Effect.runPromise(
      this.#engine.exec(container, [
        ...hostNamespaces,
        "--",
        "sh",
        "-c",
        HOST_RESTART_SCRIPT,
      ])
    )
  }

  // Removes the helper, when host access has been turned off.
  async remove(): Promise<void> {
    const existing = await this.#inspect()
    if (!existing || !this.#owns(existing)) {
      return
    }
    await Effect.runPromise(
      this.#engine.removeContainer(this.#name, { force: true })
    )
  }

  async #ensure(): Promise<string> {
    const existing = await this.#inspect()
    if (existing) {
      if (!this.#owns(existing)) {
        throw new Error(
          `Docker container ${this.#name} exists but is not owned by this Relay`
        )
      }
      if (
        existing.Config.Image === HOST_SHELL_IMAGE &&
        existing.Config.Labels?.[HOST_SHELL_REVISION_LABEL] ===
          HOST_SHELL_REVISION
      ) {
        if (!existing.State.Running) {
          await Effect.runPromise(this.#engine.startContainer(existing.Id))
        }
        return existing.Id
      }
      await Effect.runPromise(
        this.#engine.removeContainer(existing.Id, { force: true })
      )
    }
    await Effect.runPromise(ensureImage(this.#engine, HOST_SHELL_IMAGE))
    const created = await Effect.runPromise(
      this.#engine.createContainer(this.#name, {
        Cmd: ["sleep", "infinity"],
        HostConfig: {
          Init: true,
          PidMode: "host",
          Privileged: true,
          RestartPolicy: { Name: "no" },
          // Sessions record host PIDs in /tmp for the Relay to hang up. A
          // tmpfs forgets them when the helper stops, so a PID the host has
          // since given to another process is never signalled.
          Tmpfs: { "/tmp": "" },
        },
        Image: HOST_SHELL_IMAGE,
        Labels: {
          [HOST_SHELL_LABEL]: "host-shell",
          [HOST_SHELL_REVISION_LABEL]: HOST_SHELL_REVISION,
          "kiln.relay.owned": "true",
          ...(this.#config.resourceNamespace
            ? { [RELAY_OWNER_LABEL]: this.#config.resourceNamespace }
            : {}),
        },
      })
    )
    await Effect.runPromise(this.#engine.startContainer(created.Id))
    return created.Id
  }

  #owns(container: DockerContainerInspect): boolean {
    return (
      relayOwnsLabels(this.#config, container.Config.Labels) &&
      container.Config.Labels?.[HOST_SHELL_LABEL] === "host-shell"
    )
  }

  async #inspect(): Promise<DockerContainerInspect | null> {
    return Effect.runPromise(
      this.#engine
        .inspectContainer<DockerContainerInspect>(this.#name)
        .pipe(
          Effect.catch((cause) =>
            isDockerNotFound(cause) ? Effect.succeed(null) : Effect.fail(cause)
          )
        )
    )
  }
}

// A login shell on the Relay's host, bash where the host has it. nsenter
// joins the host's mount, UTS, IPC, and network namespaces; the helper already
// shares its processes, so the shell stays the process the session started.
export function hostTerminalTarget(containerId: string): TerminalTarget {
  return {
    command: [
      ...hostNamespaces,
      "--no-fork",
      "--",
      "sh",
      "-c",
      'cd "$HOME" 2>/dev/null || cd /; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi',
    ],
    containerId,
    environment: ["HOME=/root"],
    key: HOST_TERMINAL_KEY,
    running: true,
    stoppedMessage: "The host shell could not start",
  }
}

export const HOST_TERMINAL_KEY = "relay:host"

const hostNamespaces = [
  "nsenter",
  "--target",
  "1",
  "--mount",
  "--uts",
  "--ipc",
  "--net",
  "--root",
  "--wd",
] as const

// systemd's reboot where systemd runs the host, otherwise whichever reboot
// command the host has. Docker stops and later restarts its containers, the
// Relay's and the game servers', apps', and databases' among them.
const HOST_RESTART_SCRIPT = `if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  set -- systemctl reboot
elif command -v shutdown >/dev/null 2>&1; then
  set -- shutdown -r now
elif command -v reboot >/dev/null 2>&1; then
  set -- reboot
else
  echo "The host has no reboot command" >&2
  exit 127
fi
(sleep 2; "$@") </dev/null >/dev/null 2>&1 &`
