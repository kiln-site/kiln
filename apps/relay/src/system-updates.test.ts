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
import { describe, expect, it } from "vite-plus/test"

import {
  imageVersionMatchesRelease,
  SystemUpdateManager,
  type UpdateOperation,
} from "./system-updates.js"
import { KILN_IMAGE_SOURCE } from "./update-container.js"
import type { CommandOptions, CommandResult } from "./command.js"

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

class FakeCommand {
  readonly calls: Array<Array<string>> = []
  currentVersion = "0.1.0-nightly.1"
  currentImagePrefix = "ghcr.io/kiln-site"
  currentImageSource = KILN_IMAGE_SOURCE
  imageSource = KILN_IMAGE_SOURCE
  imageVersion = "0.1.0-nightly.18"
  helperRunning = true
  holdPull = false
  pullStarted: Promise<void>
  #pullStarted: (() => void) | null = null

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
    this.calls.push(arguments_)
    if (arguments_[0] === "pull") {
      this.#pullStarted?.()
      if (this.holdPull) await waitForAbort(options.signal)
      return emptyResult()
    }
    if (arguments_[0] === "image" && arguments_[1] === "inspect") {
      const component = arguments_[2] === hearthImage ? "hearth" : "relay"
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
    if (arguments_[0] === "inspect") {
      const identifier = arguments_[1]
      if (identifier?.startsWith("kiln-updater-")) {
        return jsonResult([{ State: { Running: this.helperRunning } }])
      }
      if (
        identifier === "kiln-relay" ||
        identifier === relayContainer.Id ||
        arguments_.includes(relayContainer.Id)
      ) {
        return jsonResult([
          {
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
          },
        ])
      }
      if (
        identifier === "kiln-hearth" ||
        identifier === hearthContainer.Id ||
        arguments_.includes(hearthContainer.Id)
      ) {
        return jsonResult([hearthContainer])
      }
      throw new Error("No such container")
    }
    if (arguments_[0] === "ps" && arguments_[1] === "--quiet") {
      return {
        stderr: "",
        stdout: `${relayContainer.Id}\n${hearthContainer.Id}\n`,
      }
    }
    if (arguments_[0] === "ps" && arguments_[1] === "--all") {
      return { stderr: "", stdout: "" }
    }
    return emptyResult()
  }
}

describe("release image versions", () => {
  it("accepts a promoted nightly digest for its stable release", () => {
    expect(imageVersionMatchesRelease("0.1.0-nightly.18", "0.1.0")).toBe(true)
    expect(
      imageVersionMatchesRelease("0.1.0-nightly.20260726.171530", "0.1.0")
    ).toBe(true)
    expect(imageVersionMatchesRelease("0.1.1-nightly.1", "0.1.0")).toBe(false)
    expect(
      imageVersionMatchesRelease("0.1.0-nightly.18", "0.1.0-nightly.19")
    ).toBe(false)
  })

  effectIt.effect("starts a stable update from the promoted image digest", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        const docker = new FakeCommand()
        const manager = new SystemUpdateManager({ dataDirectory }, docker.run)

        const operation = yield* manager.start({
          helperImage: targetImage,
          targetContainer: "kiln-relay",
          targetImage,
          version: "0.1.0",
        })

        expect(operation.status).toBe("running")
        expect(operation.version).toBe("0.1.0")
        const run = docker.calls.find((arguments_) => arguments_[0] === "run")
        expect(run).toContain(`KILN_UPDATE_BATCH_ID=${operation.batchId}`)
        expect(run).toContain(relayContainer.Id)
      })
    )
  )

  effectIt.effect("accepts images from the configured repository", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        const docker = new FakeCommand()
        docker.imageSource = "https://github.com/example/kiln-fork"
        docker.currentImageSource = docker.imageSource
        docker.currentImagePrefix = "ghcr.io/example/kiln-fork"
        const manager = new SystemUpdateManager(
          { dataDirectory, gitRepository: docker.imageSource },
          docker.run
        )

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
        const docker = new FakeCommand()
        const manager = new SystemUpdateManager({ dataDirectory }, docker.run)

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
        expect(
          docker.calls.filter((arguments_) => arguments_[0] === "run")
        ).toHaveLength(1)
      })
    )
  )

  effectIt.effect("refuses to downgrade a managed container", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        const docker = new FakeCommand()
        docker.currentVersion = "0.1.0-nightly.12"
        const manager = new SystemUpdateManager({ dataDirectory }, docker.run)

        const failure = yield* manager
          .start({
            helperImage: targetImage,
            targetContainer: "kiln-relay",
            targetImage,
            version: "0.1.0-nightly.8",
          })
          .pipe(Effect.flip)
        expect(failure.message).toContain(
          "Refusing to downgrade 0.1.0-nightly.12 to 0.1.0-nightly.8"
        )
        expect(
          docker.calls.some((arguments_) => arguments_[0] === "pull")
        ).toBe(false)
      })
    )
  )

  effectIt.effect(
    "allows a newer nightly on the same stable release line",
    () =>
      withTemporaryDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          const docker = new FakeCommand()
          docker.currentVersion = "0.1.0"
          const manager = new SystemUpdateManager({ dataDirectory }, docker.run)

          const operation = yield* manager.start({
            helperImage: targetImage,
            targetContainer: "kiln-relay",
            targetImage,
            version: "0.1.0-nightly.18",
          })

          expect(operation.status).toBe("running")
          expect(
            docker.calls.some((arguments_) => arguments_[0] === "pull")
          ).toBe(true)
        })
      )
  )

  effectIt.effect("orders timestamp nightlies chronologically", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        const docker = new FakeCommand()
        docker.currentVersion = "0.1.0-nightly.20260726.171529"
        docker.imageVersion = "0.1.0-nightly.20260726.171530"
        const manager = new SystemUpdateManager({ dataDirectory }, docker.run)

        const operation = yield* manager.start({
          helperImage: targetImage,
          targetContainer: "kiln-relay",
          targetImage,
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
          const docker = new FakeCommand()
          docker.holdPull = true
          const manager = new SystemUpdateManager({ dataDirectory }, docker.run)
          const controller = new AbortController()
          const first = yield* manager
            .start(
              {
                helperImage: targetImage,
                targetContainer: "kiln-relay",
                targetImage,
                version: "0.1.0",
              },
              controller.signal
            )
            .pipe(Effect.forkChild)
          yield* Effect.promise(() => docker.pullStarted)

          const concurrent = yield* manager
            .start({
              helperImage: targetImage,
              targetContainer: "kiln-relay",
              targetImage,
              version: "0.1.0",
            })
            .pipe(Effect.forkChild)

          yield* Effect.sync(() => {
            docker.holdPull = false
            controller.abort(new Error("cancelled by Hearth"))
          })
          const cancelled = yield* Fiber.await(first)
          const queued = yield* Fiber.join(concurrent)
          expect(Exit.isFailure(cancelled)).toBe(true)
          expect(queued.status).toBe("running")
          expect(
            docker.calls.some((arguments_) => arguments_[0] === "run")
          ).toBe(true)

          const operationFiles = (yield* Effect.promise(() =>
            readdir(join(dataDirectory, "updates"))
          )).filter(
            (name) => name.endsWith(".json") && !name.endsWith(".batch.json")
          )
          expect(operationFiles).toHaveLength(2)
          const recordedOperations = yield* Effect.forEach(
            operationFiles,
            (name) =>
              Effect.promise(() =>
                readFile(join(dataDirectory, "updates", name), "utf8")
              ).pipe(
                Effect.map((text) => {
                  const decoded: unknown = JSON.parse(text)
                  return decoded
                })
              )
          )
          const cancelledOperation = recordedOperations.find(
            (operation) =>
              typeof operation === "object" &&
              operation !== null &&
              "status" in operation &&
              operation.status === "failed"
          )
          expect(cancelledOperation).toMatchObject({
            error:
              "The update request was cancelled before replacement started.",
            status: "failed",
          })
        })
      )
  )

  effectIt.effect(
    "does not time out a running helper and cleans up a stopped helper",
    () =>
      withTemporaryDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          const docker = new FakeCommand()
          const manager = new SystemUpdateManager({ dataDirectory }, docker.run)
          const operation = staleOperation()
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
          expect(
            docker.calls.some(
              (arguments_) =>
                arguments_[0] === "rm" &&
                arguments_.includes(`kiln-updater-${operation.id}`)
            )
          ).toBe(false)

          docker.helperRunning = false
          const failed = yield* manager.status(operation.id)
          expect(failed?.status).toBe("failed")
          expect(
            docker.calls.some(
              (arguments_) =>
                arguments_[0] === "rm" &&
                arguments_.includes("--force") &&
                arguments_.includes(`kiln-updater-${operation.id}`)
            )
          ).toBe(true)
        })
      )
  )

  effectIt.effect(
    "releases the target lock when its fiber is interrupted",
    () =>
      withTemporaryDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          const docker = new FakeCommand()
          docker.holdPull = true
          const manager = new SystemUpdateManager({ dataDirectory }, docker.run)
          const controller = new AbortController()
          const first = yield* manager
            .start(
              {
                helperImage: targetImage,
                targetContainer: "kiln-relay",
                targetImage,
                version: "0.1.0",
              },
              controller.signal
            )
            .pipe(Effect.forkChild)
          yield* Effect.promise(() => docker.pullStarted)
          yield* Effect.sync(() => {
            first.interruptUnsafe()
          })
          const interrupted = yield* Fiber.await(first)
          expect(Exit.isFailure(interrupted)).toBe(true)

          docker.holdPull = false
          const next = yield* manager.start({
            helperImage: targetImage,
            targetContainer: "kiln-relay",
            targetImage,
            version: "0.1.0",
          })
          expect(next.status).toBe("running")
        })
      )
  )

  effectIt.effect("recovers an orphaned target lock", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        const docker = new FakeCommand()
        const manager = new SystemUpdateManager({ dataDirectory }, docker.run)
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
          helperImage: targetImage,
          targetContainer: "kiln-relay",
          targetImage,
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
          const docker = new FakeCommand()
          const manager = new SystemUpdateManager({ dataDirectory }, docker.run)

          const inspection = yield* manager.inspect("custom-relay-hostname")

          expect(inspection.container).toBe("kiln-relay")
          expect(inspection.eligible).toBe(true)
        })
      )
  )

  effectIt.effect("rejects a container from another Kiln installation", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        const docker = new FakeCommand()
        const manager = new SystemUpdateManager(
          { dataDirectory, installationId: "hearth-feature-a1b2c3" },
          docker.run
        )

        const inspection = yield* manager.inspect("custom-relay-hostname")

        expect(inspection.sameInstallation).toBe(false)
        expect(inspection.eligible).toBe(false)
        expect(inspection.reason).toContain("different Kiln installation")
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
