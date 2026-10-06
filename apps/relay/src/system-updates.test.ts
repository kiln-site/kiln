import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it as effectIt } from "@effect/vitest"
import { Effect, Exit, Fiber } from "effect"
import { beforeEach, describe, expect, vi } from "vite-plus/test"

import type { CommandOptions, CommandResult } from "./command.js"
import { SystemUpdateManager, type UpdateOperation } from "./system-updates.js"
import { KILN_IMAGE_SOURCE } from "./update-container.js"

const fake = vi.hoisted(() => ({ docker: null as FakeDocker | null }))

vi.mock("./command.js", () => ({
  command: (
    executable: string,
    arguments_: Array<string>,
    options?: CommandOptions
  ) => {
    if (!fake.docker) throw new Error("Fake Docker is not installed")
    return fake.docker.run(executable, arguments_, options)
  },
}))

const targetImage = `ghcr.io/kiln-site/relay@sha256:${"a".repeat(64)}`
const hearthImage = `ghcr.io/kiln-site/hearth@sha256:${"b".repeat(64)}`

const relayContainer = {
  Config: {
    Hostname: "custom-relay-hostname",
    Image: "ghcr.io/kiln-site/relay:latest",
    Labels: {
      "io.kiln.component": "relay",
      "org.opencontainers.image.source": KILN_IMAGE_SOURCE,
      "org.opencontainers.image.version": "0.1.0-nightly.1",
    },
  },
  Id: "relay-container-id",
  Name: "/kiln-relay",
}

const hearthContainer = {
  Config: {
    Hostname: "hearth-hostname",
    Image: "ghcr.io/kiln-site/hearth:latest",
    Labels: {
      "io.kiln.component": "hearth",
      "org.opencontainers.image.source": KILN_IMAGE_SOURCE,
      "org.opencontainers.image.version": "0.1.0-nightly.1",
    },
  },
  Id: "hearth-container-id",
  Name: "/kiln-hearth",
}

interface FakeHelper {
  readonly env: Record<string, string>
  running: boolean
  readonly volumesFrom: string | undefined
}

/** A small stateful stand-in for the Docker CLI behind `command`. */
class FakeDocker {
  currentVersion = "0.1.0-nightly.1"
  currentImagePrefix = "ghcr.io/kiln-site"
  currentImageSource = KILN_IMAGE_SOURCE
  imageSource = KILN_IMAGE_SOURCE
  imageVersion = "0.1.0-nightly.18"
  holdPull = false
  readonly helpers = new Map<string, FakeHelper>()
  readonly pulledImages = new Set<string>()
  readonly pullStarted: Promise<void>
  #pullStarted: () => void = () => undefined

  constructor() {
    this.pullStarted = new Promise((resolve) => {
      this.#pullStarted = resolve
    })
  }

  readonly run = async (
    _executable: string,
    arguments_: Array<string>,
    options: CommandOptions = {}
  ): Promise<CommandResult> => {
    const [subcommand, ...rest] = arguments_
    if (subcommand === "pull") {
      this.#pullStarted()
      if (this.holdPull) await waitForAbort(options.signal)
      this.pulledImages.add(rest[0] ?? "")
      return emptyResult()
    }
    if (subcommand === "image" && rest[0] === "inspect") {
      const component = rest[1] === hearthImage ? "hearth" : "relay"
      return jsonResult([
        {
          Config: {
            Labels: {
              "io.kiln.component": component,
              "org.opencontainers.image.source": this.imageSource,
              "org.opencontainers.image.version": this.imageVersion,
            },
          },
        },
      ])
    }
    if (subcommand === "run") return this.#runHelper(rest)
    if (subcommand === "rm") {
      for (const name of rest) this.helpers.delete(name)
      return emptyResult()
    }
    if (subcommand === "inspect") {
      return jsonResult(rest.map((identifier) => this.#inspect(identifier)))
    }
    if (subcommand === "ps" && rest[0] === "--quiet") {
      return {
        stderr: "",
        stdout: `${relayContainer.Id}\n${hearthContainer.Id}\n`,
      }
    }
    if (subcommand === "ps" && rest[0] === "--all") {
      const filter = rest.find((value) => value.startsWith("name="))
      const name = filter?.slice("name=^/".length, -1) ?? ""
      return { stderr: "", stdout: this.helpers.has(name) ? `${name}\n` : "" }
    }
    throw new Error(`Unexpected docker ${arguments_.join(" ")}`)
  }

  #runHelper(arguments_: Array<string>): CommandResult {
    const env: Record<string, string> = {}
    let name = ""
    let volumesFrom: string | undefined
    for (let index = 0; index < arguments_.length; index += 1) {
      const flag = arguments_[index]
      const value = arguments_[index + 1] ?? ""
      if (flag === "--name") name = value
      else if (flag === "--volumes-from") volumesFrom = value
      else if (flag === "--env") {
        const separator = value.indexOf("=")
        env[value.slice(0, separator)] = value.slice(separator + 1)
      } else continue
      index += 1
    }
    if (this.helpers.has(name)) throw new Error("Conflict: name in use")
    this.helpers.set(name, { env, running: true, volumesFrom })
    return emptyResult()
  }

  #inspect(identifier: string) {
    const helper = this.helpers.get(identifier)
    if (helper) return { State: { Running: helper.running } }
    if (identifier === "kiln-relay" || identifier === relayContainer.Id) {
      return {
        ...relayContainer,
        Config: {
          ...relayContainer.Config,
          Image: `${this.currentImagePrefix}/relay:latest`,
          Labels: {
            ...relayContainer.Config.Labels,
            "org.opencontainers.image.source": this.currentImageSource,
            "org.opencontainers.image.version": this.currentVersion,
          },
        },
      }
    }
    if (identifier === "kiln-hearth" || identifier === hearthContainer.Id) {
      return hearthContainer
    }
    throw new Error("No such container")
  }
}

let docker: FakeDocker

beforeEach(() => {
  docker = new FakeDocker()
  fake.docker = docker
})

const relayTarget = {
  helperImage: targetImage,
  targetContainer: "kiln-relay",
  targetImage,
}

describe("release image versions", () => {
  effectIt.effect("starts a stable update from the promoted image digest", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        const manager = new SystemUpdateManager({ dataDirectory })

        const operation = yield* manager.start({
          ...relayTarget,
          version: "0.1.0",
        })

        expect(operation).toMatchObject({ status: "running", version: "0.1.0" })
        // The helper runs the new Relay image, so its environment is a
        // cross-version contract.
        expect(docker.helpers.get(`kiln-updater-${operation.batchId}`)).toEqual(
          {
            env: {
              KILN_UPDATE_BATCH_ID: operation.batchId,
              KILN_UPDATE_DATA_DIR: join(dataDirectory, "updates"),
            },
            running: true,
            volumesFrom: relayContainer.Id,
          }
        )
      })
    )
  )

  effectIt.effect("fails an image whose version is not the release", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        docker.imageVersion = "0.1.1-nightly.1"
        const manager = new SystemUpdateManager({ dataDirectory })

        const operation = yield* manager.start({
          ...relayTarget,
          version: "0.1.0",
        })

        expect(operation.status).toBe("failed")
        expect(docker.helpers.size).toBe(0)
      })
    )
  )

  effectIt.effect("accepts images from the configured repository", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        docker.imageSource = "https://github.com/example/kiln-fork"
        docker.currentImageSource = docker.imageSource
        docker.currentImagePrefix = "ghcr.io/example/kiln-fork"
        const manager = new SystemUpdateManager({
          dataDirectory,
          gitRepository: docker.imageSource,
        })

        const forkImage = targetImage.replace(
          "ghcr.io/kiln-site",
          docker.currentImagePrefix
        )
        const operation = yield* manager.start({
          helperImage: forkImage,
          targetContainer: "kiln-relay",
          targetImage: forkImage,
          version: "0.1.0",
        })

        expect(operation.status).toBe("running")
      })
    )
  )

  effectIt.effect("launches one helper for a co-located update batch", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        const manager = new SystemUpdateManager({ dataDirectory })

        const operations = yield* manager.startBatch({
          helperImage: targetImage,
          targets: [
            {
              targetContainer: "kiln-relay",
              targetImage,
              version: "0.1.0",
            },
            {
              targetContainer: "kiln-hearth",
              targetImage: hearthImage,
              version: "0.1.0",
            },
          ],
        })

        expect(operations).toHaveLength(2)
        expect(new Set(operations.map(({ batchId }) => batchId)).size).toBe(1)
        expect(operations.map(({ component }) => component)).toEqual([
          "hearth",
          "relay",
        ])
        expect([...docker.helpers.keys()]).toEqual([
          `kiln-updater-${operations[0]?.batchId}`,
        ])
      })
    )
  )

  effectIt.effect("refuses to downgrade a managed container", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        docker.currentVersion = "0.1.0-nightly.12"
        const manager = new SystemUpdateManager({ dataDirectory })

        const failure = yield* manager
          .start({ ...relayTarget, version: "0.1.0-nightly.8" })
          .pipe(Effect.flip)

        expect(failure._tag).toBe("RelaySystemUpdateError")
        expect(docker.pulledImages.size).toBe(0)
        expect(docker.helpers.size).toBe(0)
      })
    )
  )

  effectIt.effect(
    "allows a newer nightly on the same stable release line",
    () =>
      withTemporaryDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          docker.currentVersion = "0.1.0"
          const manager = new SystemUpdateManager({ dataDirectory })

          const operation = yield* manager.start({
            ...relayTarget,
            version: "0.1.0-nightly.18",
          })

          expect(operation.status).toBe("running")
          expect(docker.pulledImages.has(targetImage)).toBe(true)
        })
      )
  )

  effectIt.effect("orders timestamp nightlies chronologically", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        docker.currentVersion = "0.1.0-nightly.20260726.171529"
        docker.imageVersion = "0.1.0-nightly.20260726.171530"
        const manager = new SystemUpdateManager({ dataDirectory })

        const operation = yield* manager.start({
          ...relayTarget,
          version: "0.1.0-nightly.20260726.171530",
        })

        expect(operation.status).toBe("running")
      })
    )
  )
})

describe("update operation lifecycle", () => {
  effectIt.effect(
    "serializes a concurrent apply and records cancellation before launch",
    () =>
      withTemporaryDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          docker.holdPull = true
          const manager = new SystemUpdateManager({ dataDirectory })
          const controller = new AbortController()
          const first = yield* manager
            .start({ ...relayTarget, version: "0.1.0" }, controller.signal)
            .pipe(Effect.forkChild)
          yield* Effect.promise(() => docker.pullStarted)

          const concurrent = yield* manager
            .start({ ...relayTarget, version: "0.1.0" })
            .pipe(Effect.forkChild)

          yield* Effect.sync(() => {
            docker.holdPull = false
            controller.abort(new Error("cancelled by Hearth"))
          })
          const cancelled = yield* Fiber.await(first)
          const queued = yield* Fiber.join(concurrent)
          expect(Exit.isFailure(cancelled)).toBe(true)
          expect(queued.status).toBe("running")
          expect([...docker.helpers.keys()]).toEqual([
            `kiln-updater-${queued.batchId}`,
          ])

          const updatesDirectory = join(dataDirectory, "updates")
          const operationFiles = (yield* Effect.promise(() =>
            readdir(updatesDirectory)
          )).filter(
            (name) => name.endsWith(".json") && !name.endsWith(".batch.json")
          )
          const recorded = yield* Effect.forEach(operationFiles, (name) =>
            Effect.promise(() => readFile(join(updatesDirectory, name), "utf8"))
          )
          const statuses = recorded
            .map((text) => (JSON.parse(text) as UpdateOperation).status)
            .sort()
          expect(statuses).toEqual(["failed", "running"])
        })
      )
  )

  effectIt.effect(
    "does not time out a running helper and cleans up a stopped helper",
    () =>
      withTemporaryDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          const manager = new SystemUpdateManager({ dataDirectory })
          const operation = staleOperation()
          const helperName = `kiln-updater-${operation.id}`
          docker.helpers.set(helperName, {
            env: {},
            running: true,
            volumesFrom: relayContainer.Id,
          })
          const updatesDirectory = join(dataDirectory, "updates")
          yield* Effect.promise(() =>
            mkdir(updatesDirectory, { recursive: true })
          )
          yield* Effect.promise(() =>
            writeFile(
              join(updatesDirectory, `${operation.id}.json`),
              JSON.stringify(operation)
            )
          )

          expect((yield* manager.status(operation.id))?.status).toBe("running")
          expect(docker.helpers.has(helperName)).toBe(true)

          const helper = docker.helpers.get(helperName)
          if (helper) helper.running = false
          expect((yield* manager.status(operation.id))?.status).toBe("failed")
          expect(docker.helpers.has(helperName)).toBe(false)
        })
      )
  )

  effectIt.effect(
    "releases the target lock when its fiber is interrupted",
    () =>
      withTemporaryDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          docker.holdPull = true
          const manager = new SystemUpdateManager({ dataDirectory })
          const controller = new AbortController()
          const first = yield* manager
            .start({ ...relayTarget, version: "0.1.0" }, controller.signal)
            .pipe(Effect.forkChild)
          yield* Effect.promise(() => docker.pullStarted)
          yield* Effect.sync(() => {
            first.interruptUnsafe()
          })
          const interrupted = yield* Fiber.await(first)
          expect(Exit.isFailure(interrupted)).toBe(true)

          docker.holdPull = false
          const next = yield* manager.start({
            ...relayTarget,
            version: "0.1.0",
          })
          expect(next.status).toBe("running")
        })
      )
  )

  effectIt.effect("recovers an orphaned target lock", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        const manager = new SystemUpdateManager({ dataDirectory })
        const updatesDirectory = join(dataDirectory, "updates")
        const lockPath = join(updatesDirectory, "kiln-relay.lock")
        yield* Effect.promise(() =>
          mkdir(updatesDirectory, { recursive: true })
        )
        yield* Effect.promise(() =>
          writeFile(lockPath, "22222222-2222-4222-8222-222222222222\n")
        )
        yield* Effect.promise(() => utimes(lockPath, new Date(0), new Date(0)))

        const operation = yield* manager.start({
          ...relayTarget,
          version: "0.1.0",
        })

        expect(operation.status).toBe("running")
      })
    )
  )
})

describe("container identity", () => {
  effectIt.effect(
    "falls back from a custom hostname to the matching Docker container",
    () =>
      withTemporaryDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          const manager = new SystemUpdateManager({ dataDirectory })

          const inspection = yield* manager.inspect("custom-relay-hostname")

          expect(inspection.container).toBe("kiln-relay")
          expect(inspection.eligible).toBe(true)
        })
      )
  )

  effectIt.effect("rejects a container from another Kiln installation", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        const manager = new SystemUpdateManager({
          dataDirectory,
          installationId: "hearth-feature-a1b2c3",
        })

        const inspection = yield* manager.inspect("custom-relay-hostname")

        expect(inspection.sameInstallation).toBe(false)
        expect(inspection.eligible).toBe(false)
      })
    )
  )
})

function staleOperation(): UpdateOperation {
  return {
    component: "relay",
    error: null,
    finishedAt: null,
    id: "11111111-1111-4111-8111-111111111111",
    previousImage: "ghcr.io/kiln-site/relay:latest",
    requestedImage: targetImage,
    startedAt: "2020-01-01T00:00:00.000Z",
    status: "running",
    targetContainer: "kiln-relay",
    version: "0.1.0",
  }
}

function removeTemporaryDirectory(directory: string): Promise<void> {
  if (!directory.startsWith(join(tmpdir(), "kiln-system-updates-"))) {
    return Promise.reject(new Error("Refusing to remove a non-test directory"))
  }
  return rm(directory, { force: true, recursive: true })
}

function withTemporaryDataDirectory<TResult, TError, TRequirements>(
  use: (directory: string) => Effect.Effect<TResult, TError, TRequirements>
) {
  return Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "kiln-system-updates-"))),
    use,
    (directory) => Effect.promise(() => removeTemporaryDirectory(directory))
  )
}

function emptyResult(): CommandResult {
  return { stderr: "", stdout: "" }
}

function jsonResult(value: unknown): CommandResult {
  return { stderr: "", stdout: JSON.stringify(value) }
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) throw new Error("Expected an abort signal")
  if (signal.aborted) throw abortError(signal)
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(abortError(signal)), {
      once: true,
    })
  })
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("cancelled")
}
