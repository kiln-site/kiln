import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { backupStorageAccessThrough } from "./storage-access.js"

const request = {
  action: "upload" as const,
  artifactId: "30000000-0000-4000-8000-000000000001",
}
const grantTo = (url: string) => ({
  allowPrivateNetwork: false,
  headers: { "content-type": "application/zip" },
  method: "PUT" as const,
  status: "granted" as const,
  url,
})
const refusal = { reason: "Hearth knows no such copy", status: "refused" }

// The Hearths connected to a Relay, and what each would answer if asked.
const connected = (
  sessions: ReadonlyArray<{ id: string; role: string; says: unknown }>
) =>
  backupStorageAccessThrough(async (_payload, _timeoutMs, only) =>
    sessions.filter(only).map(({ says }) => ({ payload: says }))
  )

// A Relay can be paired with more than one Hearth, and any of them answers
// when asked. Only the one a task came from may say where its backup goes.
describe("Relay backup storage access", () => {
  const owner = {
    id: "hearth-owner",
    role: "full_access",
    says: grantTo("https://bucket.example.com/owner?X-Amz-Signature=a"),
  }
  const other = (role: string, says: unknown) => ({
    id: "hearth-other",
    role,
    says,
  })

  it.effect.each([
    { peer: "one that may only read", role: "read_only" },
    { peer: "one with full access", role: "full_access" },
  ])(
    "takes the task's own Hearth's answer, never that of $peer",
    ({ role }) =>
      Effect.gen(function* () {
        const elsewhere = grantTo(
          "https://collector.example.com/stolen?X-Amz-Signature=b"
        )
        const access = connected([other(role, elsewhere), owner])

        assert.deepStrictEqual(yield* access(request, owner.id), owner.says)
      })
  )

  it.effect(
    "takes no answer from another Hearth when its own isn't connected",
    () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          connected([
            other("full_access", grantTo("https://collector.example.com/x")),
          ])(request, owner.id)
        )
        assert.strictEqual(failure.code, "hearth_unreachable")
      })
  )

  it.effect("fails with what its own Hearth refused it for", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        connected([{ ...owner, says: refusal }])(request, owner.id)
      )
      assert.strictEqual(failure.code, "storage_access_refused")
      assert.include(failure.reason, refusal.reason)
    })
  )

  // A task stored before a task kept its Hearth.
  it.effect(
    "lets a Hearth with full access answer for a task that names none, and no other",
    () =>
      Effect.gen(function* () {
        const limited = connected([
          other("read_only", grantTo("https://collector.example.com/x")),
          { ...owner, role: "custom" },
        ])
        assert.strictEqual(
          (yield* Effect.flip(limited(request, null))).code,
          "hearth_unreachable"
        )
        assert.deepStrictEqual(
          yield* connected([owner])(request, null),
          owner.says
        )
      })
  )
})
