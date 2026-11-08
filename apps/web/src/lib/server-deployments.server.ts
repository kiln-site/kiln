import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import {
  finishServerDeploymentEffect,
  insertServerDeploymentEffect,
  loadRunningServerDeploymentsEffect,
  loadRunningServerInstallEffect,
  type ServerDeploymentTrigger,
} from "@/effect/app-deployments"
import { Database } from "@/effect/database"
import { promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"
import { publishRealtimeChange } from "@/lib/realtime-source.server"

// A game server's deployments: its first install, as a create or a copy
// provisions it, and each reinstall or change of Brick. Starting, stopping,
// recovering, and saving settings without applying them aren't deployments.
// Each is recorded as running before the Relay is asked, under an ID Hearth
// makes that also names its log on the Relay, and ends when the Relay says.

// A reinstall or change of Brick is one request, answered within six
// minutes; one still running long after was cut off, as by a restart.
const startupDeploymentStale = 15 * 60_000
// An install is followed while its post-provisioning job lasts; past this
// with none, or past a day with one, nothing will end it.
const installUnfollowedStale = 10 * 60_000
const installStale = 24 * 60 * 60_000

const lostTrack =
  "Kiln lost track of this deployment; the server's console shows what happened"

export function publishServerDeploymentChange(relayId: string): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: { relayId },
    topics: ["app-deployments"],
    type: "hearth.invalidate",
  })
}

interface ServerDeploymentStart {
  brickId: string | null
  brickName: string | null
  instanceId: string
  relayId: string
  /** Who asked. */
  userId: string
}

/**
 * Records a game server's first install as running, before its
 * provisioning is claimed, and returns its ID. A create retried while it
 * runs resumes the same one.
 */
export async function beginServerInstall(
  input: ServerDeploymentStart
): Promise<string> {
  const running = await runAppEffect(
    "servers.deployment.runningInstall",
    loadRunningServerInstallEffect(input.instanceId)
  )
  if (running) return running.id
  return insertRunning(input, "install")
}

/** Ends a game server's install as its provisioning ended, if it was running. */
export async function finishServerInstall(
  relayId: string,
  instanceId: string,
  outcome: { error: string | null; status: "failed" | "succeeded" }
): Promise<void> {
  const running = await runAppEffect(
    "servers.deployment.runningInstall",
    loadRunningServerInstallEffect(instanceId)
  )
  if (!running) return
  await finish(relayId, running.id, outcome)
}

/**
 * Runs a reinstall or change of Brick as a deployment: recorded as running
 * before `run` asks the Relay, and ended as it answers.
 */
export async function asServerDeployment<T>(
  input: ServerDeploymentStart & { trigger: "brick" | "reinstall" },
  run: (deploymentId: string) => Promise<T>
): Promise<T> {
  const id = await insertRunning(input, input.trigger)
  return Effect.runPromise(
    promiseEffect(() => run(id)).pipe(
      Effect.tap(() =>
        promiseEffect(() =>
          finish(input.relayId, id, { error: null, status: "succeeded" })
        )
      ),
      Effect.tapError((error) =>
        promiseEffect(() =>
          finish(input.relayId, id, {
            error:
              error instanceof Error ? error.message : "The Relay refused it",
            status: "failed",
          })
        ).pipe(Effect.ignore)
      )
    )
  )
}

/**
 * Ends game server deployments nothing follows any more, as one a Hearth
 * restart cut off, as unknown.
 */
export const settleStaleServerDeploymentsEffect = Effect.fn(
  "servers.deployments.settleStale"
)(function* () {
  const running = yield* loadRunningServerDeploymentsEffect()
  if (running.length === 0) return
  const now = yield* Clock.currentTimeMillis
  const installs = running.filter((record) => record.trigger === "install")
  const database = yield* Database
  const followed = new Set(
    installs.length
      ? (yield* database.queryRows<RowDataPacket & { instance_id: string }>(
          "servers.deployments.followedInstalls",
          `SELECT instance_id FROM ${databaseTable("server_post_provision")}
            WHERE instance_id IN (${installs.map(() => "?").join(", ")})`,
          installs.map((record) => record.instanceId)
        )).map((row) => row.instance_id)
      : []
  )
  for (const record of running) {
    const age = now - Date.parse(record.startedAt)
    const stale =
      record.trigger === "install"
        ? age > installStale ||
          (age > installUnfollowedStale && !followed.has(record.instanceId))
        : age > startupDeploymentStale
    if (!stale) continue
    const finished = yield* finishServerDeploymentEffect(record.id, {
      error: lostTrack,
      status: "unknown",
    })
    if (finished) publishServerDeploymentChange(record.relayId)
  }
})

async function insertRunning(
  input: ServerDeploymentStart,
  trigger: ServerDeploymentTrigger
): Promise<string> {
  const id = crypto.randomUUID()
  await runAppEffect(
    "servers.deployment.insert",
    insertServerDeploymentEffect({
      brickId: input.brickId,
      brickName: input.brickName,
      id,
      instanceId: input.instanceId,
      relayId: input.relayId,
      trigger,
      triggeredBy: input.userId,
    })
  )
  publishServerDeploymentChange(input.relayId)
  return id
}

async function finish(
  relayId: string,
  id: string,
  outcome: { error: string | null; status: "failed" | "succeeded" }
): Promise<void> {
  const finished = await runAppEffect(
    "servers.deployment.finish",
    finishServerDeploymentEffect(id, outcome)
  )
  if (finished) publishServerDeploymentChange(relayId)
}
