import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import type { AppGitHubBuild, AppSourceType } from "@workspace/contracts"

import { invalidateScheduleDeploymentsEffect } from "@/effect/schedule-invalidation"
import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

// Where apps deploy from on GitHub, and Hearth's record of every
// deployment across its Relays: each App deployment, and each game server's
// install, reinstall, and change of Brick. The Relay keeps their logs.

export type AppDeploymentTrigger =
  | "manual"
  | "poll"
  | "push"
  | "redeploy"
  | "update"
export type AppDeploymentStatus = "failed" | "running" | "succeeded" | "unknown"
/** A game server's first install, a reinstall, or a change of its Brick. */
export type ServerDeploymentTrigger = "brick" | "install" | "reinstall"
export type DeploymentKind = "app" | "server"

/** The repository an app builds, and how. */
export interface AppGitHubSource {
  appId: string
  autoDeploy: boolean
  branch: string
  build: AppGitHubBuild
  /** Null once its source was removed from Kiln. */
  connectionId: string | null
  createdBy: string
  path: string
  /** The app's Relay. */
  relayId: string
  repository: string
  repositoryId: number
}

export interface AppDeploymentRecord {
  appId: string
  branch: string | null
  commitAuthor: string | null
  commitMessage: string | null
  commitSha: string | null
  error: string | null
  finishedAt: string | null
  id: string
  /** The digest an image update deployed. */
  imageDigest: string | null
  /** The deployment's ID on its Relay, which names its log there. */
  relayDeploymentId: string | null
  relayId: string
  repository: string | null
  rolling: boolean | null
  sourceType: AppSourceType
  startedAt: string
  status: AppDeploymentStatus
  trigger: AppDeploymentTrigger
  /** The person who deployed; null for pushes, polls, and updates. */
  triggeredBy: string | null
}

/** A game server's install, reinstall, or change of Brick. */
export interface ServerDeploymentRecord {
  /** The Brick it installed; null when the Relay didn't say. */
  brickId: string | null
  brickName: string | null
  error: string | null
  finishedAt: string | null
  /** Hearth's ID, which also names its log on the Relay. */
  id: string
  /** The game server's instance ID. */
  instanceId: string
  relayId: string
  startedAt: string
  status: AppDeploymentStatus
  trigger: ServerDeploymentTrigger
  /** The person who asked. */
  triggeredBy: string | null
}

/** A deployment of either kind, as the Deployments page lists them. */
export type DeploymentRecord =
  | ({ kind: "app" } & AppDeploymentRecord)
  | ({ kind: "server" } & ServerDeploymentRecord)

interface SourceRow extends RowDataPacket {
  app_id: string
  relay_id: string
  auto_deploy: boolean | number
  branch: string
  build: AppGitHubBuild
  connection_id: string | null
  created_by: string
  path: string
  repository: string
  repository_id: number | string
}

interface DeploymentRow extends RowDataPacket {
  brick_id: string | null
  brick_name: string | null
  branch: string | null
  commit_author: string | null
  commit_message: string | null
  commit_sha: string | null
  error: string | null
  finished_at: number | string | null
  id: string
  image_digest: string | null
  instance_id: string
  instance_kind: DeploymentKind
  relay_deployment_id: string | null
  relay_id: string
  repository: string | null
  rolling: boolean | number | null
  source_type: AppSourceType | null
  started_at: number | string
  status: AppDeploymentStatus
  trigger: AppDeploymentTrigger | ServerDeploymentTrigger
  triggered_by: string | null
}

// With the app's Relay, from its row.
const sourceColumns = `source.app_id, source.connection_id,
  source.repository_id, source.repository, source.branch, source.build,
  source.path, source.auto_deploy, source.created_by, app.relay_id`

function sourceTable() {
  return `${databaseTable("app_github_source")} source
    JOIN ${databaseTable("app")} app ON app.app_id = source.app_id`
}

const deploymentColumns = `id, instance_kind, instance_id, relay_id,
  relay_deployment_id, source_type, brick_id, brick_name, \`trigger\`,
  triggered_by, repository, branch, commit_sha, commit_message, commit_author,
  image_digest, status, rolling, error, started_at, finished_at`

// Deployments kept per instance, newest first.
const deploymentsKeptPerInstance = 200

function deploymentTable() {
  return databaseTable("deployment")
}

export const loadAppGitHubSourceEffect = Effect.fn("apps.github.source")(
  function* (appId: string) {
    const database = yield* Database
    const [row] = yield* database.queryRows<SourceRow>(
      "apps.github.source",
      `SELECT ${sourceColumns}
         FROM ${sourceTable()}
        WHERE source.app_id = ?
        LIMIT 1`,
      [appId]
    )
    return row ? toSource(row) : null
  }
)

/** Sources that deploy on their own, by repository or connection. */
export const loadAutoDeployGitHubSourcesEffect = Effect.fn(
  "apps.github.sources.autoDeploy"
)(function* (
  where: { connectionId: string; repositoryId: number } | { polled: true }
) {
  const database = yield* Database
  const rows =
    "polled" in where
      ? // Connections GitHub can't deliver pushes to.
        yield* database.queryRows<SourceRow>(
          "apps.github.sources.polled",
          `SELECT ${sourceColumns}
             FROM ${sourceTable()}
             JOIN ${databaseTable("github_connection")} connection
               ON connection.id = source.connection_id
            WHERE source.auto_deploy = 1
              AND connection.webhook_active = 0`
        )
      : yield* database.queryRows<SourceRow>(
          "apps.github.sources.pushed",
          `SELECT ${sourceColumns}
             FROM ${sourceTable()}
            WHERE source.auto_deploy = 1
              AND source.connection_id = ?
              AND source.repository_id = ?`,
          [where.connectionId, where.repositoryId]
        )
  return rows.map(toSource)
})

/** How many apps deploy from each connection. */
export const countAppGitHubSourcesEffect = Effect.fn(
  "apps.github.sources.count"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<
    RowDataPacket & { connection_id: string; count: number | string }
  >(
    "apps.github.sources.count",
    `SELECT connection_id, COUNT(*) AS count
       FROM ${databaseTable("app_github_source")}
      WHERE connection_id IS NOT NULL
      GROUP BY connection_id`
  )
  return new Map(rows.map((row) => [row.connection_id, Number(row.count)]))
})

export const saveAppGitHubSourceEffect = Effect.fn("apps.github.source.save")(
  function* (source: Omit<AppGitHubSource, "relayId">) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "apps.github.source.save",
      `INSERT INTO ${databaseTable("app_github_source")}
         (app_id, connection_id, repository_id, repository, branch, build,
          path, auto_deploy, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         connection_id = VALUES(connection_id),
         repository_id = VALUES(repository_id),
         repository = VALUES(repository),
         branch = VALUES(branch),
         build = VALUES(build),
         path = VALUES(path),
         auto_deploy = VALUES(auto_deploy),
         updated_at = VALUES(updated_at)`,
      [
        source.appId,
        source.connectionId,
        source.repositoryId,
        source.repository,
        source.branch,
        source.build,
        source.path,
        source.autoDeploy,
        source.createdBy,
        now,
        now,
      ]
    )
  }
)

/**
 * Records a deployment, once: recording one again, as a durable step run
 * again does, changes nothing.
 */
export const insertAppDeploymentEffect = Effect.fn("apps.deployment.insert")(
  function* (record: AppDeploymentRecord) {
    const database = yield* Database
    yield* database.execute(
      "apps.deployment.insert",
      `INSERT INTO ${deploymentTable()}
         (id, instance_kind, instance_id, relay_id, relay_deployment_id,
          source_type, \`trigger\`, triggered_by, repository, branch,
          commit_sha, commit_message, commit_author, image_digest, status,
          rolling, error, started_at, finished_at)
       VALUES (?, 'app', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        record.id,
        record.appId,
        record.relayId,
        record.relayDeploymentId,
        record.sourceType,
        record.trigger,
        record.triggeredBy,
        record.repository,
        record.branch,
        record.commitSha,
        record.commitMessage?.slice(0, 255) ?? null,
        record.commitAuthor?.slice(0, 100) ?? null,
        record.imageDigest,
        record.status,
        record.rolling,
        record.error?.slice(0, 2_000) ?? null,
        Date.parse(record.startedAt),
        record.finishedAt === null ? null : Date.parse(record.finishedAt),
      ]
    )
    yield* pruneDeploymentsEffect("app", record.appId)
  }
)

/**
 * Records a game server's install, reinstall, or change of Brick as
 * running, once: recording it again changes nothing.
 */
export const insertServerDeploymentEffect = Effect.fn(
  "servers.deployment.insert"
)(function* (
  record: Pick<
    ServerDeploymentRecord,
    | "brickId"
    | "brickName"
    | "id"
    | "instanceId"
    | "relayId"
    | "trigger"
    | "triggeredBy"
  >
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "servers.deployment.insert",
    `INSERT INTO ${deploymentTable()}
       (id, instance_kind, instance_id, relay_id, brick_id, brick_name,
        \`trigger\`, triggered_by, status, started_at)
     VALUES (?, 'server', ?, ?, ?, ?, ?, ?, 'running', ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [
      record.id,
      record.instanceId,
      record.relayId,
      record.brickId?.slice(0, 64) ?? null,
      record.brickName?.slice(0, 255) ?? null,
      record.trigger,
      record.triggeredBy,
      now,
    ]
  )
  yield* pruneDeploymentsEffect("server", record.instanceId)
})

// The oldest past what each instance keeps.
const pruneDeploymentsEffect = Effect.fnUntraced(function* (
  kind: DeploymentKind,
  instanceId: string
) {
  const database = yield* Database
  yield* database.execute(
    "deployments.prune",
    `DELETE FROM ${deploymentTable()}
      WHERE instance_kind = ? AND instance_id = ?
        AND id NOT IN (
          SELECT id FROM (
            SELECT id FROM ${deploymentTable()}
             WHERE instance_kind = ? AND instance_id = ?
             ORDER BY started_at DESC, id DESC
             LIMIT ${deploymentsKeptPerInstance}
          ) kept
        )`,
    [kind, instanceId, kind, instanceId]
  )
})

/**
 * Records how a game server's deployment ended. False if it had already
 * ended, so two watchers can't both report it.
 */
export const finishServerDeploymentEffect = Effect.fn(
  "servers.deployment.finish"
)(function* (
  id: string,
  outcome: {
    error: string | null
    status: Exclude<AppDeploymentStatus, "running">
  }
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const result = yield* database.execute(
    "servers.deployment.finish",
    `UPDATE ${deploymentTable()}
        SET status = ?, error = ?, finished_at = ?
      WHERE id = ? AND instance_kind = 'server' AND status = 'running'`,
    [outcome.status, outcome.error?.slice(0, 2_000) ?? null, now, id]
  )
  return result.affectedRows === 1
})

/** A game server's install still running, which a retried create resumes. */
export const loadRunningServerInstallEffect = Effect.fn(
  "servers.deployment.runningInstall"
)(function* (instanceId: string) {
  const database = yield* Database
  const [row] = yield* database.queryRows<DeploymentRow>(
    "servers.deployment.runningInstall",
    `SELECT ${deploymentColumns}
       FROM ${deploymentTable()}
      WHERE instance_kind = 'server' AND instance_id = ?
        AND \`trigger\` = 'install' AND status = 'running'
      ORDER BY started_at DESC, id DESC
      LIMIT 1`,
    [instanceId]
  )
  const record = row ? toRecord(row) : null
  return record?.kind === "server" ? record : null
})

/** Game server deployments recorded as running, oldest first. */
export const loadRunningServerDeploymentsEffect = Effect.fn(
  "servers.deployments.running"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<DeploymentRow>(
    "servers.deployments.running",
    `SELECT ${deploymentColumns}
       FROM ${deploymentTable()}
      WHERE instance_kind = 'server' AND status = 'running'
      ORDER BY started_at ASC`
  )
  return rows.flatMap((row) => {
    const record = toRecord(row)
    return record.kind === "server" ? [record] : []
  })
})

/** Forgets a deleted App's or game server's deployments. */
export const deleteInstanceDeploymentsEffect = Effect.fn(
  "deployments.deleteInstance"
)(function* (kind: DeploymentKind, instanceId: string) {
  const database = yield* Database
  yield* database.execute(
    "deployments.deleteInstance",
    `DELETE FROM ${deploymentTable()}
      WHERE instance_kind = ? AND instance_id = ?`,
    [kind, instanceId]
  )
})

/** Records the ID a deployment's Relay gave it, which names its log there. */
export const recordRelayDeploymentEffect = Effect.fn("apps.deployment.relayId")(
  function* (id: string, relayDeploymentId: string) {
    const database = yield* Database
    yield* database.execute(
      "apps.deployment.relayId",
      `UPDATE ${deploymentTable()}
        SET relay_deployment_id = ?
      WHERE id = ? AND instance_kind = 'app'`,
      [relayDeploymentId, id]
    )
  }
)

/**
 * Records how a running deployment ended. False if it had already ended,
 * so two watchers can't both report it.
 */
export const finishAppDeploymentEffect = Effect.fn("apps.deployment.finish")(
  function* (
    id: string,
    outcome: {
      error: string | null
      finishedAt: string
      rolling: boolean | null
      status: Exclude<AppDeploymentStatus, "running">
    }
  ) {
    const database = yield* Database
    return yield* database.transaction(
      "apps.deployment.finish",
      (transaction) =>
        Effect.gen(function* () {
          const [record] = yield* transaction.queryRows<
            RowDataPacket & { instance_id: string; relay_id: string }
          >(
            `SELECT instance_id, relay_id FROM ${deploymentTable()}
              WHERE id = ? AND instance_kind = 'app' FOR UPDATE`,
            [id]
          )
          const result = yield* transaction.execute(
            `UPDATE ${deploymentTable()}
          SET status = ?, error = ?, rolling = ?, finished_at = ?
        WHERE id = ? AND instance_kind = 'app' AND status = 'running'`,
            [
              outcome.status,
              outcome.error?.slice(0, 2_000) ?? null,
              outcome.rolling,
              Date.parse(outcome.finishedAt),
              id,
            ]
          )
          if (result.affectedRows === 1 && record) {
            // Even a failed deploy can have created volumes before it ended.
            yield* invalidateScheduleDeploymentsEffect(transaction, {
              backupOnly: true,
              relayId: record.relay_id,
              target: { id: record.instance_id, kind: "app" },
            })
          }
          return result.affectedRows === 1
        })
    )
  }
)

export const loadAppDeploymentEffect = Effect.fn("apps.deployment.load")(
  function* (id: string) {
    const database = yield* Database
    const [row] = yield* database.queryRows<DeploymentRow>(
      "apps.deployment.load",
      `SELECT ${deploymentColumns}
         FROM ${deploymentTable()}
        WHERE id = ?
        LIMIT 1`,
      [id]
    )
    const record = row ? toRecord(row) : null
    return record?.kind === "app" ? record : null
  }
)

/** A deployment of either kind. */
export const loadDeploymentEffect = Effect.fn("deployments.load")(function* (
  id: string
) {
  const database = yield* Database
  const [row] = yield* database.queryRows<DeploymentRow>(
    "deployments.load",
    `SELECT ${deploymentColumns}
       FROM ${deploymentTable()}
      WHERE id = ?
      LIMIT 1`,
    [id]
  )
  return row ? toRecord(row) : null
})

/** Which of one kind's deployments a person may see. */
export interface ReachableDeployments {
  /** Every one on these Relays. */
  relayIds: ReadonlyArray<string>
  /** And these instances', wherever they are. */
  instanceIds: ReadonlyArray<string>
}

/**
 * Deployments newest first, of the Apps and game servers a person may see,
 * or of one of them, before a cursor from the previous page.
 */
export const listDeploymentsEffect = Effect.fn("deployments.list")(
  function* (input: {
    before?: { id: string; startedAt: string }
    /** Only this instance's. */
    instance?: { id: string; kind: DeploymentKind }
    limit: number
    reachable: Partial<Record<DeploymentKind, ReachableDeployments>>
  }) {
    const parameters: Array<number | string> = []
    const reachable = (["app", "server"] as const).flatMap((kind) => {
      const scope = input.reachable[kind]
      if (!scope) return []
      if (input.instance && input.instance.kind !== kind) return []
      const within = [
        ...(scope.relayIds.length
          ? [`relay_id IN (${scope.relayIds.map(() => "?").join(", ")})`]
          : []),
        ...(scope.instanceIds.length
          ? [`instance_id IN (${scope.instanceIds.map(() => "?").join(", ")})`]
          : []),
      ]
      if (within.length === 0) return []
      parameters.push(kind, ...scope.relayIds, ...scope.instanceIds)
      return [`(instance_kind = ? AND (${within.join(" OR ")}))`]
    })
    if (reachable.length === 0) return []
    const database = yield* Database
    const conditions = [`(${reachable.join(" OR ")})`]
    if (input.instance) {
      conditions.push("instance_kind = ? AND instance_id = ?")
      parameters.push(input.instance.kind, input.instance.id)
    }
    if (input.before) {
      const startedAt = Date.parse(input.before.startedAt)
      conditions.push("(started_at < ? OR (started_at = ? AND id < ?))")
      parameters.push(startedAt, startedAt, input.before.id)
    }
    const rows = yield* database.queryRows<DeploymentRow>(
      "deployments.list",
      `SELECT ${deploymentColumns}
       FROM ${deploymentTable()}
      WHERE ${conditions.join(" AND ")}
      ORDER BY started_at DESC, id DESC
      LIMIT ${Math.max(1, Math.min(input.limit, 500))}`,
      parameters
    )
    return rows.map(toRecord)
  }
)

/**
 * The app's latest deployment, its latest one that succeeded, and its
 * latest of a branch head rather than a commit deployed again, which is
 * what pushes and polls compare the head with.
 */
export const latestAppDeploymentsEffect = Effect.fn("apps.deployments.latest")(
  function* (appId: string) {
    const database = yield* Database
    const select = (where: string) =>
      database.queryRows<DeploymentRow>(
        "apps.deployments.latest",
        `SELECT ${deploymentColumns}
           FROM ${deploymentTable()}
          WHERE instance_kind = 'app' AND instance_id = ? ${where}
          ORDER BY started_at DESC, id DESC
          LIMIT 1`,
        [appId]
      )
    const [[latest], [succeeded], [head]] = yield* Effect.all([
      select(""),
      select("AND status = 'succeeded'"),
      select("AND `trigger` <> 'redeploy'"),
    ])
    return {
      head: head ? toAppDeployment(head) : null,
      latest: latest ? toAppDeployment(latest) : null,
      succeeded: succeeded ? toAppDeployment(succeeded) : null,
    }
  }
)

export const loadRunningAppDeploymentsEffect = Effect.fn(
  "apps.deployments.running"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<DeploymentRow>(
    "apps.deployments.running",
    `SELECT ${deploymentColumns}
       FROM ${deploymentTable()}
      WHERE instance_kind = 'app' AND status = 'running'`
  )
  return rows.map(toAppDeployment)
})

function toSource(row: SourceRow): AppGitHubSource {
  return {
    appId: row.app_id,
    autoDeploy: Boolean(row.auto_deploy),
    branch: row.branch,
    build: row.build,
    connectionId: row.connection_id,
    createdBy: row.created_by,
    path: row.path,
    relayId: row.relay_id,
    repository: row.repository,
    repositoryId: Number(row.repository_id),
  }
}

function toRecord(row: DeploymentRow): DeploymentRecord {
  if (row.instance_kind === "server") {
    return {
      brickId: row.brick_id,
      brickName: row.brick_name,
      error: row.error,
      finishedAt: instant(row.finished_at),
      id: row.id,
      instanceId: row.instance_id,
      kind: "server",
      relayId: row.relay_id,
      startedAt: new Date(Number(row.started_at)).toISOString(),
      status: row.status,
      trigger: row.trigger as ServerDeploymentTrigger,
      triggeredBy: row.triggered_by,
    }
  }
  return { kind: "app", ...toAppDeployment(row) }
}

function instant(value: number | string | null): string | null {
  return value === null ? null : new Date(Number(value)).toISOString()
}

function toAppDeployment(row: DeploymentRow): AppDeploymentRecord {
  return {
    appId: row.instance_id,
    branch: row.branch,
    commitAuthor: row.commit_author,
    commitMessage: row.commit_message,
    commitSha: row.commit_sha,
    error: row.error,
    finishedAt:
      row.finished_at === null
        ? null
        : new Date(Number(row.finished_at)).toISOString(),
    id: row.id,
    imageDigest: row.image_digest,
    relayDeploymentId: row.relay_deployment_id,
    relayId: row.relay_id,
    repository: row.repository,
    rolling: row.rolling === null ? null : Boolean(row.rolling),
    // Every App deployment names its source.
    sourceType: row.source_type ?? "image",
    startedAt: new Date(Number(row.started_at)).toISOString(),
    status: row.status,
    trigger: row.trigger as AppDeploymentTrigger,
    triggeredBy: row.triggered_by,
  }
}

/** What asked an app to deploy. */
export type AppDeploymentAsk =
  | "manual"
  | "poll"
  | "push"
  | "redeploy"
  | "update"
