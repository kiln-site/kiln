import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"

import {
  backupStorageAccessThrough,
  isHearthUnreachable,
} from "./storage-access.js"

const request = {
  action: "upload" as const,
  artifactId: "30000000-0000-4000-8000-000000000001",
  backupId: "00000000-0000-4000-8000-000000000001",
  taskId: "10000000-0000-4000-8000-000000000001",
}
const grant = {
  allowPrivateNetwork: false,
  headers: { "content-type": "application/zip" },
  method: "PUT" as const,
  status: "granted" as const,
  url: "https://s3.example.com/kiln-backups/one.zip?X-Amz-Signature=abc",
}
const refusal = { reason: "Hearth knows no such task", status: "refused" }

// A Relay can be paired with more than one Hearth, and a task doesn't say
// which sent it.
describe("Relay backup storage access", () => {
  it.effect("takes the grant of the Hearth that knows the task over another's refusal", () =>
    Effect.gen(function* () {
      const access = backupStorageAccessThrough(async () => [
        { payload: refusal },
        { payload: grant },
      ])
      assert.deepStrictEqual(yield* access(request), grant)
    })
  )

  it.effect("fails for good when every Hearth that answered refused", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.exit(
        backupStorageAccessThrough(async () => [{ payload: refusal }])(request)
      )
      assert.isTrue(Exit.isFailure(refused))
      assert.isFalse(
        Exit.isFailure(refused) && isHearthUnreachable(refused.cause)
      )
      assert.include(String(Exit.isFailure(refused) && refused.cause), refusal.reason)
    })
  )

  // What a held backup waits out: no Hearth connected, or one that couldn't
  // answer, or answered with something that isn't an answer.
  it.effect.each([
    { answers: [], case: "no Hearth is connected" },
    { answers: [{ payload: { status: "granted" } }], case: "a Hearth answers nonsense" },
  ])("says Hearth couldn't be reached when $case", ({ answers }) =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        backupStorageAccessThrough(async () => answers)(request)
      )
      assert.isTrue(isHearthUnreachable(failure))
    })
  )

  it.effect("says Hearth couldn't be reached when asking fails", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        backupStorageAccessThrough(() =>
          Promise.reject(new Error("control socket closed"))
        )(request)
      )
      assert.isTrue(isHearthUnreachable(failure))
    })
  )
})
