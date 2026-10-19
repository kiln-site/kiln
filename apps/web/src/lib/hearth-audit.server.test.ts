import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Clock, Effect } from "effect"

import type { RelayOperationLookup } from "@workspace/contracts"

import {
  listAuditEvents,
  reconcilePendingRelayChanges,
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
          errorMessage: "Server is not stopped",
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
          errorMessage: "Server is not stopped",
          operationId,
          outcome: "failed",
          relayId,
          target: { id: instanceId, kind: "instance" },
        })
      })
    )

    it.effect("settles changes a restart left pending by asking the Relay", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const answers = new Map<string, RelayOperationLookup>()
        const start = (answer: RelayOperationLookup) =>
          Effect.gen(function* () {
            const operationId = randomUUID()
            answers.set(operationId, answer)
            yield* recordRelayChangeStarted({
              operation: "instance.action",
              operationId,
              payload: { action: "stop", instanceId },
              relayId,
              subject: "user-1",
            })
            return operationId
          })
        const succeeded = yield* start({ result: {}, status: "succeeded" })
        const neverArrived = yield* start({ status: "unknown" })
        const interrupted = yield* start({ status: "interrupted" })
        const running = yield* start({ status: "running" })

        yield* reconcilePendingRelayChanges(
          relayId,
          (yield* Clock.currentTimeMillis) + 1,
          async (operationId) => answers.get(operationId)!
        )

        const outcomes = new Map(
          (yield* listAuditEvents({ limit: 10 })).map((event) => [
            event.operationId,
            event.outcome,
          ])
        )
        assert.strictEqual(outcomes.get(succeeded), "succeeded")
        assert.strictEqual(outcomes.get(neverArrived), "not_run")
        assert.strictEqual(outcomes.get(interrupted), "unknown")
        assert.strictEqual(outcomes.get(running), "pending")
      })
    )

    it.effect("leaves changes this process may still be awaiting", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const operationId = randomUUID()
        yield* recordRelayChangeStarted({
          operation: "instance.action",
          operationId,
          payload: { action: "stop", instanceId },
          relayId,
          subject: "user-1",
        })
        const now = yield* Clock.currentTimeMillis
        yield* reconcilePendingRelayChanges(
          relayId,
          now - 60_000,
          async () => ({ status: "unknown" })
        )
        const [event] = yield* listAuditEvents({ limit: 10 })
        assert.strictEqual(event?.outcome, "pending")
      })
    )
  })
})
