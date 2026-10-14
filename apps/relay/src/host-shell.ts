import { Effect, Result } from "effect"

import { command } from "./command.js"
import type { RelayConfig } from "./config.js"
import {
  DockerEngine,
  isDockerNotFound,
  type DockerContainerInspect,
} from "./docker-engine.js"
import { relayOwnerLabel, relayOwnsLabels } from "./relay-resources.js"
import type { TerminalTarget } from "./container-terminal.js"

// BusyBox's nsenter is all the helper needs.
export const HOST_SHELL_IMAGE = "alpine:3.22"
const HOST_SHELL_LABEL = "kiln.relay.infrastructure"

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
  #pending: Promise<{ id: string; running: boolean }> | null = null

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

  // The running helper, started if it isn't. Concurrent callers share one
  // start.
  container(): Promise<{ id: string; running: boolean }> {
    if (!this.#config.hostAccess) {
      return Promise.reject(new HostAccessDisabledError())
    }
    this.#pending ??= this.#ensure().finally(() => {
      this.#pending = null
    })
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

  async #ensure(): Promise<{ id: string; running: boolean }> {
    const existing = await this.#inspect()
    if (existing) {
      if (!this.#owns(existing)) {
        throw new Error(
          `Docker container ${this.#name} exists but is not owned by this Relay`
        )
      }
      if (existing.Config.Image === HOST_SHELL_IMAGE) {
        if (!existing.State.Running) {
          await Effect.runPromise(this.#engine.startContainer(existing.Id))
        }
        return { id: existing.Id, running: true }
      }
      await Effect.runPromise(
        this.#engine.removeContainer(existing.Id, { force: true })
      )
    }
    const image = await Effect.runPromise(
      this.#engine.inspectImage(HOST_SHELL_IMAGE).pipe(Effect.result)
    )
    if (Result.isFailure(image)) {
      if (!isDockerNotFound(image.failure)) throw image.failure
      await command("docker", ["pull", HOST_SHELL_IMAGE], { timeout: 300_000 })
    }
    const owner = relayOwnerLabel(this.#config)
    const created = await Effect.runPromise(
      this.#engine.createContainer(this.#name, {
        Cmd: ["sleep", "infinity"],
        HostConfig: {
          Init: true,
          PidMode: "host",
          Privileged: true,
          RestartPolicy: { Name: "no" },
        },
        Image: HOST_SHELL_IMAGE,
        Labels: {
          [HOST_SHELL_LABEL]: "host-shell",
          ...(owner ? Object.fromEntries([owner.split("=", 2)]) : {}),
        },
      })
    )
    await Effect.runPromise(this.#engine.startContainer(created.Id))
    return { id: created.Id, running: true }
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
export function hostTerminalTarget(
  container: { id: string; running: boolean } | null
): TerminalTarget {
  return {
    command: [
      "nsenter",
      "--target",
      "1",
      "--mount",
      "--uts",
      "--ipc",
      "--net",
      "--root",
      "--wd",
      "--no-fork",
      "--",
      "sh",
      "-c",
      'cd "$HOME" 2>/dev/null || cd /; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi',
    ],
    containerId: container?.id ?? null,
    environment: ["HOME=/root"],
    key: HOST_TERMINAL_KEY,
    running: container?.running ?? false,
    stoppedMessage: "The host shell could not start",
  }
}

export const HOST_TERMINAL_KEY = "relay:host"
