import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import type { AppGitHubBuild, AppSourceType } from "@workspace/contracts"

import { invalidateScheduleDeploymentsEffect } from "@/effect/schedule-invalidation"
import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

// Where apps deploy from on GitHub, and Hearth's record of every app's
// deployments across its Relays. The Relay keeps each deployment's log.

export type AppDeploymentTrigger =
  | "manual"
  | "poll"
  | "push"
  | "redeploy"
  | "update"
export type AppDeploymentStatus = "failed" | "running" | "succeeded" | "unknown"

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
  app_id: string
  branch: string | null
  commit_author: string | null
  commit_message: string | null
  commit_sha: string | null
  error: string | null
  finished_at: number | string | null
  id: string
  image_digest: string | null
  relay_deployment_id: string | null
  relay_id: string
  repository: string | null
  rolling: boolean | number | null
  source_type: AppSourceType
  started_at: number | string
  status: AppDeploymentStatus
  trigger: AppDeploymentTrigger
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

const deploymentColumns = `id, app_id, relay_id, relay_deployment_id,
  source_type, \`trigger\`, triggered_by, repository, branch, commit_sha,
  commit_message, commit_author, image_digest, status, rolling, error,
  started_at, finished_at`

// Deployments kept per app, newest first.
const deploymentsKeptPerApp = 200

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
      `INSERT INTO ${databaseTable("app_deployment")}
         (id, app_id, relay_id, relay_deployment_id, source_type, \`trigger\`,
          triggered_by, repository, branch, commit_sha, commit_message,
          commit_author, image_digest, status, rolling, error, started_at,
          finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    // The oldest past what each app keeps.
    yield* database.execute(
      "apps.deployment.prune",
      `DELETE FROM ${databaseTable("app_deployment")}
        WHERE app_id = ?
          AND id NOT IN (
            SELECT id FROM (
              SELECT id FROM ${databaseTable("app_deployment")}
               WHERE app_id = ?
               ORDER BY started_at DESC, id DESC
               LIMIT ${deploymentsKeptPerApp}
            ) kept
          )`,
      [record.appId, record.appId]
    )
  }
)

/** Records the ID a deployment's Relay gave it, which names its log there. */
export const recordRelayDeploymentEffect = Effect.fn("apps.deployment.relayId")(
  function* (id: string, relayDeploymentId: string) {
    const database = yield* Database
    yield* database.execute(
      "apps.deployment.relayId",
      `UPDATE ${databaseTable("app_deployment")}
        SET relay_deployment_id = ?
      WHERE id = ?`,
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
            RowDataPacket & { app_id: string; relay_id: string }
          >(
            `SELECT app_id, relay_id FROM ${databaseTable("app_deployment")} WHERE id = ? FOR UPDATE`,
            [id]
          )
          const result = yield* transaction.execute(
            `UPDATE ${databaseTable("app_deployment")}
          SET status = ?, error = ?, rolling = ?, finished_at = ?
        WHERE id = ? AND status = 'running'`,
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
              target: { id: record.app_id, kind: "app" },
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
         FROM ${databaseTable("app_deployment")}
        WHERE id = ?
        LIMIT 1`,
      [id]
    )
    return row ? toDeployment(row) : null
  }
)

/**
 * Deployments newest first, of one app or some Relays' apps, before a
 * cursor from the previous page.
 */
export const listAppDeploymentsEffect = Effect.fn("apps.deployments.list")(
  function* (input: {
    appId?: string
    before?: { id: string; startedAt: string }
    limit: number
    /** Every app on these Relays. */
    relayIds: ReadonlyArray<string>
    /** And these apps, wherever they are. */
    appIds?: ReadonlyArray<string>
  }) {
    const appIds = input.appIds ?? []
    if (input.relayIds.length === 0 && appIds.length === 0) return []
    const database = yield* Database
    const reachable = [
      ...(input.relayIds.length
        ? [`relay_id IN (${input.relayIds.map(() => "?").join(", ")})`]
        : []),
      ...(appIds.length
        ? [`app_id IN (${appIds.map(() => "?").join(", ")})`]
        : []),
    ]
    const conditions = [`(${reachable.join(" OR ")})`]
    const parameters: Array<number | string> = [...input.relayIds, ...appIds]
    if (input.appId) {
      conditions.push("app_id = ?")
      parameters.push(input.appId)
    }
    if (input.before) {
      const startedAt = Date.parse(input.before.startedAt)
      conditions.push("(started_at < ? OR (started_at = ? AND id < ?))")
      parameters.push(startedAt, startedAt, input.before.id)
    }
    const rows = yield* database.queryRows<DeploymentRow>(
      "apps.deployments.list",
      `SELECT ${deploymentColumns}
         FROM ${databaseTable("app_deployment")}
        WHERE ${conditions.join(" AND ")}
        ORDER BY started_at DESC, id DESC
        LIMIT ${Math.max(1, Math.min(input.limit, 500))}`,
      parameters
    )
    return rows.map(toDeployment)
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
           FROM ${databaseTable("app_deployment")}
          WHERE app_id = ? ${where}
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
      head: head ? toDeployment(head) : null,
      latest: latest ? toDeployment(latest) : null,
      succeeded: succeeded ? toDeployment(succeeded) : null,
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
       FROM ${databaseTable("app_deployment")}
      WHERE status = 'running'`
  )
  return rows.map(toDeployment)
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

function toDeployment(row: DeploymentRow): AppDeploymentRecord {
  return {
    appId: row.app_id,
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
    sourceType: row.source_type,
    startedAt: new Date(Number(row.started_at)).toISOString(),
    status: row.status,
    trigger: row.trigger,
    triggeredBy: row.triggered_by,
  }
}

/** What asked an app to deploy, the newest ask's. */
export type AppDeploymentAsk =
  | "manual"
  | "poll"
  | "push"
  | "redeploy"
  | "update"

/** What an app's waiting deployment request asks for. */
export interface AppDeploymentRequestRow {
  /** The revision its deployments have taken up to. */
  readonly acknowledgedRevision: number
  readonly appId: string
  /**
   * The commit a push named, and where it's from, `<repository ID>/<branch>`,
   * or the commit a redeploy redeploys, and the repository it was of.
   * Without one, a GitHub app deploys its branch's newest.
   */
  readonly commitSha: string | null
  readonly commitSource: string | null
  /** The digest a redeploy redeploys, and the image it was of. */
  readonly imageDigest: string | null
  readonly imageSource: string | null
  readonly relayId: string
  /**
   * Who asked, while a person's ask waits: it builds even what's already
   * live, and deploys an update whatever its wait.
   */
  readonly requestedBy: string | null
  /** Counts every ask, so one taken leaves those since waiting. */
  readonly revision: number
  readonly trigger: AppDeploymentAsk
}

interface TakenRow extends RowDataPacket {
  taken_by: string | null
  taken_commit_sha: string | null
  taken_commit_source: string | null
  taken_image_digest: string | null
  taken_image_source: string | null
  taken_requested_by: string | null
  taken_trigger: AppDeploymentAsk | null
}

interface RequestRow extends RowDataPacket {
  acknowledged_revision: number | string
  app_id: string
  commit_sha: string | null
  commit_source: string | null
  image_digest: string | null
  image_source: string | null
  relay_id: string
  requested_by: string | null
  revision: number | string
  trigger: AppDeploymentAsk
}

const requestColumns =
  "app_id, relay_id, `trigger`, commit_sha, commit_source, image_digest, image_source, requested_by, revision, acknowledged_revision"

// Kept once taken, with what was taken, so an ask is waiting while its
// revision is ahead of that.
const requestPending = "revision > acknowledged_revision"

function toRequest(row: RequestRow): AppDeploymentRequestRow {
  return {
    acknowledgedRevision: Number(row.acknowledged_revision),
    appId: row.app_id,
    commitSha: row.commit_sha,
    commitSource: row.commit_source,
    imageDigest: row.image_digest,
    imageSource: row.image_source,
    relayId: row.relay_id,
    requestedBy: row.requested_by,
    revision: Number(row.revision),
    trigger: row.trigger,
  }
}

/**
 * Asks an app to deploy, joining what already waits: the newest ask's
 * trigger and target win, a push's or a redeploy's commit, a redeploy's
 * digest, the newest code for anything else. A poll, which only notes the
 * branch may have moved, leaves an ask waiting as it is. A person's ask is
 * kept, by who made it, until a deployment takes it. Returns the revision
 * its deployments have taken up to, which names the one that takes it.
 */
export const requestAppDeploymentEffect = Effect.fn("apps.deployment.request")(
  function* (input: {
    appId: string
    /** The commit a push names, or a redeploy redeploys, and its source. */
    commit?: { sha: string; source: string }
    /** The digest a redeploy redeploys, and the image it was of. */
    image?: { digest: string; source: string }
    relayId: string
    trigger: AppDeploymentAsk
    /** The person who asked; null for Kiln's own. */
    userId?: string | null
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const keep = `(${requestPending} AND VALUES(\`trigger\`) = 'poll')`
    // Assigned in order, so each reads whether the request was still
    // waiting before its revision moves on.
    return yield* database.transaction(
      "apps.deployment.request",
      (transaction) =>
        Effect.gen(function* () {
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("app_deployment_request")}
         (app_id, relay_id, \`trigger\`, commit_sha, commit_source,
          image_digest, image_source, requested_by, revision, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         relay_id = VALUES(relay_id),
         commit_sha = IF(${keep}, commit_sha, VALUES(commit_sha)),
         commit_source = IF(${keep}, commit_source, VALUES(commit_source)),
         image_digest = IF(${keep}, image_digest, VALUES(image_digest)),
         image_source = IF(${keep}, image_source, VALUES(image_source)),
         requested_by = IF(VALUES(requested_by) IS NOT NULL,
           VALUES(requested_by), IF(${requestPending}, requested_by, NULL)),
         \`trigger\` = IF(${keep}, \`trigger\`, VALUES(\`trigger\`)),
         requested_at = VALUES(requested_at),
         revision = revision + 1`,
            [
              input.appId,
              input.relayId,
              input.trigger,
              input.commit?.sha ?? null,
              input.commit?.source ?? null,
              input.image?.digest ?? null,
              input.image?.source ?? null,
              input.userId ?? null,
              now,
            ]
          )
          const [row] = yield* transaction.queryRows<
            RowDataPacket & { acknowledged_revision: number | string }
          >(
            `SELECT acknowledged_revision
             FROM ${databaseTable("app_deployment_request")}
            WHERE app_id = ?`,
            [input.appId]
          )
          return Number(row?.acknowledged_revision ?? 0)
        })
    )
  }
)

/** The app's waiting ask, if any. */
export const loadAppDeploymentRequestEffect = Effect.fn(
  "apps.deployment.request.load"
)(function* (appId: string) {
  const database = yield* Database
  const [row] = yield* database.queryRows<RequestRow>(
    "apps.deployment.request.load",
    `SELECT ${requestColumns}
       FROM ${databaseTable("app_deployment_request")}
      WHERE app_id = ? AND ${requestPending}`,
    [appId]
  )
  return row ? toRequest(row) : null
})

/** Every waiting ask, for a Hearth that just started to take up. */
export const loadAppDeploymentRequestsEffect = Effect.fn(
  "apps.deployment.requests"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<RequestRow>(
    "apps.deployment.requests",
    `SELECT ${requestColumns}
       FROM ${databaseTable("app_deployment_request")}
      WHERE ${requestPending}`
  )
  return rows.map(toRequest)
})

/**
 * Takes what the app's request asks, as a deployment plans, in one step,
 * keeping what it took apart: what's asked since waits for the next. The
 * same deployment taking it again, its step run again, takes what's
 * waiting now, the newest, or gets back what it took, whatever was asked
 * or cancelled since.
 */
export const takeAppDeploymentRequestEffect = Effect.fn(
  "apps.deployment.request.take"
)(function* (appId: string, deploymentId: string) {
  const database = yield* Database
  return yield* database.transaction(
    "apps.deployment.request.take",
    (transaction) =>
      Effect.gen(function* () {
        const [row] = yield* transaction.queryRows<RequestRow & TakenRow>(
          `SELECT ${requestColumns}, taken_by, taken_trigger, taken_commit_sha,
                  taken_commit_source, taken_image_digest, taken_image_source,
                  taken_requested_by
             FROM ${databaseTable("app_deployment_request")}
            WHERE app_id = ?
            FOR UPDATE`,
          [appId]
        )
        if (!row) return null
        const request = toRequest(row)
        if (request.revision > request.acknowledgedRevision) {
          yield* transaction.execute(
            `UPDATE ${databaseTable("app_deployment_request")}
                SET acknowledged_revision = revision, taken_by = ?,
                    taken_trigger = \`trigger\`, taken_commit_sha = commit_sha,
                    taken_commit_source = commit_source,
                    taken_image_digest = image_digest,
                    taken_image_source = image_source,
                    taken_requested_by = requested_by
              WHERE app_id = ?`,
            [deploymentId, appId]
          )
          return request
        }
        if (row.taken_by !== deploymentId || row.taken_trigger === null) {
          return null
        }
        return {
          ...request,
          commitSha: row.taken_commit_sha,
          commitSource: row.taken_commit_source,
          imageDigest: row.taken_image_digest,
          imageSource: row.taken_image_source,
          requestedBy: row.taken_requested_by,
          trigger: row.taken_trigger,
        }
      })
  )
})

/**
 * Withdraws the app's waiting ask at `revision`, as one taken would be, so
 * no deployment takes it. False once a deployment has taken it, or another
 * ask has joined it since.
 */
export const cancelAppDeploymentRequestEffect = Effect.fn(
  "apps.deployment.request.cancel"
)(function* (appId: string, revision: number) {
  const database = yield* Database
  const result = yield* database.execute(
    "apps.deployment.request.cancel",
    `UPDATE ${databaseTable("app_deployment_request")}
        SET acknowledged_revision = revision
      WHERE app_id = ? AND revision = ? AND ${requestPending}`,
    [appId, revision]
  )
  return result.affectedRows === 1
})
