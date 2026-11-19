import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import type {
  BackupRepositoryAccessRequest,
  BackupRepositoryAccessResponse,
  RelayBackupTask,
  resticRepositoryObjectTypes,
} from "@workspace/contracts"

import {
  listS3RepositoryFolder,
  loadBackupStorageCredentialEffect,
  resticRepositoryObjectKey,
  s3Failure,
  s3RefusedRequest,
  signS3RepositoryAccess,
} from "@/backups/destinations/s3"
import { Database } from "@/effect/database"
import { runAppEffectUntraced } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"

type ObjectType = (typeof resticRepositoryObjectTypes)[number]

type OpenedRow = RowDataPacket & {
  holds_backups: number | string
  object_prefix: string | null
  storage_id: string | null
}

type TaskRow = OpenedRow & {
  /** The snapshot the task's backup is, once it has one. */
  restic_snapshot_id: string | null
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled"
  task_kind: "create" | "restore" | "delete" | "export"
}

type PruneRow = OpenedRow & {
  /** When Hearth admitted the prune, in epoch milliseconds. */
  prune_admitted_at: number | string | null
}

// What a task may write to its repository, and remove from it. Any task
// Hearth opens a repository to may read all of it: restic reads its config,
// keys, index and snapshots before it does anything.
type Rights = {
  remove: ReadonlyArray<ObjectType>
  write: ReadonlyArray<ObjectType>
}

// restic locks a repository for whatever it does there, and clears the
// locks it finds abandoned.
const reads: Rights = { remove: ["locks"], write: ["locks"] }

const rightsOf: Record<TaskRow["task_kind"], Rights> = {
  // A backup adds to a repository, and makes it the first time. It removes
  // nothing a snapshot is made of.
  create: {
    remove: ["locks"],
    write: ["config", "keys", "locks", "snapshots", "index", "data"],
  },
  // Forgetting a snapshot removes its record; its data stays for a prune.
  delete: { remove: ["locks", "snapshots"], write: ["locks"] },
  export: reads,
  restore: reads,
}

// A prune rewrites the packs and index that hold data no snapshot uses.
const pruning: Rights = {
  remove: ["locks", "index", "data"],
  write: ["locks", "index", "data"],
}

// How long a prune Hearth admitted stays open if Hearth never reads that
// it ended, as from a Relay that stopped saying. Hearth closes one that
// ends as it reads the Relay's tasks, well before this.
const PRUNE_OPEN_MS = 24 * 60 * 60 * 1_000

function refused(reason: string): BackupRepositoryAccessResponse {
  return { reason, status: "refused" }
}

// A backup being deleted is still in the repository until restic has
// forgotten it, and is available again if that fails.
const holdsBackups = `EXISTS (
  SELECT 1 FROM ${databaseTable("backup")} kept
   WHERE kept.repository_id = repository.id
     AND kept.status IN ('available', 'deleting')
)`

/**
 * Answers a Relay whose restic asked for a file or a folder of a
 * repository in a bucket (`backup.repository.access`): one signed request
 * for that file, a page of that folder, or a refusal.
 *
 * Hearth holds the bucket's keys and knows where in it each repository is,
 * so the Relay names neither. It names a task, and Hearth finds the
 * repository from it. The rule is one: the task is one Hearth knows, of
 * the Relay that asks, and still open.
 *
 * - A task Hearth sent, or admitted from a schedule, is open while it is
 *   still to run or running. What it may write and remove follows from
 *   its kind (`rightsOf`): only a backup adds data, only a delete forgets
 *   a snapshot, and a restore or export changes nothing but locks.
 * - A prune is the Relay's own task. Hearth knows it only once it has
 *   admitted it (`admitRepositoryPruneEffect`), and it is open until
 *   Hearth reads that it ended.
 * - A repository's `config` and `keys` are written while it holds no
 *   backup, as when it is made, and never after: replacing them would lose
 *   every backup in it.
 * - The destination can still be used: enabled for a new backup, and not
 *   being deleted for anything.
 *
 * A Relay that backs a server up can still damage that server's backups in
 * the repository: a backup can write over a file, and a prune removes
 * data. What it cannot do is reach another repository, anything else in
 * the bucket, or any of it once Hearth stops answering.
 */
export const grantBackupRepositoryAccessEffect = Effect.fnUntraced(function* (
  relayId: string,
  request: BackupRepositoryAccessRequest
) {
  const database = yield* Database
  const [task] = yield* database.queryRows<TaskRow>(
    "backup_repository_access",
    `SELECT task.task_kind, task.status, backup.restic_snapshot_id,
            repository.object_prefix,
            repository.storage_id, ${holdsBackups} AS holds_backups
       FROM ${databaseTable("backup_task")} task
       JOIN ${databaseTable("backup")} backup ON backup.id = task.backup_id
       JOIN ${databaseTable("backup_repository")} repository
         ON repository.id = backup.repository_id
      WHERE task.id = ? AND backup.relay_id = ?
      LIMIT 1`,
    [request.taskId, relayId]
  )
  let opened: OpenedRow
  let rights: Rights
  let creating = false
  if (task) {
    if (task.status !== "queued" && task.status !== "running") {
      return refused(`the task is ${task.status}`)
    }
    // A delete forgets the snapshot its backup is, and no other. One whose
    // backup never recorded a snapshot, as a create that was cancelled as
    // it finished, is found on the Relay by its tag, which Hearth can't
    // check from here.
    if (
      request.method === "DELETE" &&
      request.type === "snapshots" &&
      task.restic_snapshot_id !== null &&
      !request.name?.startsWith(task.restic_snapshot_id)
    ) {
      return refused("that isn't the snapshot this delete is of")
    }
    opened = task
    rights = rightsOf[task.task_kind]
    creating = task.task_kind === "create"
  } else {
    const [prune] = yield* database.queryRows<PruneRow>(
      "backup_repository_access_prune",
      `SELECT repository.object_prefix, repository.storage_id,
              repository.prune_admitted_at, ${holdsBackups} AS holds_backups
         FROM ${databaseTable("backup_repository")} repository
        WHERE repository.prune_task_id = ? AND repository.relay_id = ?
        LIMIT 1`,
      [request.taskId, relayId]
    )
    if (!prune) return refused("Hearth knows no such task of this Relay's")
    // A time that can't be read opens nothing.
    const age =
      (yield* Clock.currentTimeMillis) -
      Number(prune.prune_admitted_at ?? Number.NaN)
    if (!(age <= PRUNE_OPEN_MS)) {
      return refused("that prune was admitted too long ago")
    }
    opened = prune
    rights = pruning
  }
  if (!opened.storage_id || !opened.object_prefix) {
    return refused("that backup's repository isn't in a bucket")
  }
  if (request.method === "PUT" && !rights.write.includes(request.type)) {
    return refused(`this task may not write the repository's ${request.type}`)
  }
  if (request.method === "DELETE" && !rights.remove.includes(request.type)) {
    return refused(`this task may not remove the repository's ${request.type}`)
  }
  if (
    request.method === "PUT" &&
    (request.type === "config" || request.type === "keys") &&
    Number(opened.holds_backups) > 0
  ) {
    return refused(
      `the repository holds backups, and its ${request.type} can't be replaced`
    )
  }
  const storage = yield* loadBackupStorageCredentialEffect(opened.storage_id)
  // As a task Hearth sends is held to.
  if (!storage || storage.deleting || (creating && !storage.enabled)) {
    return refused("the backup destination is unavailable")
  }
  if (request.method === "LIST") {
    if (request.type === "config" || request.name !== null) {
      return refused("only a folder can be listed")
    }
    return yield* listS3RepositoryFolder(
      storage,
      opened.object_prefix,
      request.type,
      request.continuationToken
    ).pipe(
      // A bucket that refuses the listing is answered as a refusal, with
      // what it said: unanswered, the Relay would take Hearth for away and
      // try again to no end. One that failed in passing is left
      // unanswered, so restic does try again.
      Effect.catch((cause) =>
        s3RefusedRequest(cause)
          ? Effect.succeed(
              refused(
                `the bucket refused to list it: ${s3Failure(cause)?.said ?? "no reason given"}`.slice(
                  0,
                  300
                )
              )
            )
          : Effect.fail(cause)
      )
    )
  }
  // `config` is the one file without a name; every other has one.
  if ((request.type === "config") !== (request.name === null)) {
    return refused("that isn't a file of a repository")
  }
  return yield* signS3RepositoryAccess(
    storage,
    resticRepositoryObjectKey(opened.object_prefix, request.type, request.name),
    request.method
  )
})

type PruneOffer =
  | { status: "admitted" }
  | { reason: string; status: "refused" }

/**
 * Admits a prune of a repository in a bucket that a Relay offers
 * (`backup.task.offer`), or doesn't.
 *
 * A Relay starts a prune itself, once the deletes waiting on a repository
 * have run, and one prune covers them. It removes data, so Hearth opens
 * the repository to it only for something Hearth asked for: a delete of a
 * snapshot there, asked for since the last prune Hearth admitted, that has
 * ended (`prune_owed`, set as Hearth reads that the delete ended), or one
 * still under way. A backup that failed owes none, which a Relay could
 * bring about itself, and neither does the passing of time.
 *
 * Admitting one covers every delete Hearth has asked for there by then,
 * ended or still under way, and spends what was owed: one delete opens
 * the repository to one prune, however long the delete stays open.
 * The same prune offered again, as when its answer was lost, is admitted
 * again.
 */
export const admitRepositoryPruneEffect = Effect.fn("backups.admitPrune")(
  function* (relayId: string, task: RelayBackupTask) {
    const repositoryId =
      task.input.kind === "prune" && task.input.repository.kind === "s3"
        ? task.input.repository.repositoryId
        : undefined
    if (!repositoryId) {
      return {
        reason: "it names no repository in a bucket",
        status: "refused",
      } satisfies PruneOffer
    }
    yield* Effect.annotateCurrentSpan({
      "backup.repository.id": repositoryId,
      "backup.task.id": task.taskId,
      "relay.id": relayId,
    })
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction("backup_admit_prune", (transaction) =>
      Effect.gen(function* () {
        const [repository] = yield* transaction.queryRows<
          RowDataPacket & {
            prune_admitted_at: number | string | null
            prune_owed: number | string
            prune_task_id: string | null
          }
        >(
          `SELECT prune_owed, prune_task_id, prune_admitted_at
             FROM ${databaseTable("backup_repository")}
            WHERE id = ? AND relay_id = ? AND storage_id IS NOT NULL
            FOR UPDATE`,
          [repositoryId, relayId]
        )
        if (!repository) {
          return {
            reason: "Hearth knows no such repository of this Relay's in a bucket",
            status: "refused",
          } satisfies PruneOffer
        }
        if (repository.prune_task_id === task.taskId) {
          return { status: "admitted" } satisfies PruneOffer
        }
        const [deleting] = yield* transaction.queryRows<RowDataPacket>(
          `SELECT 1
             FROM ${databaseTable("backup")} backup
             JOIN ${databaseTable("backup_task")} task
               ON task.backup_id = backup.id
            WHERE backup.repository_id = ? AND task.task_kind = 'delete'
              AND task.status IN ('queued', 'running')
              -- One asked for before the last prune Hearth admitted was
              -- covered by that prune, and opens the repository to no other.
              AND (? IS NULL OR task.created_at > ?)
            LIMIT 1`,
          [
            repositoryId,
            repository.prune_admitted_at,
            repository.prune_admitted_at,
          ]
        )
        if (Number(repository.prune_owed) === 0 && !deleting) {
          return {
            reason: "no delete Hearth asked for there is owed a prune",
            status: "refused",
          } satisfies PruneOffer
        }
        yield* transaction.execute(
          `UPDATE ${databaseTable("backup_repository")}
              SET prune_owed = 0, prune_task_id = ?, prune_admitted_at = ?
            WHERE id = ?`,
          [task.taskId, now, repositoryId]
        )
        return { status: "admitted" } satisfies PruneOffer
      })
    )
  }
)

/**
 * Closes a Relay's repositories to prunes that have ended, as Hearth reads
 * the Relay's tasks: an admitted prune is open only until then.
 */
export const closeRepositoryPrunesEffect = Effect.fn("backups.closePrunes")(
  function* (relayId: string, taskIds: ReadonlyArray<string>) {
    if (taskIds.length === 0) return
    const database = yield* Database
    yield* database.execute(
      "backup_close_prunes",
      `UPDATE ${databaseTable("backup_repository")}
          SET prune_task_id = NULL
        WHERE relay_id = ?
          AND prune_task_id IN (${taskIds.map(() => "?").join(", ")})`,
      [relayId, ...taskIds]
    )
  }
)

/**
 * Answers `backup.repository.access` for the Relay a control connection
 * is. restic asks for each file it touches, so this runs many times a
 * backup and makes no trace of its own.
 */
export function answerBackupRepositoryAccess(
  relayId: string,
  request: BackupRepositoryAccessRequest
): Promise<BackupRepositoryAccessResponse> {
  return runAppEffectUntraced(
    grantBackupRepositoryAccessEffect(relayId, request)
  )
}
