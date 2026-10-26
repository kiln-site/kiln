import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assert, it as effectIt } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import {
  relayCreateDatabaseSchema,
  relayCreateInstanceSchema,
  relayInstanceSchema,
  relayManagedDatabaseSchema,
} from "@workspace/contracts"

import { appProvisioning } from "./app-provisioning.js"
import type { AppDriver } from "./apps.js"
import { databaseProvisioning } from "./database-provisioning.js"
import type { DatabaseDriver } from "./databases.js"
import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"
import type { LifecycleDriver } from "./lifecycle.js"
import { exclusive, laneKeys, OperationLanes } from "./operation-lanes.js"
import { provisioningErrorMessage } from "./provisioning-errors.js"
import {
  type ProvisioningCapacity,
  ProvisioningManager,
} from "./provisioning.js"
import { serverProvisioning } from "./server-provisioning.js"
import { provisioningWorker, relayHarness, serverRecipe } from "./test/relay.js"

const pullFailure = new Error(
  "Command failed: docker pull private.example/image --env TOKEN=secret\nError response from daemon: manifest unknown\n"
)

describe("provisioning errors", () => {
  it("shows Docker's final detail without exposing the command line", () => {
    const message = provisioningErrorMessage(pullFailure)

    expect(message).toBe("Error response from daemon: manifest unknown")
    expect(message).not.toContain("secret")
  })

  it("turns exhausted Docker address pools into guidance instead of raw output", () => {
    const message = provisioningErrorMessage(
      new Error("An error occurred in Effect.tryPromise", {
        cause: new Error(
          "Command failed: docker network create kiln-minecraft\nError response from daemon: all predefined address pools have been fully subnetted\n"
        ),
      })
    )

    expect(message).not.toContain("Command failed")
    expect(message).not.toContain("fully subnetted")
  })
})

describe("provisioning worker", () => {
  const instanceId = "a".repeat(40)
  const input = relayCreateInstanceSchema.parse({
    diskLimitBytes: 25 * 1024 ** 3,
    name: "Paused server",
    recipe: "https://example.com/brick.yml",
    start: false,
    variables: {},
  })
  const placeholder = relayInstanceSchema.parse({
    connectAddress: "relay.example.com",
    containerId: null,
    desiredState: "stopped",
    directory: instanceId,
    game: "Minecraft",
    id: instanceId,
    implementation: "Paper",
    javaVersion: "Java 21",
    limits: { diskBytes: input.diskLimitBytes, memoryBytes: 0 },
    managedByRelay: true,
    name: input.name,
    observedState: "provisioning",
    ports: [],
    provisioning: { attempt: 0, error: null, phase: "awaiting_claim" },
    resources: null,
    service: `kiln-${instanceId}`,
    shortId: instanceId.slice(0, 8),
    status: "Waiting for Hearth",
    version: "1.21.8",
  })

  const serverInput = (instanceId: string) => ({
    kind: "server" as const,
    idempotencyKey: randomUUID(),
    input,
    instanceId,
    placeholder: { ...placeholder, directory: instanceId, id: instanceId },
  })

  const databaseInput = (instanceId: string) => {
    const input = relayCreateDatabaseSchema.parse({
      databaseName: "kiln_app",
      engine: "postgres",
      id: instanceId,
      name: `Database ${instanceId.slice(0, 4)}`,
      password: "correct-horse-battery-staple-1",
      username: "kiln_user",
    })
    return {
      kind: "database" as const,
      idempotencyKey: randomUUID(),
      input,
      instanceId,
      placeholder: relayManagedDatabaseSchema.parse({
        connectedInstanceIds: [],
        containerId: null,
        createdAt: new Date().toISOString(),
        databaseName: input.databaseName,
        diskUsedBytes: null,
        engine: input.engine,
        hostname: `database-${instanceId}`,
        id: instanceId,
        image: "postgres:17",
        internalPort: 5432,
        limits: { cpuMillis: null, diskBytes: null, memoryBytes: null },
        name: input.name,
        observedState: "provisioning",
        provisioning: { attempt: 0, error: null, phase: "awaiting_claim" },
        shortId: instanceId.slice(0, 8),
        status: "Waiting for Hearth",
        supportsImportExport: true,
      }),
    }
  }

  // Waits for the worker, which runs on its own fibers, to catch up.
  const until = (done: () => boolean) =>
    Effect.gen(function* () {
      for (let tries = 0; !done(); tries += 1) {
        if (tries > 10_000) throw new Error("Timed out waiting")
        yield* Effect.promise(
          () => new Promise((resolve) => setImmediate(resolve))
        )
      }
    })

  // Gives the worker a moment to start anything it was going to.
  const settle = Effect.gen(function* () {
    for (let tick = 0; tick < 50; tick += 1) {
      yield* Effect.promise(
        () => new Promise((resolve) => setImmediate(resolve))
      )
    }
  })

  // A worker over a fresh Relay state, where Docker is the one thing faked:
  // creating a game server or database runs `create`.
  const withWorker = <A, E>(
    capacity: ProvisioningCapacity,
    create: (instanceId: string) => Promise<void>,
    body: (worker: {
      lanes: OperationLanes
      manager: ProvisioningManager
      state: RelayStateStore["Service"]
    }) => Effect.Effect<A, E, RelayStateStore>
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "kiln-provisioning-"))),
      (directory) =>
        Effect.gen(function* () {
          const state = yield* RelayStateStore
          const lanes = new OperationLanes()
          const lifecycle = {
            createInstanceWithId: async (id: string) => {
              await create(id)
              return placeholder
            },
          } as unknown as LifecycleDriver
          const databases = {
            create: async (input: { id: string }) => {
              await create(input.id)
            },
          } as unknown as DatabaseDriver
          const manager = yield* ProvisioningManager.make({
            adapters: {
              // Only game servers and databases provision here.
              app: appProvisioning({} as AppDriver),
              database: databaseProvisioning(databases),
              server: serverProvisioning({
                lifecycle,
                refreshSnapshot: async () => undefined,
                state,
              }),
            },
            capacity,
            lanes,
          })
          const worker = yield* Effect.forkChild(manager.run())
          const result = yield* body({ lanes, manager, state })
          assert.isUndefined(worker.pollUnsafe())
          yield* Fiber.interrupt(worker)
          return result
        }).pipe(
          Effect.provide(makeRelayStateLayer(join(directory, "relay.sqlite")))
        ),
      (directory) =>
        Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
    )

  const idle: ProvisioningCapacity = { busy: () => false, slots: 2 }

  effectIt.effect(
    "puts back a job a pause withdrew, and creates it once resumed",
    () => {
      const created: Array<string> = []
      return withWorker(
        idle,
        async (id) => {
          created.push(id)
        },
        ({ lanes, manager, state }) =>
          Effect.gen(function* () {
            // A restore holds the server, so its job waits for its lane.
            const restoring = Deferred.makeUnsafe<void>()
            yield* Effect.forkChild(
              lanes.run(
                {
                  label: "restore",
                  locks: [exclusive(laneKeys.instance(instanceId))],
                },
                Deferred.await(restoring)
              )
            )
            yield* until(() => lanes.pending.active === 1)
            yield* manager.prepare(serverInput(instanceId))
            yield* manager.claim("server", instanceId)
            yield* until(() => lanes.pending.waiting === 1)

            lanes.setPaused(true)
            yield* until(() => lanes.pending.waiting === 0)
            let job = yield* state.getProvisioningJob(instanceId)
            for (let tries = 0; job?.status !== "queued"; tries += 1) {
              if (tries > 10_000) throw new Error("Timed out waiting")
              yield* Effect.promise(
                () => new Promise((resolve) => setImmediate(resolve))
              )
              job = yield* state.getProvisioningJob(instanceId)
            }
            assert.strictEqual(job.attempt, 0)

            Deferred.doneUnsafe(restoring, Exit.void)
            lanes.setPaused(false)
            yield* manager.resume()
            yield* until(() => created.length > 0)
            assert.deepStrictEqual(created, [instanceId])
          })
      )
    }
  )

  effectIt.effect(
    "creates different databases at once, up to its slots, and starts the next as one fails",
    () => {
      const [first, second, third] = ["a", "b", "c"].map((id) =>
        id.repeat(40)
      ) as [string, string, string]
      const started: Array<string> = []
      const finish = new Map<string, (error?: Error) => void>()
      return withWorker(
        idle,
        (id) =>
          new Promise<void>((resolve, reject) => {
            started.push(id)
            finish.set(id, (error) => (error ? reject(error) : resolve()))
          }),
        ({ manager, state }) =>
          Effect.gen(function* () {
            for (const id of [first, second, third]) {
              yield* manager.prepare(databaseInput(id))
              yield* manager.claim("database", id)
            }
            yield* until(() => started.length === 2)
            // The third waits for a free slot.
            yield* settle
            assert.deepStrictEqual(started, [first, second])

            // A failed job frees its slot as a finished one does.
            finish.get(first)!(new Error("Image not found"))
            yield* until(() => started.length === 3)
            assert.deepStrictEqual(started, [first, second, third])
            finish.get(second)!()
            finish.get(third)!()

            const settled = (id: string) =>
              state
                .getProvisioningJob(id)
                .pipe(Effect.map((job) => job?.status ?? "done"))
            let statuses: Array<string> = []
            for (let tries = 0; ; tries += 1) {
              if (tries > 10_000) throw new Error("Timed out waiting")
              statuses = yield* Effect.all([first, second, third].map(settled))
              if (!statuses.includes("running")) break
              yield* Effect.promise(
                () => new Promise((resolve) => setImmediate(resolve))
              )
            }
            assert.deepStrictEqual(statuses, ["failed", "done", "done"])
          })
      )
    }
  )

  effectIt.effect(
    "starts nothing beside a running job while the host is busy, until its load falls",
    () => {
      const [first, second] = ["d", "e"].map((id) => id.repeat(40)) as [
        string,
        string,
      ]
      let busy = true
      const started: Array<string> = []
      return withWorker(
        { busy: () => busy, slots: 4 },
        (id) =>
          new Promise<void>(() => {
            started.push(id)
          }),
        ({ manager }) =>
          Effect.gen(function* () {
            for (const id of [first, second]) {
              yield* manager.prepare(databaseInput(id))
              yield* manager.claim("database", id)
            }
            // The first job always starts, so the queue keeps moving.
            yield* until(() => started.length === 1)
            yield* settle
            assert.deepStrictEqual(started, [first])

            // Once the load falls, the next starts without waiting for the
            // first to finish.
            busy = false
            yield* TestClock.adjust("5 seconds")
            yield* until(() => started.length === 2)
            assert.deepStrictEqual(started, [first, second])
          })
      )
    }
  )

  effectIt.effect(
    "creates game servers one at a time, while a database queued after one goes ahead",
    () => {
      const [first, second, database] = ["1", "2", "3"].map((id) =>
        id.repeat(40)
      ) as [string, string, string]
      const started: Array<string> = []
      const finish = new Map<string, () => void>()
      return withWorker(
        { busy: () => false, slots: 4 },
        (id) =>
          new Promise<void>((resolve) => {
            started.push(id)
            finish.set(id, resolve)
          }),
        ({ manager }) =>
          Effect.gen(function* () {
            yield* manager.prepare(serverInput(first))
            yield* manager.prepare(serverInput(second))
            yield* manager.prepare(databaseInput(database))
            yield* manager.claim("server", first)
            yield* manager.claim("server", second)
            yield* manager.claim("database", database)
            yield* until(() => started.length === 2)
            yield* settle
            assert.deepStrictEqual(started, [first, database])

            finish.get(first)!()
            yield* until(() => started.length === 3)
            assert.deepStrictEqual(started, [first, database, second])
          })
      )
    }
  )
})

describe("provisioning game servers", () => {
  // Game servers share the Relay's game network and DNS, which creates
  // running side by side raced to set up.
  it("creates two game servers queued together", async () => {
    const harness = await relayHarness()
    const manager = await provisioningWorker(harness)
    const recipe = await harness.publishRecipe(serverRecipe())
    const ids = ["f".repeat(40), "e".repeat(40)]
    for (const id of ids) {
      const input = relayCreateInstanceSchema.parse({
        diskLimitBytes: 1024 ** 3,
        recipe,
        start: false,
        variables: {},
      })
      await Effect.runPromise(
        manager.prepare({
          kind: "server",
          idempotencyKey: randomUUID(),
          input,
          instanceId: id,
          placeholder: await harness.lifecycle.prepareInstance(id, input),
        })
      )
    }
    for (const id of ids) {
      await Effect.runPromise(manager.claim("server", id))
    }

    for (const id of ids) {
      for (let tries = 0; ; tries += 1) {
        if (tries > 10_000) throw new Error("Timed out waiting")
        const job = await Effect.runPromise(
          harness.state.getProvisioningJob(id)
        )
        if (!job) break
        expect(job.error).toBeNull()
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
    const created = (await harness.docker.inspectInstances()).map(
      (instance) => instance.id
    )
    expect(created).toEqual(expect.arrayContaining(ids))
  })
})
