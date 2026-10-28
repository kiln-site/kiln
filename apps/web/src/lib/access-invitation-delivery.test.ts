import { assert, layer } from "@effect/vitest"
import { Effect, Layer, Schedule } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, beforeAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import { loadOperation } from "@/operations/lanes"
import { testOperationsEngine } from "@/operations/test/engine"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertRelay,
  insertRows,
  insertUser,
  selectRows,
} from "@/test/seed"

import {
  deliverInvitation,
  startInvitationDelivery,
} from "./access-invitation-delivery"

// Resend is the only fake: what was sent, and whether it answers.
const resend = vi.hoisted(() => ({
  fails: false,
  sent: [] as Array<{ to: Array<string>; key: string }>,
}))
vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (
        message: { to: Array<string> },
        options: { idempotencyKey: string }
      ) => {
        resend.sent.push({ key: options.idempotencyKey, to: message.to })
        return resend.fails
          ? { error: { message: "Resend is down" } }
          : { error: null }
      },
    }
  },
}))

beforeAll(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test")
  vi.stubEnv("RESEND_FROM_EMAIL", "Kiln <kiln@example.test>")
  vi.stubEnv("KILN_URL", "https://kiln.example.test")
})
afterAll(() => {
  vi.unstubAllEnvs()
  return disposeAppRuntime()
})

const Delivery = testOperationsEngine(deliverInvitation.layer).pipe(
  Layer.provideMerge(TestDatabase)
)

const invite = (id: string, row: Record<string, unknown> = {}) =>
  insertRows("invitation", {
    access_id: "grant-one",
    access_type: "scoped",
    created_at: Date.now(),
    delivery_status: "pending",
    email: `${id}@example.test`,
    expires_at: Date.now() + 86_400_000,
    id,
    invited_by: "inviter",
    relay_id: "relay-one",
    token_hash: id.replaceAll("-", "").padEnd(64, "0"),
    ...row,
  })

const delivery = (id: string) =>
  selectRows<{ delivery_status: string; id: string }>("invitation").pipe(
    Effect.map((rows) => rows.find((row) => row.id === id)?.delivery_status)
  )

const operationOf = (invitationId: string) =>
  selectRows<{ id: string; idempotency_key: string }>("operation").pipe(
    Effect.map(
      (rows) => rows.find((row) => row.idempotency_key === invitationId)?.id
    ),
    Effect.flatMap((id) => (id ? loadOperation(id) : Effect.succeed(null)))
  )

const until = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  done: (a: A) => boolean
) =>
  effect.pipe(
    Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: done }),
    Effect.timeout("20 seconds")
  )

const seed = Effect.gen(function* () {
  yield* resetDatabase
  resend.fails = false
  resend.sent.length = 0
  yield* insertUser("inviter")
  yield* insertUser("invitee")
  yield* insertRelay("relay-one")
  yield* insertGrant({
    id: "grant-one",
    relayId: "relay-one",
    resourceId: "relay-one",
    resourceType: "relay",
    state: "pending",
    userId: "invitee",
  })
})

const a = "00000000-0000-4000-8000-00000000000a"
const b = "00000000-0000-4000-8000-00000000000b"

describeMysql("Invitation delivery", () => {
  layer(Delivery, { timeout: 60_000 })((it) => {
    it.effect(
      "emails an invitation once, and not one revoked before its turn",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* invite(a)
          yield* invite(b, { revoked_at: Date.now() })

          yield* startInvitationDelivery([a, b], "inviter")
          yield* until(Effect.all([operationOf(a), operationOf(b)]), (ops) =>
            ops.every((op) => op?.state === "succeeded")
          )
          // Started again, as by a restart's carry-over, it's the same.
          yield* startInvitationDelivery([a], null)

          assert.deepStrictEqual(resend.sent, [
            { key: `access-invitation/${a}`, to: [`${a}@example.test`] },
          ])
          assert.strictEqual(yield* delivery(a), "sent")
          assert.strictEqual(yield* delivery(b), "pending")
        }).pipe(TestClock.withLive)
    )

    it.effect(
      "holds the invitation while it waits to try a failed email again",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* invite(a)
          resend.fails = true

          yield* startInvitationDelivery([a], "inviter")
          yield* until(delivery(a), (status) => status === "failed")
          // Its retry is minutes away: the workflow pauses, and the
          // operation keeps running with its lock until it ends.
          yield* Effect.sleep("500 millis")

          assert.strictEqual((yield* operationOf(a))?.state, "running")
          assert.deepStrictEqual(
            (yield* selectRows<{ held: number; lock_key: string }>(
              "operation_lock"
            )).map((lock) => [lock.lock_key, Boolean(lock.held)]),
            [[`invitation:${a}`, true]]
          )
          assert.strictEqual(resend.sent.length, 1)
        }).pipe(TestClock.withLive)
    )
  })
})
