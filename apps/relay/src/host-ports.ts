import { Effect, Semaphore } from "effect"

import type { DockerContainerSummary, DockerEngine } from "./docker-engine.js"

export type HostPortProtocol = "tcp" | "udp"

export interface HostPort {
  readonly port: number
  readonly protocol: HostPortProtocol
}

/**
 * The ports published on the Relay's host, one list for game servers, Apps
 * and anything else Docker runs here.
 *
 * A port is taken while a running container binds it, whoever made the
 * container. A stopped container keeps its ports only if Kiln made it: a
 * stopped game server or App starts again where it was, while anything else
 * left stopped on the host has let its ports go. A port is also taken while
 * it is promised: chosen for a container that doesn't exist yet, or held by
 * a lease while someone fills in a form.
 *
 * It orders what Kiln hands out. A process on the host that Docker doesn't
 * run, or a port Docker picks itself when a container starts, is outside it.
 */
export class HostPorts {
  readonly #engine: DockerEngine
  // A lease holds its port between requests, which no lane does
  // (docs/relay-operations.md).
  readonly #semaphore = Semaphore.makeUnsafe(1)
  readonly #promised = new Set<string>()

  constructor(engine: DockerEngine) {
    this.#engine = engine
  }

  /** Runs `effect` with no other reservation beside it. */
  locked<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return this.#semaphore.withPermit(effect)
  }

  /** Holds a port for a container still to be made. Call it `locked`. */
  promise(port: number, protocols: ReadonlyArray<HostPortProtocol>): void {
    for (const protocol of protocols) this.#promised.add(key(port, protocol))
  }

  /** Lets a promised port go, once its container binds it or never will. */
  release(port: number, protocols: ReadonlyArray<HostPortProtocol>): void {
    for (const protocol of protocols) this.#promised.delete(key(port, protocol))
  }

  /** The ports taken for any of `protocols`. Call it `locked`. */
  async taken(
    protocols: ReadonlyArray<HostPortProtocol>
  ): Promise<Set<number>> {
    const taken = await this.#taken()
    const ports = new Set<number>()
    for (const entry of taken) {
      const [protocol, port] = entry.split(":")
      if (protocols.some((candidate) => candidate === protocol)) {
        ports.add(Number(port))
      }
    }
    return ports
  }

  /**
   * Takes `ports` for containers about to be made, refusing if another holds
   * one. Those `own` containers bind stay free, for a deployment that
   * replaces them. Returns what lets the ports go: call it once the new
   * containers bind them, or never will.
   */
  claim(
    ports: ReadonlyArray<HostPort>,
    own?: (container: DockerContainerSummary) => boolean
  ): Promise<() => void> {
    if (ports.length === 0) return Promise.resolve(() => {})
    return Effect.runPromise(
      this.locked(
        Effect.tryPromise({
          try: async () => {
            const taken = await this.#taken(own)
            for (const { port, protocol } of ports) {
              if (taken.has(key(port, protocol))) {
                throw new Error(
                  `Public port ${port}/${protocol} is already in use`
                )
              }
            }
            for (const { port, protocol } of ports) {
              this.promise(port, [protocol])
            }
            return () => {
              for (const { port, protocol } of ports) {
                this.release(port, [protocol])
              }
            }
          },
          catch: (cause) => cause,
        })
      )
    )
  }

  // Docker lists the ports a container binds now, running or paused. A
  // stopped one binds none, so its ports are read from how it was made.
  async #taken(
    own?: (container: DockerContainerSummary) => boolean
  ): Promise<Set<string>> {
    const taken = new Set(this.#promised)
    const containers = await Effect.runPromise(
      this.#engine.listContainers({ all: true })
    )
    const stopped: Array<string> = []
    for (const container of containers) {
      if (own?.(container)) continue
      if (container.State !== "running" && madeByKiln(container)) {
        stopped.push(container.Id)
      }
      for (const port of container.Ports ?? []) {
        if (port.PublicPort && isProtocol(port.Type)) {
          taken.add(key(port.PublicPort, port.Type))
        }
      }
    }
    for (const container of await Effect.runPromise(
      this.#engine.inspectContainers(stopped)
    )) {
      for (const [binding, hosts] of Object.entries(
        container.HostConfig?.PortBindings ?? {}
      )) {
        const protocol = binding.split("/")[1] ?? "tcp"
        if (!isProtocol(protocol)) continue
        for (const host of hosts ?? []) {
          const port = Number(host.HostPort)
          if (Number.isInteger(port) && port > 0) taken.add(key(port, protocol))
        }
      }
    }
    return taken
  }
}

// Every container Kiln makes carries labels of its own.
function madeByKiln(container: DockerContainerSummary): boolean {
  return Object.keys(container.Labels ?? {}).some((label) =>
    label.startsWith("kiln.")
  )
}

function key(port: number, protocol: HostPortProtocol): string {
  return `${protocol}:${port}`
}

function isProtocol(value: string): value is HostPortProtocol {
  return value === "tcp" || value === "udp"
}
