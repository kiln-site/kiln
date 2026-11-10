import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import {
  listAuditEvents,
  recordRelayChangeFinished,
  recordRelayChangeStarted,
} from "@/lib/hearth-audit.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"

const relayId = "1".repeat(12)
const instanceId = "a".repeat(12)

describeMysql("Hearth audit", () => {
  layer(TestDatabase)((it) => {
    it.effect("records who changed what, and how it went", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const operationId = randomUUID()
        yield* recordRelayChangeStarted({
          operation: "instance.action",
          operationId,
          payload: {
            action: "restart",
            id: instanceId,
            kind: "instance",
            // Secrets in a payload never reach the audit.
            password: "hunter2",
          },
          relayId,
          subject: "cli/credential-1/user-1",
        })
        const [pending] = yield* listAuditEvents({ limit: 10 })
        assert.strictEqual(pending?.outcome, "pending")

        yield* recordRelayChangeFinished({
          errorCode: "operation_failed",
          operationId,
          outcome: "failed",
        })
        // A settled change keeps its outcome.
        yield* recordRelayChangeFinished({ operationId, outcome: "succeeded" })

        const events = yield* listAuditEvents({
          limit: 10,
          target: { id: instanceId, kind: "instance" },
        })
        assert.strictEqual(events.length, 1)
        assert.deepInclude(events[0], {
          action: "instance.action",
          actor: {
            credentialId: "credential-1",
            kind: "cli",
            userId: "user-1",
          },
          details: { action: "restart", kind: "instance" },
          errorCode: "operation_failed",
          operationId,
          outcome: "failed",
          relayId,
          target: { id: instanceId, kind: "instance" },
        })
      })
    )

    it.effect(
      "files a power change under the instance it was for, whatever its kind",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const databaseId = "d".repeat(12)
          yield* recordRelayChangeStarted({
            operation: "instance.action",
            operationId: randomUUID(),
            payload: { action: "stop", id: databaseId, kind: "database" },
            relayId,
            subject: "user-1",
          })

          const found = (kind: string) =>
            listAuditEvents({ limit: 10, target: { id: databaseId, kind } })
          assert.lengthOf(yield* found("database"), 1)
          assert.lengthOf(yield* found("instance"), 0)
        })
    )
  })
})
