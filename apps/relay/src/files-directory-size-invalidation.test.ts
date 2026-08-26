import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect } from "effect"
import { vi } from "vite-plus/test"

const directorySizeEffect = vi.hoisted(() => vi.fn())

vi.mock("./disk-usage.js", () => ({
  directoryApparentSizeEffect: directorySizeEffect,
}))

import { loadConfig } from "./config.js"
import { FilesystemDriver } from "./files.js"
import type { RelayInstanceConfig } from "./config.js"

describe("Relay directory size invalidation", () => {
  it.effect("restarts an in-flight scan after a file write", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const firstResult = yield* Deferred.make<number>()
        const secondStarted = yield* Deferred.make<void>()
        const secondResult = yield* Deferred.make<number>()
        directorySizeEffect
          .mockReturnValueOnce(
            Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(firstResult))
            )
          )
          .mockReturnValueOnce(
            Deferred.succeed(secondStarted, undefined).pipe(
              Effect.andThen(Deferred.await(secondResult))
            )
          )

        yield* fromPromise(() =>
          writeFile(resolve(root, "world", "level.dat"), "level")
        )
        const queued = yield* driver.directorySizes(instance, {
          instanceId: instance.id,
          paths: ["world/"],
        })
        assert.deepEqual(queued.pending, ["world/"])
        yield* Deferred.await(firstStarted)

        yield* driver.write(instance, "world/level.dat", {
          content: "levels",
        })
        yield* Deferred.succeed(firstResult, 5)

        // The invalidation itself must arrange the replacement. Waiting for a
        // later browser poll here would reproduce the stale-scan delay.
        yield* Deferred.await(secondStarted).pipe(Effect.timeout("1 second"))
        yield* Deferred.succeed(secondResult, 6)
        yield* Effect.yieldNow

        const completed = yield* driver.directorySizes(instance, {
          instanceId: instance.id,
          paths: ["world/"],
        })
        assert.deepEqual(completed.pending, [])
        assert.strictEqual(completed.sizes["world/"], 6)
        assert.strictEqual(directorySizeEffect.mock.calls.length, 2)
      })
    )
  )

  it.effect("drops a queued stale scan when invalidated", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        const activeResult = yield* Deferred.make<number>()
        const queuedStarted = yield* Deferred.make<string>()
        const queuedResult = yield* Deferred.make<number>()
        let invocation = 0
        directorySizeEffect.mockImplementation((absolute: string) => {
          invocation += 1
          if (invocation <= 4) return Deferred.await(activeResult)
          if (invocation === 5) {
            return Deferred.succeed(queuedStarted, absolute).pipe(
              Effect.andThen(Deferred.await(queuedResult))
            )
          }
          return Effect.succeed(2)
        })

        const paths = ["one/", "two/", "three/", "four/", "queued/"]
        yield* fromPromise(() =>
          Promise.all(
            paths.map((path) => mkdir(resolve(root, path), { recursive: true }))
          )
        )
        yield* fromPromise(() =>
          writeFile(resolve(root, "world", "level.dat"), "level")
        )
        const initial = yield* driver.directorySizes(instance, {
          instanceId: instance.id,
          paths,
        })
        assert.deepEqual(initial.pending, paths)
        assert.strictEqual(directorySizeEffect.mock.calls.length, 4)

        yield* driver.write(instance, "world/level.dat", {
          content: "levels",
        })
        const replacement = yield* driver.directorySizes(instance, {
          instanceId: instance.id,
          paths: ["queued/"],
        })
        assert.deepEqual(replacement.pending, ["queued/"])

        yield* Deferred.succeed(activeResult, 1)
        const startedPath = yield* Deferred.await(queuedStarted).pipe(
          Effect.timeout("1 second")
        )
        const queuedPath = yield* fromPromise(() =>
          realpath(resolve(root, "queued"))
        )
        assert.strictEqual(startedPath, queuedPath)
        yield* Deferred.succeed(queuedResult, 9)
        yield* Effect.yieldNow

        const completed = yield* driver.directorySizes(instance, {
          instanceId: instance.id,
          paths: ["queued/"],
        })
        assert.deepEqual(completed.pending, [])
        assert.strictEqual(completed.sizes["queued/"], 9)
      })
    )
  )
})

function withSetup<TResult>(
  use: (setup: {
    driver: FilesystemDriver
    instance: RelayInstanceConfig
    root: string
  }) => Effect.Effect<TResult, unknown>
) {
  return Effect.acquireUseRelease(
    fromPromise(() => mkdtemp(resolve(tmpdir(), "kiln-size-invalidation-"))),
    (directory) =>
      Effect.gen(function* () {
        directorySizeEffect.mockReset()
        const root = resolve(directory, "instances", "instance-1")
        yield* fromPromise(() =>
          mkdir(resolve(root, "world"), { recursive: true })
        )
        const config = loadConfig({
          KILN_RELAY_DATA_DIR: directory,
          KILN_RELAY_HOST: "relay.test",
          NODE_ENV: "development",
        })
        return yield* use({
          driver: new FilesystemDriver(config),
          instance: testInstance(),
          root,
        })
      }),
    (directory) =>
      fromPromise(() => rm(directory, { force: true, recursive: true })).pipe(
        Effect.orDie
      )
  )
}

function fromPromise<TResult>(run: () => Promise<TResult>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => cause,
  })
}

function testInstance(): RelayInstanceConfig {
  return {
    connectAddress: "localhost",
    directory: "instance-1",
    game: "Minecraft",
    id: "instance-1",
    implementation: "Paper",
    javaVersion: "21",
    limits: { diskBytes: 0, memoryBytes: 0 },
    managedByRelay: true,
    name: "Test Instance",
    ports: [],
    service: "test",
    shortId: "instance",
    tailscale: { enabled: false },
    version: "1.21.11",
  }
}
