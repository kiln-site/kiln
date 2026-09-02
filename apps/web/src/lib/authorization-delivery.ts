import * as Sentry from "@sentry/tanstackstart-react"
import {
  relayBrowserAuthorizationReviseMaxItems,
  relayBrowserCapabilityV2Feature,
} from "@workspace/contracts"
import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"
import { z } from "zod"

import { Database } from "@/effect/database"
import { ensuringPromise, recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { databasePool } from "@/lib/database"
import { databaseTable } from "@/lib/database-config"
import { loadPersistedRelay } from "@/lib/relay-registry"
import {
  advanceSubjectAcrossEnabledRelaysEffect,
  type AuthorizationScope,
} from "@/lib/authorization-revision"

interface PendingDeliveryRow extends RowDataPacket {
  desired_revision: string
  scope_id: string
  scope_kind: "instance" | "login_session" | "subject_relay"
  subject_id: string
}

interface RelayGenerationRow extends RowDataPacket {
  acknowledged_issuer_generation: string
  client_id: string
  issuer_generation: string
}

declare global {
  var kilnAuthorizationDelivery:
    | Map<
        string,
        {
          retry: ReturnType<typeof setTimeout> | null
          running: boolean
          wake: boolean
        }
      >
    | undefined
}

const workers = (globalThis.kilnAuthorizationDelivery ??= new Map())
const reviseResultSchema = z.object({
  issuerGeneration: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      minimumRevision: z.number().int().nonnegative(),
      scope: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("subject_relay") }),
        z.object({ instanceId: z.string(), kind: z.literal("instance") }),
        z.object({
          kind: z.literal("login_session"),
          loginSessionId: z.string(),
        }),
      ]),
      subject: z.string(),
    })
  ),
})

export function wakeAuthorizationDelivery(relayId: string): void {
  const state = workers.get(relayId) ?? {
    retry: null,
    running: false,
    wake: false,
  }
  workers.set(relayId, state)
  state.wake = true
  if (state.retry) {
    clearTimeout(state.retry)
    state.retry = null
  }
  if (!state.running) void drain(relayId, state)
}

export async function recordAuthorizationChange(input: {
  scopes: ReadonlyArray<AuthorizationScope>
  userId: string
}): Promise<void> {
  const change = await runAppEffect(
    "authorization.revision.record",
    Effect.gen(function* () {
      const database = yield* Database
      return yield* database.transaction(
        "authorization.revision.record",
        (transaction) =>
          advanceSubjectAcrossEnabledRelaysEffect(
            transaction,
            input.userId,
            input.scopes
          )
      )
    })
  )
  for (const relayId of change.relayIds) wakeAuthorizationDelivery(relayId)
}

export async function wakePendingAuthorizationDelivery(): Promise<void> {
  const [rows] = await databasePool.query<
    Array<{ relay_id: string } & RowDataPacket>
  >(
    `SELECT DISTINCT relay_id
       FROM ${databaseTable("authorization_delivery")}
      WHERE desired_revision > acknowledged_revision
      UNION
     SELECT id AS relay_id
       FROM ${databaseTable("relay")}
      WHERE issuer_generation > acknowledged_issuer_generation`
  )
  for (const row of rows) wakeAuthorizationDelivery(row.relay_id)
}

/**
 * Reconciles the generation Relay reports on its authenticated control
 * handshake. A lower generation after it was previously acknowledged means
 * Relay state rolled back while pairing survived; advance once so capabilities
 * minted before the rollback cannot become valid again, then let the durable
 * delivery worker push the new floor. A Relay that is ahead is authoritative
 * for its locally persisted generation and Hearth catches up.
 */
export async function observeRelayIssuerGeneration(
  relayId: string,
  observedGeneration: number
): Promise<void> {
  if (!Number.isSafeInteger(observedGeneration) || observedGeneration < 0) {
    throw new Error("Relay reported an invalid browser issuer generation")
  }
  await Sentry.startSpan(
    {
      name: "Reconcile Relay browser issuer generation",
      op: "db.authorization.generation.reconcile",
    },
    async () => {
      // The acknowledgement predicate makes the rollback increment idempotent
      // across concurrent/repeated control handshakes. Once an increment is
      // pending, later observations only retain the lower acknowledgement.
      await databasePool.execute(
        `UPDATE ${databaseTable("relay")}
            SET issuer_generation = issuer_generation + 1,
                acknowledged_issuer_generation = ?
          WHERE id = ?
            AND ? < issuer_generation
            AND acknowledged_issuer_generation >= issuer_generation
            AND issuer_generation < ?`,
        [
          observedGeneration,
          relayId,
          observedGeneration,
          Number.MAX_SAFE_INTEGER,
        ]
      )
      await databasePool.execute(
        `UPDATE ${databaseTable("relay")}
            SET issuer_generation = GREATEST(issuer_generation, ?),
                acknowledged_issuer_generation = IF(
                  ? >= issuer_generation,
                  ?,
                  LEAST(acknowledged_issuer_generation, ?)
                )
          WHERE id = ?`,
        [
          observedGeneration,
          observedGeneration,
          observedGeneration,
          observedGeneration,
          relayId,
        ]
      )
    }
  )
  wakeAuthorizationDelivery(relayId)
}

export async function reviseRelayIssuerGenerationNow(
  relayId: string,
  minimumIssuerGeneration: number
): Promise<boolean> {
  const [{ relayConnectionFeatures, relayRpc }, relay] = await Promise.all([
    import("@/lib/relay-connection"),
    loadPersistedRelay(relayId),
  ])
  if (
    !relay ||
    !relayConnectionFeatures(relayId).has(relayBrowserCapabilityV2Feature)
  ) {
    return false
  }
  const result = reviseResultSchema.parse(
    await relayRpc(
      relay,
      "browser.authorization.revise",
      { items: [], minimumIssuerGeneration },
      5_000
    )
  )
  if (result.issuerGeneration < minimumIssuerGeneration) return false
  await databasePool.execute(
    `UPDATE ${databaseTable("relay")}
        SET issuer_generation = GREATEST(issuer_generation, ?),
            acknowledged_issuer_generation = GREATEST(
              acknowledged_issuer_generation, ?
            )
      WHERE id = ?`,
    [result.issuerGeneration, result.issuerGeneration, relayId]
  )
  return true
}

async function drain(
  relayId: string,
  state: {
    retry: ReturnType<typeof setTimeout> | null
    running: boolean
    wake: boolean
  }
): Promise<void> {
  state.running = true
  state.wake = false
  await ensuringPromise(
    () =>
      recoverPromise(
        async () => {
          const { relayConnectionFeatures } =
            await import("@/lib/relay-connection")
          if (
            !relayConnectionFeatures(relayId).has(
              relayBrowserCapabilityV2Feature
            )
          ) {
            return
          }
          const more = await Sentry.startSpan(
            {
              name: "Deliver authorization revisions",
              op: "relay.authorization.deliver",
            },
            () => deliverBatch(relayId)
          )
          if (more) state.wake = true
        },
        (cause) => {
          Sentry.captureException(cause, {
            tags: { component: "authorization-delivery" },
          })
          state.retry = setTimeout(
            () => {
              state.retry = null
              wakeAuthorizationDelivery(relayId)
            },
            1_000 + Math.floor(Math.random() * 2_000)
          )
          state.retry.unref?.()
        }
      ),
    () => {
      state.running = false
      if (state.wake && !state.retry) void drain(relayId, state)
    }
  )
}

async function deliverBatch(relayId: string): Promise<boolean> {
  const [pendingResult, generationResult, relay] = await Promise.all([
    databasePool.query<Array<PendingDeliveryRow>>(
      `SELECT subject_id, scope_kind, scope_id,
              CAST(desired_revision AS CHAR) AS desired_revision
         FROM ${databaseTable("authorization_delivery")}
        WHERE relay_id = ?
          AND desired_revision > acknowledged_revision
        ORDER BY updated_at ASC
        LIMIT ?`,
      [relayId, relayBrowserAuthorizationReviseMaxItems]
    ),
    databasePool.query<Array<RelayGenerationRow>>(
      `SELECT client_id,
              CAST(issuer_generation AS CHAR) AS issuer_generation,
              CAST(acknowledged_issuer_generation AS CHAR)
                AS acknowledged_issuer_generation
         FROM ${databaseTable("relay")}
        WHERE id = ?
        LIMIT 1`,
      [relayId]
    ),
    loadPersistedRelay(relayId),
  ])
  const pending = pendingResult[0]
  const generation = generationResult[0][0]
  if (!relay || !generation) return false
  const issuerGeneration = safeRevision(generation.issuer_generation)
  const issuerGenerationPending =
    issuerGeneration > safeRevision(generation.acknowledged_issuer_generation)
  if (pending.length === 0 && !issuerGenerationPending) return false

  const items = pending.map((row) => ({
    minimumRevision: safeRevision(row.desired_revision),
    scope: decodeScope(row),
    subject: row.subject_id,
  }))
  const { relayRpc } = await import("@/lib/relay-connection")
  const result = reviseResultSchema.parse(
    await relayRpc(
      relay,
      "browser.authorization.revise",
      {
        items,
        minimumIssuerGeneration: issuerGeneration,
      },
      10_000
    )
  )
  if (result.issuerGeneration < issuerGeneration) {
    throw new Error("Relay did not persist the requested issuer generation")
  }

  await Sentry.startSpan(
    {
      name: "Acknowledge authorization revisions",
      op: "db.authorization.ack",
      attributes: { "authorization.item_count": result.items.length },
    },
    () =>
      runAppEffect(
        "authorization.delivery.ack",
        Effect.gen(function* () {
          const database = yield* Database
          yield* database.transaction(
            "authorization.delivery.ack",
            (connection) =>
              Effect.gen(function* () {
                for (const item of result.items) {
                  const [kind, scopeId] = encodeScope(item.scope)
                  yield* connection.execute(
                    `UPDATE ${databaseTable("authorization_delivery")}
                        SET acknowledged_revision = GREATEST(
                          acknowledged_revision,
                          LEAST(?, desired_revision)
                        )
                      WHERE relay_id = ? AND subject_id = ?
                        AND scope_kind = ? AND scope_id = ?`,
                    [item.minimumRevision, relayId, item.subject, kind, scopeId]
                  )
                }
                yield* connection.execute(
                  `UPDATE ${databaseTable("relay")}
                      SET issuer_generation = GREATEST(issuer_generation, ?),
                          acknowledged_issuer_generation = GREATEST(
                            acknowledged_issuer_generation, ?
                          )
                    WHERE id = ?`,
                  [result.issuerGeneration, result.issuerGeneration, relayId]
                )
              })
          )
        })
      )
  )
  return pending.length === relayBrowserAuthorizationReviseMaxItems
}

function safeRevision(value: string): number {
  const revision = Number(value)
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Authorization revision is outside the safe integer range")
  }
  return revision
}

function decodeScope(row: PendingDeliveryRow) {
  switch (row.scope_kind) {
    case "instance":
      return { instanceId: row.scope_id, kind: row.scope_kind } as const
    case "login_session":
      return { kind: row.scope_kind, loginSessionId: row.scope_id } as const
    case "subject_relay":
      return { kind: row.scope_kind } as const
  }
}

function encodeScope(
  scope:
    | { kind: "subject_relay" }
    | { instanceId: string; kind: "instance" }
    | { kind: "login_session"; loginSessionId: string }
): [string, string] {
  switch (scope.kind) {
    case "instance":
      return [scope.kind, scope.instanceId]
    case "login_session":
      return [scope.kind, scope.loginSessionId]
    case "subject_relay":
      return [scope.kind, ""]
  }
}
