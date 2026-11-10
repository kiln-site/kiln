import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import {
  finishServerDeploymentEffect,
  insertServerDeploymentEffect,
  loadRunningServerDeploymentsEffect,
  loadRunningServerInstallEffect,
} from "@/effect/app-deployments"
import { Database } from "@/effect/database"
import { promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"
import { publishRealtimeChange } from "@/lib/realtime-source.server"

// A game server's deployments: its first install, as a create or a copy
// provisions it, and each reinstall or change of Brick. A database's are
// its redeploys. Starting, stopping, recovering, and saving settings
// without applying them aren't deployments. Each is recorded as running
// before the Relay is asked, under an ID Hearth makes that also names its
// log on the Relay, and ends when the Relay says.

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
  return insertRunning({ ...input, kind: "server", trigger: "install" })
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
  return following(
    input.relayId,
    await insertRunning({ ...input, kind: "server" }),
    run
  )
}

/** Runs a database's redeploy as a deployment, as a game server's is. */
export async function asDatabaseDeployment<T>(
  input: { databaseId: string; relayId: string; userId: string },
  run: (deploymentId: string) => Promise<T>
): Promise<T> {
  return following(
    input.relayId,
    await insertRunning({
      brickId: null,
      brickName: null,
      instanceId: input.databaseId,
      kind: "database",
      relayId: input.relayId,
      trigger: "redeploy",
      userId: input.userId,
    }),
    run
  )
}

// Asks the Relay for a deployment recorded as running, and ends it as the
// Relay answers.
function following<T>(
  relayId: string,
  id: string,
  run: (deploymentId: string) => Promise<T>
): Promise<T> {
  return Effect.runPromise(
    promiseEffect(() => run(id)).pipe(
      Effect.tap(() =>
        promiseEffect(() =>
          finish(relayId, id, { error: null, status: "succeeded" })
        )
      ),
      Effect.tapError((error) =>
        promiseEffect(() =>
          finish(relayId, id, {
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
 * Ends game server and database deployments nothing follows any more, as
 * one a Hearth restart cut off, as unknown.
 */
export const settleStaleServerDeploymentsEffect = Effect.fn(
  "servers.deployments.settleStale"
)(function* () {
  const running = yield* loadRunningServerDeploymentsEffect()
  if (running.length === 0) return
  const now = yield* Clock.currentTimeMillis
  const installs = running.flatMap((record) =>
    record.kind === "server" && record.trigger === "install" ? [record] : []
  )
  const database = yield* Database
  const followed = new Set(
    installs.length
      ? (yield* database.queryRows<RowDataPacket & { instance_id: string }>(
          "servers.deployments.followedInstalls",
          `SELECT instance_id FROM ${databaseTable("instance_post_provision")}
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
          (age > installUnfollowedStale &&
            !(record.kind === "server" && followed.has(record.instanceId)))
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
  input: ServerDeploymentStart &
    (
      | { kind: "database"; trigger: "redeploy" }
      | { kind: "server"; trigger: "brick" | "install" | "reinstall" }
    )
): Promise<string> {
  const id = crypto.randomUUID()
  const { userId, ...record } = input
  await runAppEffect(
    "servers.deployment.insert",
    insertServerDeploymentEffect({ ...record, id, triggeredBy: userId })
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
