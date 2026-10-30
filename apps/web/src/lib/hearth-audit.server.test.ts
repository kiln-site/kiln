import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import {
  listAuditEvents,
  recordRelayChangeFinished,
  recordRelayChangeStarted,
} from "@/lib/hearth-audit.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"

const relayId = "r".repeat(43)
const instanceId = "a".repeat(40)

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
            instanceId,
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
          details: { action: "restart" },
          errorCode: "operation_failed",
          operationId,
          outcome: "failed",
          relayId,
          target: { id: instanceId, kind: "instance" },
        })
      })
    )
  })
})
