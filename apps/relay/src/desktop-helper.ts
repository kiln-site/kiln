import { Effect } from "effect"
import { hostname } from "node:os"

import type { RelayConfig } from "./config.js"
import { DesktopUnavailableError } from "./desktop-backend.js"
import {
  DockerEngine,
  isDockerNotFound,
  type DockerContainerInspect,
} from "./docker-engine.js"
import { recoverPromise } from "./effect/promise.js"
import { RELAY_OWNER_LABEL, relayOwnsLabels } from "./relay-resources.js"

// A container that helps show a desktop, beside the Relay and in its network
// namespace, so it listens only where the Relay can reach it.

const DESKTOP_LABEL = "kiln.relay.infrastructure"
const CONFIG_LABEL = "kiln.relay.desktop.config"

type HelperConfig = Pick<RelayConfig, "dockerSocket" | "resourceNamespace">

export class DesktopHelper {
  readonly engine: DockerEngine
  readonly name: string
  readonly #config: HelperConfig

  constructor(config: HelperConfig, name: string) {
    this.#config = config
    this.engine = new DockerEngine(config.dockerSocket)
    this.name = config.resourceNamespace
      ? `${config.resourceNamespace}-${name}`
      : name
  }

  /** The Relay's own container, whose network namespace a helper joins. */
  relayContainer(): Promise<DockerContainerInspect> {
    return recoverPromise(
      () =>
        Effect.runPromise(
          this.engine.inspectContainer<DockerContainerInspect>(hostname())
        ),
      () => {
        throw new DesktopUnavailableError(
          "The desktop needs the Relay to run in a Docker container"
        )
      }
    )
  }

  async inspect(): Promise<DockerContainerInspect | null> {
    return Effect.runPromise(
      this.engine
        .inspectContainer<DockerContainerInspect>(this.name)
        .pipe(
          Effect.catch((cause) =>
            isDockerNotFound(cause) ? Effect.succeed(null) : Effect.fail(cause)
          )
        )
    )
  }

  /** The helper as it is now, refusing one that isn't this Relay's to touch. */
  async existing(): Promise<DockerContainerInspect | null> {
    const existing = await this.inspect()
    if (existing && !this.#owns(existing)) {
      throw new Error(
        `Docker container ${this.name} exists but is not owned by this Relay`
      )
    }
    return existing
  }

  /** Whether `container` runs as `signature` says, so it can be kept. */
  matches(container: DockerContainerInspect, signature: string): boolean {
    return (
      container.State.Running &&
      container.Config.Labels?.[CONFIG_LABEL] === signature
    )
  }

  labels(signature: string): Record<string, string> {
    return {
      [DESKTOP_LABEL]: "desktop",
      [CONFIG_LABEL]: signature,
      "kiln.relay.owned": "true",
      ...(this.#config.resourceNamespace
        ? { [RELAY_OWNER_LABEL]: this.#config.resourceNamespace }
        : {}),
    }
  }

  remove(id: string): Promise<void> {
    return Effect.runPromise(
      this.engine.removeContainer(id, { force: true })
    ).then(() => undefined)
  }

  /** Removes the helper if it's there and this Relay's. */
  async release(): Promise<void> {
    const existing = await this.inspect()
    if (existing && this.#owns(existing)) await this.remove(existing.Id)
  }

  #owns(container: DockerContainerInspect): boolean {
    return (
      relayOwnsLabels(this.#config, container.Config.Labels) &&
      container.Config.Labels?.[DESKTOP_LABEL] === "desktop"
    )
  }
}
