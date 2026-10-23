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
import { beforeEach, describe, expect } from "vite-plus/test"

import { relaySnapshotSchema } from "@workspace/contracts"

import { SystemUpdateManager, type UpdateOperation } from "./system-updates.js"
import { fakeDocker, type HeldOperation } from "./test/docker.js"
import { KILN_IMAGE_SOURCE } from "./update-container.js"

const targetImage = `ghcr.io/kiln-site/relay@sha256:${"a".repeat(64)}`
const hearthImage = `ghcr.io/kiln-site/hearth@sha256:${"b".repeat(64)}`

/**
 * The Relay and Hearth containers of an installation, and the release
 * images a registry offers, installed into the fake Docker as a test starts
 * an update.
 */
class Installation {
  currentVersion = "0.1.0-nightly.1"
  currentImagePrefix = "ghcr.io/kiln-site"
  currentImageSource = KILN_IMAGE_SOURCE
  imageSource = KILN_IMAGE_SOURCE
  imageVersion = "0.1.0-nightly.18"
  #held: HeldOperation | null = null

  /** Holds the next pull until this is set back to false. */
  set holdPull(hold: boolean) {
    if (hold) this.#held = fakeDocker.hold({ command: "pull" })
    else this.#held?.release()
  }

  get pullStarted(): Promise<void> {
    if (!this.#held) throw new Error("No pull is held")
    return this.#held.reached
  }

  get relay() {
    return this.#installed("kiln-relay")
  }

  /** The update helpers' containers, by name. */
  get helpers() {
    return new Map(
      [...fakeDocker.containers.values()]
        .filter((container) => container.name.startsWith("kiln-updater-"))
        .map((container) => [
          container.name,
          {
            env: container.env,
            running: container.state.running,
            volumesFrom: container.volumesFrom[0],
          },
        ])
    )
  }

  get pulledImages(): Set<string> {
    return new Set(fakeDocker.pulls.keys())
  }

  addHelper(name: string) {
    this.install()
    fakeDocker.addContainer({ image: targetImage, name, running: true })
  }

  stopHelper(name: string) {
    fakeDocker.exit(name, { exitCode: 0 })
  }

  async manager(
    options: {
      dataDirectory: string
      gitRepository?: string
      installationId?: string | null
      installationIdConfigured?: boolean
    },
    hooks: ConstructorParameters<typeof SystemUpdateManager>[1] = {}
  ): Promise<SystemUpdateManager> {
    this.install()
    return new SystemUpdateManager(
      {
        ...options,
        dockerSocket: await fakeDocker.listen(),
      },
      hooks
    )
  }

  install() {
    if (fakeDocker.container("kiln-relay")) return
    fakeDocker.addContainer({
      hostname: "custom-relay-hostname",
      image: `${this.currentImagePrefix}/relay:latest`,
      labels: {
        "io.kiln.component": "relay",
        "org.opencontainers.image.source": this.currentImageSource,
        "org.opencontainers.image.version": this.currentVersion,
      },
      name: "kiln-relay",
      running: true,
    })
    fakeDocker.addContainer({
      hostname: "hearth-hostname",
      image: "ghcr.io/kiln-site/hearth:latest",
      labels: {
        "io.kiln.component": "hearth",
        "org.opencontainers.image.source": KILN_IMAGE_SOURCE,
        "org.opencontainers.image.version": "0.1.0-nightly.1",
      },
      name: "kiln-hearth",
      running: true,
    })
    for (const prefix of new Set(["ghcr.io/kiln-site", this.currentImagePrefix])) {
      for (const component of ["relay", "hearth"] as const) {
        fakeDocker.images.set(
          `${prefix}/${component}@sha256:${(component === "relay" ? "a" : "b").repeat(64)}`,
          {
            "io.kiln.component": component,
            "org.opencontainers.image.source": this.imageSource,
            "org.opencontainers.image.version": this.imageVersion,
          }
        )
      }
    }
  }

  #installed(name: string) {
    const container = fakeDocker.container(name)
    if (!container) throw new Error(`${name} is not installed`)
    return container
  }
}

let docker: Installation

beforeEach(() => {
  fakeDocker.reset()
  docker = new Installation()
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
        const manager = yield* Effect.promise(() => docker.manager({ dataDirectory }))

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
            volumesFrom: docker.relay.id,
          }
        )
      })
    )
  )

  // A Relay that installed Kiln holds Hearth for maintenance by taking its
  // update lock, then checking for updates; updates check maintenance again
  // once they hold that lock, so one admitted just before never starts it.
  effectIt.effect("refuses a target that maintenance holds by the time it's locked", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        let checks = 0
        const manager = yield* Effect.promise(() =>
          docker.manager(
            { dataDirectory },
            {
              refuseTarget: () =>
                Effect.sync(() =>
                  ++checks > 1 ? "Kiln's Hearth is held stopped" : null
                ),
            }
          )
        )

        const operation = yield* manager.start({
          ...relayTarget,
          version: "0.1.0",
        })

        expect(operation).toMatchObject({
          error: "Kiln's Hearth is held stopped",
          status: "failed",
        })
        expect(docker.helpers.size).toBe(0)
        // Its lock is given back.
        expect(
          yield* Effect.promise(() =>
            readdir(join(dataDirectory, "updates"))
          ).pipe(Effect.map((files) => files.filter((f) => f.endsWith(".lock"))))
        ).toEqual([])
      })
    )
  )

  effectIt.effect("fails an image whose version is not the release", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        docker.imageVersion = "0.1.1-nightly.1"
        const manager = yield* Effect.promise(() => docker.manager({ dataDirectory }))

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
        const manager = yield* Effect.promise(() =>
          docker.manager({ dataDirectory, gitRepository: docker.imageSource })
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
        const manager = yield* Effect.promise(() => docker.manager({ dataDirectory }))

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
        const manager = yield* Effect.promise(() => docker.manager({ dataDirectory }))

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
          const manager = yield* Effect.promise(() => docker.manager({ dataDirectory }))

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
        const manager = yield* Effect.promise(() => docker.manager({ dataDirectory }))

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
          const manager = yield* Effect.promise(() => docker.manager({ dataDirectory }))
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
          const manager = yield* Effect.promise(() => docker.manager({ dataDirectory }))
          const operation = staleOperation()
          const helperName = `kiln-updater-${operation.id}`
          docker.addHelper(helperName)
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

          docker.stopHelper(helperName)
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
          const manager = yield* Effect.promise(() => docker.manager({ dataDirectory }))
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

  effectIt.effect(
    "reports an update from its acceptance, through the Relay's replacement, to its outcome",
    () =>
      withTemporaryDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          docker.holdPull = true
          const manager = yield* Effect.promise(() =>
            docker.manager({ dataDirectory })
          )
          expect(yield* manager.updates()).toEqual([])
          const requestId = "33333333-3333-4333-8333-333333333333"
          const starting = yield* manager
            .startBatch({
              helperImage: targetImage,
              requestId,
              targets: [{ ...relayTarget, version: "0.1.0" }],
            })
            .pipe(Effect.forkChild)
          yield* Effect.promise(() => docker.pullStarted)

          // Reported, named by its request, while its images are pulled.
          const [pulling] = yield* manager.updates()
          expect(pulling).toMatchObject({
            component: "relay",
            phase: "Preparing",
            requestId,
            status: "running",
          })
          // A pull long enough to look stale doesn't fail an update whose
          // helper hasn't launched yet.
          const recorded = yield* readRecord(dataDirectory, pulling!.id)
          yield* recordOutcome(dataDirectory, {
            ...recorded,
            startedAt: "2020-01-01T00:00:00.000Z",
          })
          expect(yield* manager.updates()).toMatchObject([
            { id: pulling!.id, status: "running" },
          ])
          expect((yield* manager.status(pulling!.id))?.status).toBe("running")

          docker.holdPull = false
          const [operation] = yield* Fiber.join(starting)
          expect(operation).toMatchObject({
            id: pulling!.id,
            status: "running",
          })
          expect(docker.helpers.size).toBe(1)

          // The helper replaces this Relay; its replacement reports the
          // update from the records, and the outcome the helper records.
          const replaced = yield* Effect.promise(() =>
            docker.manager({ dataDirectory })
          )
          expect(yield* replaced.updates()).toMatchObject([
            { id: operation!.id, requestId, status: "running" },
          ])
          yield* recordOutcome(dataDirectory, {
            ...operation!,
            error: "x".repeat(5_000),
            finishedAt: new Date().toISOString(),
            phase: "replace.waitUntilHealthy",
            status: "failed",
          })
          const reported = yield* replaced.updates()
          expect(reported).toMatchObject([
            { id: operation!.id, status: "failed" },
          ])
          // Hearth rejects a snapshot that doesn't match the contract.
          expect(() =>
            relaySnapshotSchema.shape.node.shape.updates.parse(reported)
          ).not.toThrow()
        })
      )
  )

  effectIt.effect(
    "leaves out a record the snapshot contract would reject, and reports later ones",
    () =>
      withTemporaryDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          const manager = yield* Effect.promise(() =>
            docker.manager({ dataDirectory })
          )
          yield* Effect.promise(() =>
            mkdir(join(dataDirectory, "updates"), { recursive: true })
          )
          yield* recordOutcome(dataDirectory, {
            ...staleOperation(),
            finishedAt: new Date().toISOString(),
            startedAt: "not-a-date",
            status: "failed",
          })
          expect(yield* manager.updates()).toEqual([])

          const operation = yield* manager.start({
            ...relayTarget,
            version: "0.1.0",
          })
          expect(yield* manager.updates()).toMatchObject([
            { id: operation.id, status: "running" },
          ])
        })
      )
  )

  effectIt.effect("recovers an orphaned target lock", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        const manager = yield* Effect.promise(() => docker.manager({ dataDirectory }))
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
          const manager = yield* Effect.promise(() => docker.manager({ dataDirectory }))

          const inspection = yield* manager.inspect("custom-relay-hostname")

          expect(inspection.container).toBe("kiln-relay")
          expect(inspection.eligible).toBe(true)
        })
      )
  )

  effectIt.effect(
    "answers that Hearth's container isn't here, but fails to find its own",
    () =>
      withTemporaryDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          const manager = yield* Effect.promise(() =>
            docker.manager({ dataDirectory })
          )

          const elsewhere = yield* manager
            .inspect("hearth-on-another-host")
            .pipe(Effect.flip)
          // This Relay's own container is the one beside it; the test host
          // has none by its hostname.
          const own = yield* manager.inspect(null).pipe(Effect.flip)

          expect(elsewhere._tag).toBe("RelayNotFoundError")
          expect(own._tag).toBe("RelaySystemUpdateError")
        })
      )
  )

  effectIt.effect(
    "rejects an unlabeled container when KILN_INSTALLATION_ID is set",
    () =>
      withTemporaryDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          const manager = yield* Effect.promise(() =>
            docker.manager({
              dataDirectory,
              installationId: "hearth-feature-a1b2c3",
              installationIdConfigured: true,
            })
          )

          const inspection = yield* manager.inspect("custom-relay-hostname")

          expect(inspection.sameInstallation).toBe(false)
          expect(inspection.eligible).toBe(false)
        })
      )
  )

  effectIt.effect(
    "updates a container from before installation IDs once Hearth sends one",
    () =>
      withTemporaryDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          const manager = yield* Effect.promise(() =>
            docker.manager({
              dataDirectory,
              installationId: "0b7e5f0e-6d0f-4a4f-9a51-0f1f6c1d2a3b",
            })
          )

          const inspection = yield* manager.inspect("custom-relay-hostname")

          expect(inspection.eligible).toBe(true)
        })
      )
  )

  effectIt.effect(
    "rejects a container labeled for another installation",
    () =>
      withTemporaryDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          const manager = yield* Effect.promise(() =>
            docker.manager({
              dataDirectory,
              installationId: "0b7e5f0e-6d0f-4a4f-9a51-0f1f6c1d2a3b",
            })
          )
          fakeDocker.container("kiln-hearth")!.labels["io.kiln.installation"] =
            "another-installation"

          const inspection = yield* manager.inspect("hearth-hostname")

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

// Records an operation's outcome as the update helper does.
function recordOutcome(dataDirectory: string, operation: UpdateOperation) {
  return Effect.promise(() =>
    writeFile(
      join(dataDirectory, "updates", `${operation.id}.json`),
      JSON.stringify(operation)
    )
  )
}

function readRecord(dataDirectory: string, id: string) {
  return Effect.promise(() =>
    readFile(join(dataDirectory, "updates", `${id}.json`), "utf8")
  ).pipe(Effect.map((text) => JSON.parse(text) as UpdateOperation))
}
