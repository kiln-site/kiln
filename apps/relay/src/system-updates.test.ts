import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
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
    for (const prefix of new Set([
      "ghcr.io/kiln-site",
      this.currentImagePrefix,
    ])) {
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

describe("system updates", () => {
  effectIt.effect("starts a stable update from the promoted image digest", () =>
    withTemporaryDataDirectory((dataDirectory) =>
      Effect.gen(function* () {
        const manager = yield* Effect.promise(() =>
          docker.manager({ dataDirectory })
        )

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

  effectIt.effect(
    "serializes a concurrent apply and records cancellation before launch",
    () =>
      withTemporaryDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          docker.holdPull = true
          const manager = yield* Effect.promise(() =>
            docker.manager({ dataDirectory })
          )
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

  effectIt.effect("rejects a container labeled for another installation", () =>
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
