import { it as effectIt } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"

import {
  KILN_IMAGE_SOURCE,
  managedImageChannel,
  replaceContainerEffect,
  type ContainerInspect,
  type ContainerUpdateDocker,
  type ImageInspect,
} from "./update-container.js"

const currentContainerId = "a".repeat(64)
const currentContainer: ContainerInspect = {
  Config: {
    Cmd: ["old-command"],
    Entrypoint: ["old-entrypoint"],
    Env: ["EXAMPLE=true"],
    Healthcheck: {
      Interval: 10_000_000_000,
      Test: ["CMD", "old-healthcheck"],
    },
    Hostname: currentContainerId.slice(0, 12),
    Image: "ghcr.io/kiln-site/hearth:latest-nightly",
    Labels: {
      "coolify.managed": "true",
      "io.kiln.component": "hearth",
      "org.opencontainers.image.revision": "old-commit",
      "org.opencontainers.image.source": KILN_IMAGE_SOURCE,
      "org.opencontainers.image.version": "0.1.0-nightly.1",
    },
  },
  HostConfig: {
    NetworkMode: "kiln",
    RestartPolicy: { Name: "unless-stopped" },
  },
  Id: currentContainerId,
  Image: "sha256:old-image",
  Name: "/hearth",
  NetworkSettings: {
    Networks: {
      edge: { Aliases: ["hearth-edge", "b".repeat(64)] },
      kiln: { Aliases: ["hearth", "a".repeat(64)] },
    },
  },
  State: {
    Running: true,
  },
}

const targetImage: ImageInspect = {
  Config: {
    Healthcheck: {
      Interval: 5_000_000_000,
      Test: ["CMD", "new-healthcheck"],
    },
    Labels: {
      "io.kiln.component": "hearth",
      "org.opencontainers.image.revision": "new-commit",
      "org.opencontainers.image.source": KILN_IMAGE_SOURCE,
      "org.opencontainers.image.version": "0.1.0-nightly.2",
    },
  },
}

interface FakeContainer {
  readonly config: unknown
  readonly id: string
  readonly networks: Record<string, Array<string>>
  running: boolean
}

const channelReference = "ghcr.io/kiln-site/hearth:latest-nightly"
const targetDigest = `ghcr.io/kiln-site/hearth@sha256:${"c".repeat(64)}`
const replacement = {
  backupName: "hearth-backup",
  targetContainer: "hearth",
  targetImage: targetDigest,
  targetReference: channelReference,
  targetVersion: "0.1.0-nightly.2",
}
const ignorePhase = () => Effect.void

/** A small stateful Docker daemon: named containers plus image tags. */
class FakeDocker implements ContainerUpdateDocker {
  readonly containers = new Map<string, FakeContainer>()
  readonly tags = new Map<string, string>()
  failCommand: string | null = null
  failHealthCheck = false

  constructor(readonly current: ContainerInspect = currentContainer) {
    this.containers.set("hearth", {
      config: current.Config,
      id: current.Id,
      networks: {},
      running: true,
    })
    this.tags.set(channelReference, current.Image)
  }

  async command(
    arguments_: Array<string>
  ): Promise<{ stderr: string; stdout: string }> {
    if (arguments_.join(" ") === this.failCommand) {
      throw new Error(`command failed: ${this.failCommand}`)
    }
    const [subcommand, ...rest] = arguments_
    const name = rest.at(-1) ?? ""
    if (subcommand === "image" && rest[0] === "tag") {
      this.tags.set(rest[2] ?? "", rest[1] ?? "")
    } else if (subcommand === "stop") {
      this.#container(name).running = false
    } else if (subcommand === "start") {
      this.#container(name).running = true
    } else if (subcommand === "rm") {
      this.containers.delete(name)
    } else if (subcommand === "rename") {
      const [from = "", to = ""] = rest
      const container = this.#container(from)
      if (this.containers.has(to)) throw new Error(`${to} already exists`)
      this.containers.delete(from)
      this.containers.set(to, container)
    } else if (subcommand === "network" && rest[0] === "connect") {
      const aliases = rest.filter((_, index) => rest[index - 1] === "--alias")
      this.#container(name).networks[rest.at(-2) ?? ""] = aliases
    } else {
      throw new Error(`Unexpected docker ${arguments_.join(" ")}`)
    }
    return { stderr: "", stdout: "" }
  }

  async createContainer(name: string, configuration: unknown): Promise<void> {
    if (this.containers.has(name)) throw new Error(`${name} already exists`)
    const endpoints = (
      configuration as {
        NetworkingConfig: {
          EndpointsConfig: Record<string, { Aliases: Array<string> }>
        }
      }
    ).NetworkingConfig.EndpointsConfig
    this.containers.set(name, {
      config: configuration,
      id: "replacement",
      networks: Object.fromEntries(
        Object.entries(endpoints).map(([network, { Aliases }]) => [
          network,
          Aliases,
        ])
      ),
      running: false,
    })
  }

  async inspectContainer(): Promise<ContainerInspect> {
    return this.current
  }

  async inspectImage(): Promise<ImageInspect> {
    return targetImage
  }

  async waitUntilHealthy(name: string): Promise<void> {
    if (this.failHealthCheck || !this.#container(name).running) {
      throw new Error("unhealthy")
    }
  }

  #container(name: string): FakeContainer {
    const container = this.containers.get(name)
    if (!container) throw new Error(`No such container: ${name}`)
    return container
  }
}

describe("managed update channels", () => {
  it("accepts only the matching floating channel tags", () => {
    expect(
      managedImageChannel("ghcr.io/kiln-site/hearth:latest", "hearth")
    ).toBe("ghcr.io/kiln-site/hearth:latest")
    expect(
      managedImageChannel("ghcr.io/kiln-site/hearth:latest-nightly", "hearth")
    ).toBe("ghcr.io/kiln-site/hearth:latest-nightly")
    expect(
      managedImageChannel("ghcr.io/kiln-site/hearth:0.1.0", "hearth")
    ).toBeNull()
    expect(
      managedImageChannel(
        `ghcr.io/kiln-site/hearth@sha256:${"a".repeat(64)}`,
        "hearth"
      )
    ).toBeNull()
    expect(
      managedImageChannel("ghcr.io/kiln-site/relay:latest", "hearth")
    ).toBeNull()
  })
})

describe("container replacement", () => {
  effectIt.effect(
    "refreshes image metadata and Docker's generated hostname",
    () =>
      Effect.gen(function* () {
        const docker = new FakeDocker()

        yield* replaceContainerEffect(replacement, docker, ignorePhase)

        const replaced = docker.containers.get("hearth")
        expect(replaced).toMatchObject({
          id: "replacement",
          networks: {
            edge: ["hearth-edge", "hearth"],
            kiln: ["hearth"],
          },
          running: true,
        })
        expect(replaced?.config).toEqual(
          expect.objectContaining({
            Image: channelReference,
            Healthcheck: {
              Interval: 5_000_000_000,
              Test: ["CMD", "new-healthcheck"],
            },
            Labels: {
              "coolify.managed": "true",
              "io.kiln.component": "hearth",
              "org.opencontainers.image.revision": "new-commit",
              "org.opencontainers.image.source": KILN_IMAGE_SOURCE,
              "org.opencontainers.image.version": "0.1.0-nightly.2",
            },
          })
        )
        expect(replaced?.config).not.toHaveProperty("Cmd")
        expect(replaced?.config).not.toHaveProperty("Entrypoint")
        expect(replaced?.config).not.toHaveProperty("Hostname")
        expect(docker.containers.has("hearth-backup")).toBe(false)
        expect(docker.tags.get(channelReference)).toBe(targetDigest)
      })
  )

  effectIt.effect("reports replacement phases in execution order", () =>
    Effect.gen(function* () {
      const phases: Array<string> = []

      yield* replaceContainerEffect(replacement, new FakeDocker(), (phase) =>
        Effect.sync(() => {
          phases.push(phase)
        })
      )

      expect(phases).toEqual([
        "replace.inspectContainer",
        "replace.tagTarget",
        "replace.stopCurrent",
        "replace.renameCurrent",
        "replace.createTarget",
        "replace.connectNetwork",
        "replace.startTarget",
        "replace.waitUntilHealthy",
        "replace.removeBackup",
      ])
    })
  )

  effectIt.effect("preserves an explicitly configured hostname", () =>
    Effect.gen(function* () {
      const docker = new FakeDocker({
        ...currentContainer,
        Config: {
          ...currentContainer.Config,
          Hostname: "hearth.internal",
        },
      })

      yield* replaceContainerEffect(replacement, docker, ignorePhase)

      expect(docker.containers.get("hearth")?.config).toEqual(
        expect.objectContaining({ Hostname: "hearth.internal" })
      )
    })
  )

  effectIt.effect(
    "records the stable release version for a promoted nightly image",
    () =>
      Effect.gen(function* () {
        const docker = new FakeDocker()

        yield* replaceContainerEffect(
          {
            ...replacement,
            targetReference: "ghcr.io/kiln-site/hearth:latest",
            targetVersion: "0.1.0",
          },
          docker,
          ignorePhase
        )

        expect(docker.containers.get("hearth")?.config).toEqual(
          expect.objectContaining({
            Labels: expect.objectContaining({
              "org.opencontainers.image.version": "0.1.0",
            }),
          })
        )
      })
  )

  effectIt.effect(
    "restores the old container and channel image after a failed health check",
    () =>
      Effect.gen(function* () {
        const docker = new FakeDocker()
        docker.failHealthCheck = true

        const failure = yield* replaceContainerEffect(
          replacement,
          docker,
          ignorePhase
        ).pipe(Effect.flip)

        expect(failure.phase).toBe("replace")
        expect(failure.rollbackFailures).toEqual([])
        expect(docker.containers.get("hearth")).toMatchObject({
          id: currentContainerId,
          running: true,
        })
        expect(docker.containers.has("hearth-backup")).toBe(false)
        expect(docker.tags.get(channelReference)).toBe("sha256:old-image")
      })
  )

  effectIt.effect(
    "attempts every rollback step and reports rollback failures",
    () =>
      Effect.gen(function* () {
        const docker = new FakeDocker()
        docker.failHealthCheck = true
        docker.failCommand = "rm --force hearth"

        const failure = yield* replaceContainerEffect(
          replacement,
          docker,
          ignorePhase
        ).pipe(Effect.flip)

        expect(failure.rollbackFailures.length).toBeGreaterThan(0)
        // The old container is kept for manual recovery and the channel tag
        // is still restored after the earlier rollback step failed.
        expect(docker.containers.get("hearth-backup")?.id).toBe(
          currentContainerId
        )
        expect(docker.tags.get(channelReference)).toBe("sha256:old-image")
      })
  )
})
