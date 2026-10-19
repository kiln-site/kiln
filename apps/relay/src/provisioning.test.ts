import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assert, it as effectIt } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { describe, expect, it } from "vite-plus/test"

import {
  relayCreateInstanceSchema,
  relayInstanceSchema,
} from "@workspace/contracts"

import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"
import type { LifecycleDriver } from "./lifecycle.js"
import { exclusive, laneKeys, OperationLanes } from "./operation-lanes.js"
import { provisioningErrorMessage } from "./provisioning-errors.js"
import { ProvisioningManager } from "./provisioning.js"

const pullFailure = new Error(
  "Command failed: docker pull private.example/image --env TOKEN=secret\nError response from daemon: manifest unknown\n"
)

describe("provisioning errors", () => {
  it("shows Docker's final detail without exposing the command line", () => {
    const message = provisioningErrorMessage(pullFailure)

    expect(message).toBe("Error response from daemon: manifest unknown")
    expect(message).not.toContain("secret")
  })

  it("looks through Effect's promise wrapper to the Docker failure", () => {
    const wrapped = new Error("An error occurred in Effect.tryPromise", {
      cause: pullFailure,
    })

    expect(provisioningErrorMessage(wrapped)).toBe(
      provisioningErrorMessage(pullFailure)
    )
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

  it("still explains a failure that carries no message", () => {
    expect(provisioningErrorMessage(null)).not.toBe("")
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

  effectIt.effect(
    "puts back a job a pause withdrew, and creates it once resumed",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "kiln-provisioning-"))),
        (directory) =>
          Effect.gen(function* () {
            const state = yield* RelayStateStore
            const lanes = new OperationLanes()
            const created: Array<string> = []
            // Docker is the one thing faked: creating just notes the server.
            const lifecycle = {
              createInstanceWithId: async (id: string) => {
                created.push(id)
                return placeholder
              },
            } as unknown as LifecycleDriver
            const manager = yield* ProvisioningManager.make({
              lanes,
              lifecycle,
              refreshSnapshot: async () => undefined,
            })
            const worker = yield* Effect.forkChild(manager.run())
            const until = (done: () => boolean) =>
              Effect.gen(function* () {
                for (let tries = 0; !done(); tries += 1) {
                  if (tries > 10_000) throw new Error("Timed out waiting")
                  yield* Effect.promise(
                    () => new Promise((resolve) => setImmediate(resolve))
                  )
                }
              })

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
            yield* manager.prepare({
              idempotencyKey: "55000000-0000-4000-8000-000000000009",
              input,
              instanceId,
              placeholder,
            })
            yield* manager.claim(instanceId)
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
            assert.isUndefined(worker.pollUnsafe())
            yield* Fiber.interrupt(worker)
          }).pipe(
            Effect.provide(
              makeRelayStateLayer(join(directory, "relay.sqlite"))
            )
          ),
        (directory) =>
          Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
      )
  )
})
