import type { RowDataPacket } from "mysql2/promise"
import { relaySnapshotSchema } from "@workspace/contracts"
import { Effect } from "effect"

import { Database } from "@/effect/database"
import { promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"
import { relayRpc } from "@/lib/relay-connection"
import { listPersistedRelays } from "@/lib/relay-registry"
import { provisionInstanceDomain } from "@/server/domains.server"

interface PostProvisionRow extends RowDataPacket {
  attempts: number
  instance_id: string
  relay_id: string
}

const POLL_INTERVAL_MS = 2_000
let workerStarted = false

export function scheduleInstancePostProvisionProcessing(): void {
  if (workerStarted) return
  workerStarted = true
  Effect.runFork(
    promiseEffect(processInstancePostProvisionJobs).pipe(
      Effect.catch((cause) =>
        Effect.sync(() =>
          console.warn("[Kiln] Deferred server setup pass failed:", cause)
        )
      ),
      Effect.andThen(Effect.sleep(POLL_INTERVAL_MS)),
      Effect.forever
    )
  )
}

async function processInstancePostProvisionJobs(): Promise<void> {
  const rows = await runAppEffect(
    "instances.postProvision.list",
    Effect.gen(function* () {
      const database = yield* Database
      return yield* database.queryRows<PostProvisionRow>(
        "instances.postProvision.list",
        `SELECT relay_id, instance_id, attempts
           FROM ${databaseTable("instance_post_provision")}
          WHERE next_attempt_at <= CURRENT_TIMESTAMP(3)
          ORDER BY next_attempt_at ASC, created_at ASC
          LIMIT 10`
      )
    })
  )
  if (rows.length === 0) return

  const relays = new Map(
    (await listPersistedRelays()).map((relay) => [relay.id, relay])
  )
  const snapshots = new Map<string, ReturnType<typeof loadSnapshot>>()
  await Effect.runPromise(
    Effect.forEach(
      rows,
      (row) => {
        const relay = relays.get(row.relay_id)
        if (!relay?.enabled) {
          return promiseEffect(() =>
            defer(row, new Error("Relay is unavailable"))
          )
        }
        return promiseEffect(async () => {
          let snapshotPromise = snapshots.get(relay.id)
          if (!snapshotPromise) {
            snapshotPromise = loadSnapshot(relay)
            snapshots.set(relay.id, snapshotPromise)
          }
          const snapshot = await snapshotPromise
          const instance = snapshot.instances.find(
            (candidate) => candidate.id === row.instance_id
          )
          if (!instance) {
            await postpone(row, 5)
            return
          }
          if (instance.provisioning) {
            await postpone(
              row,
              instance.provisioning.phase === "failed" ? 60 : 5
            )
            return
          }
          await provisionInstanceDomain(instance, relay.id)
          await complete(row)
        }).pipe(Effect.catch((cause) => promiseEffect(() => defer(row, cause))))
      },
      { concurrency: 1, discard: true }
    )
  )
}

async function complete(row: PostProvisionRow): Promise<void> {
  await runAppEffect(
    "instances.postProvision.complete",
    Effect.gen(function* () {
      const database = yield* Database
      yield* database.execute(
        "instances.postProvision.complete",
        `DELETE FROM ${databaseTable("instance_post_provision")}
          WHERE relay_id = ? AND instance_id = ?`,
        [row.relay_id, row.instance_id]
      )
    })
  )
}

async function loadSnapshot(relay: Parameters<typeof relayRpc>[0]) {
  return relaySnapshotSchema.parse(
    await relayRpc(relay, "relay.snapshot", {}, 5_000)
  )
}

async function postpone(row: PostProvisionRow, delaySeconds: number) {
  await runAppEffect(
    "instances.postProvision.postpone",
    Effect.gen(function* () {
      const database = yield* Database
      yield* database.execute(
        "instances.postProvision.postpone",
        `UPDATE ${databaseTable("instance_post_provision")}
            SET next_attempt_at = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3))
          WHERE relay_id = ? AND instance_id = ?`,
        [delaySeconds, row.relay_id, row.instance_id]
      )
    })
  )
}

async function defer(row: PostProvisionRow, cause: unknown): Promise<void> {
  const attempts = row.attempts + 1
  const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8))
  const message = (
    cause instanceof Error ? cause.message : "Deferred server setup failed"
  ).slice(0, 512)
  await runAppEffect(
    "instances.postProvision.defer",
    Effect.gen(function* () {
      const database = yield* Database
      yield* database.execute(
        "instances.postProvision.defer",
        `UPDATE ${databaseTable("instance_post_provision")}
            SET attempts = ?,
                next_attempt_at = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3)),
                last_error = ?
          WHERE relay_id = ? AND instance_id = ?`,
        [attempts, delaySeconds, message, row.relay_id, row.instance_id]
      )
    })
  )
}
