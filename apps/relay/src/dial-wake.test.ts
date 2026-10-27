import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit } from "effect"

import { dialWakePath, listenForDialWake, sendDialWake } from "./dial-wake.js"

describe("waking the Relay's dialer", () => {
  it.effect("wakes the Relay that listens, which only its own user can", () =>
    Effect.gen(function* () {
      const path = join(yield* scratchDirectory, "relay.sock")
      const woken = yield* Deferred.make<void>()
      yield* listenForDialWake(path, () => {
        Deferred.doneUnsafe(woken, Exit.void)
      })

      assert.strictEqual(statSync(path).mode & 0o777, 0o600)
      assert.isTrue(yield* sendDialWake(path))
      yield* Deferred.await(woken)
    }).pipe(Effect.scoped)
  )

  it.effect("stops listening, and lets go of its socket, with its scope", () =>
    Effect.gen(function* () {
      const path = join(yield* scratchDirectory, "relay.sock")
      yield* listenForDialWake(path, () => undefined).pipe(Effect.scoped)

      assert.isFalse(existsSync(path))
      assert.isFalse(yield* sendDialWake(path))
    }).pipe(Effect.scoped)
  )

  it("names one socket per data directory", () => {
    assert.strictEqual(dialWakePath("/data"), dialWakePath("/data"))
    assert.notStrictEqual(dialWakePath("/data"), dialWakePath("/data-2"))
  })
})

const scratchDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "kiln-wake-"))),
  (directory) =>
    Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
)
