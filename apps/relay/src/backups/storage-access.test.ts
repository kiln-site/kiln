import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

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
const grantTo = (url: string) => ({
  allowPrivateNetwork: false,
  headers: { "content-type": "application/zip" },
  method: "PUT" as const,
  status: "granted" as const,
  url,
})
const refusal = { reason: "Hearth knows no such task", status: "refused" }

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
    "waits for its own Hearth when only another is connected, whatever that one says",
    () =>
      Effect.gen(function* () {
        for (const says of [refusal, grantTo("https://collector.example.com/x")]) {
          const failure = yield* Effect.flip(
            connected([other("full_access", says)])(request, owner.id)
          )
          assert.isTrue(isHearthUnreachable(failure))
        }
      })
  )

  it.effect("fails for good when its own Hearth refuses", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        connected([{ ...owner, says: refusal }])(request, owner.id)
      )
      assert.isFalse(isHearthUnreachable(failure))
      assert.include(failure.reason, refusal.reason)
    })
  )

  // A task stored before a task kept its Hearth.
  it.effect(
    "lets a Hearth with full access answer for a task that names none, and no other",
    () =>
      Effect.gen(function* () {
        const access = connected([
          other("read_only", grantTo("https://collector.example.com/x")),
          { ...owner, role: "custom" },
        ])
        assert.isTrue(
          isHearthUnreachable(yield* Effect.flip(access(request, null)))
        )
        assert.deepStrictEqual(
          yield* connected([owner])(request, null),
          owner.says
        )
      })
  )

  // What a held backup waits out: no Hearth connected, one that can't say
  // yet, or one that couldn't answer or answered with something that isn't
  // an answer.
  it.effect.each([
    { answers: [], case: "its Hearth isn't connected" },
    {
      answers: [
        { ...owner, says: { reason: "a schedule is owed", status: "later" } },
      ],
      case: "its Hearth says to ask later",
    },
    {
      answers: [{ ...owner, says: { status: "granted" } }],
      case: "its Hearth answers nonsense",
    },
  ])("holds the backup to ask again when $case", ({ answers }) =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(connected(answers)(request, owner.id))
      assert.isTrue(isHearthUnreachable(failure))
    })
  )

  it.effect("says Hearth couldn't be reached when asking fails", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        backupStorageAccessThrough(() =>
          Promise.reject(new Error("control socket closed"))
        )(request, owner.id)
      )
      assert.isTrue(isHearthUnreachable(failure))
    })
  )
})
