import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"

import { Database } from "@/effect/database"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows, selectRows } from "@/test/seed"

import {
  advanceAuthorizationRevisionEffect,
  advanceSubjectAcrossEnabledRelaysEffect,
  type AuthorizationDeliveryTarget,
  type AuthorizationScope,
} from "./authorization-revision"

interface DeliveryRow {
  relay_id: string
  scope_kind: string
  scope_id: string
  desired_revision: number
  acknowledged_revision: number
}

const advance = (targets: ReadonlyArray<AuthorizationDeliveryTarget>) =>
  Effect.gen(function* () {
    const database = yield* Database
    return yield* database.transaction("test", (transaction) =>
      advanceAuthorizationRevisionEffect(transaction, {
        targets,
        userId: "user-one",
      })
    )
  })

const subjectRevision = Effect.map(
  selectRows<{ revision: number }>("authorization_subject"),
  (rows) => rows.map((row) => Number(row.revision))
)

const deliveries = Effect.map(
  selectRows<DeliveryRow>("authorization_delivery"),
  (rows) =>
    rows
      .map((row) => ({
        relayId: row.relay_id,
        scope: `${row.scope_kind}:${row.scope_id}`,
        desired: Number(row.desired_revision),
        acknowledged: Number(row.acknowledged_revision),
      }))
      .sort((a, b) =>
        `${a.relayId}${a.scope}`.localeCompare(`${b.relayId}${b.scope}`)
      )
)

const instanceTarget = {
  relayId: "relay-one",
  scope: { instanceId: "instance-one", kind: "instance" },
} satisfies AuthorizationDeliveryTarget

describeMysql("authorization revisions", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "advances the subject and raises coalesced delivery intent without losing acknowledgements",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-one")
          yield* insertRows("authorization_subject", {
            user_id: "user-one",
            revision: 8,
            updated_at: 0,
          })
          yield* insertRows("authorization_delivery", {
            relay_id: "relay-one",
            subject_id: "user-one",
            scope_kind: "instance",
            scope_id: "instance-one",
            desired_revision: 5,
            acknowledged_revision: 3,
            updated_at: 0,
          })

          const change = yield* advance([instanceTarget, instanceTarget])

          expect(change).toEqual({ relayIds: ["relay-one"], revision: 9 })
          expect(yield* subjectRevision).toEqual([9])
          expect(yield* deliveries).toEqual([
            {
              relayId: "relay-one",
              scope: "instance:instance-one",
              desired: 9,
              acknowledged: 3,
            },
          ])
        })
    )

    it.effect("serializes concurrent first advances of one subject", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay("relay-one")

        const changes = yield* Effect.all(
          Array.from({ length: 6 }, () => advance([instanceTarget])),
          { concurrency: "unbounded" }
        )

        expect(
          changes.map((change) => change.revision).sort((a, b) => a - b)
        ).toEqual([1, 2, 3, 4, 5, 6])
        expect(yield* subjectRevision).toEqual([6])
        expect((yield* deliveries).map((row) => row.desired)).toEqual([6])
      })
    )

    it.effect("targets only enabled Relays", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay("enabled-relay")
        yield* insertRelay("paused-relay", { enabled: false })
        const scopes: Array<AuthorizationScope> = [
          { kind: "subject_relay" },
          { kind: "login_session", loginSessionId: "session-one" },
        ]

        const database = yield* Database
        const change = yield* database.transaction("test", (transaction) =>
          advanceSubjectAcrossEnabledRelaysEffect(
            transaction,
            "user-one",
            scopes
          )
        )

        expect(change).toEqual({ relayIds: ["enabled-relay"], revision: 1 })
        expect(yield* deliveries).toEqual([
          {
            relayId: "enabled-relay",
            scope: "login_session:session-one",
            desired: 1,
            acknowledged: 0,
          },
          {
            relayId: "enabled-relay",
            scope: "subject_relay:",
            desired: 1,
            acknowledged: 0,
          },
        ])
      })
    )
  })
})
