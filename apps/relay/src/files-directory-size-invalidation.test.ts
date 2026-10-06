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

import { FilesystemDriver } from "./files.js"
import type { RelayInstanceConfig } from "./config.js"
import { testInstance, testRelayConfig } from "./test/fixtures.js"

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
        yield* Deferred.await(secondStarted)
        yield* Deferred.succeed(secondResult, 6)
        yield* Effect.yieldNow

        const completed = yield* driver.directorySizes(instance, {
          instanceId: instance.id,
          paths: ["world/"],
        })
        assert.deepEqual(completed.pending, [])
        assert.strictEqual(completed.sizes["world/"], 6)
      })
    )
  )

  it.effect("never reports a size from a scan queued before a write", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        const staleResult = yield* Deferred.make<number>()
        const freshStarted = yield* Deferred.make<void>()
        const freshResult = yield* Deferred.make<number>()
        let written = false
        const queuedPath = yield* fromPromise(async () => {
          await mkdir(resolve(root, "queued"), { recursive: true })
          return realpath(resolve(root, "queued"))
        })
        // Hold every scan started before the write so later paths stay
        // queued behind them, however many scans run at once.
        directorySizeEffect.mockImplementation((absolute: string) =>
          written && absolute === queuedPath
            ? Deferred.succeed(freshStarted, undefined).pipe(
                Effect.andThen(Deferred.await(freshResult))
              )
            : Deferred.await(staleResult)
        )

        const paths = Array.from({ length: 16 }, (_, index) => `dir-${index}/`)
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
          paths: [...paths, "queued/"],
        })
        assert.deepEqual(initial.pending, [...paths, "queued/"])

        yield* driver.write(instance, "world/level.dat", {
          content: "levels",
        })
        written = true
        const replacement = yield* driver.directorySizes(instance, {
          instanceId: instance.id,
          paths: ["queued/"],
        })
        assert.deepEqual(replacement.pending, ["queued/"])

        yield* Deferred.succeed(staleResult, 1)
        yield* Deferred.await(freshStarted)
        const beforeFresh = yield* driver.directorySizes(instance, {
          instanceId: instance.id,
          paths: ["queued/"],
        })
        assert.deepEqual(beforeFresh.sizes, {})
        yield* Deferred.succeed(freshResult, 9)
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
        return yield* use({
          driver: new FilesystemDriver(testRelayConfig(directory)),
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
