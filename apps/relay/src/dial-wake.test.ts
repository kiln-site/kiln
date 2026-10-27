import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { dialWakePath, listenForDialWake, sendDialWake } from "./dial-wake.js"

describe("waking the Relay's dialer", () => {
  it.live("wakes the Relay that listens, and says when none does", () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), "kiln-wake-"))
      const path = join(directory, "relay.sock")
      let wakes = 0
      const listener = listenForDialWake(path, () => {
        wakes += 1
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          listener.close()
          rmSync(directory, { force: true, recursive: true })
        })
      )
      yield* Effect.promise(async () => {
        for (let turn = 0; turn < 100; turn += 1) {
          try {
            if ((statSync(path).mode & 0o777) === 0o600) return
            await new Promise((resolve) => setTimeout(resolve, 10))
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
        }
      })
      // Only its own user can open it.
      assert.strictEqual(statSync(path).mode & 0o777, 0o600)

      assert.isTrue(yield* sendDialWake(path))
      yield* Effect.promise(async () => {
        for (let turn = 0; wakes === 0 && turn < 100; turn += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      })
      assert.strictEqual(wakes, 1)

      listener.close()
      assert.isFalse(yield* sendDialWake(path))
    }).pipe(Effect.scoped)
  )

  it("names one socket per data directory", () => {
    assert.strictEqual(dialWakePath("/data"), dialWakePath("/data"))
    assert.notStrictEqual(dialWakePath("/data"), dialWakePath("/data-2"))
  })
})
