import { Effect } from "effect"

import {
  backupStorageAccessResponseSchema,
  type BackupStorageAccessGrant,
  type BackupStorageAccessRequest,
} from "@workspace/contracts"

import { RelayBackupError } from "../effect/errors.js"

// Signing is quick; this is how long a Hearth busy with other work gets.
const STORAGE_ACCESS_TIMEOUT_MS = 20_000

const HEARTH_UNREACHABLE = "hearth_unreachable"

/**
 * Asks Hearth for one signed request to a copy of a backup in a bucket.
 * Hearth holds the bucket's keys and decides whether this Relay's task may
 * touch that copy, so the Relay never holds more than the one request.
 */
export type BackupStorageAccess = (
  request: BackupStorageAccessRequest
) => Effect.Effect<BackupStorageAccessGrant, RelayBackupError>

/** Whether a task stopped only because no Hearth could be asked. */
export function isHearthUnreachable(cause: unknown): boolean {
  return cause instanceof RelayBackupError && cause.code === HEARTH_UNREACHABLE
}

/**
 * Asks every Hearth this Relay is connected to, since a task doesn't say
 * which one sent it: the one that knows the task grants it, and any other
 * refuses. `ask` answers with what each connected Hearth said, leaving out
 * those that failed or took too long.
 */
export function backupStorageAccessThrough(
  ask: (
    payload: BackupStorageAccessRequest,
    timeoutMs: number
  ) => Promise<ReadonlyArray<{ readonly payload: unknown }>>
): BackupStorageAccess {
  return Effect.fn("Backups.storageAccess")(function* (request) {
    yield* Effect.annotateCurrentSpan({
      "backup.id": request.backupId,
      "backup.storage.action": request.action,
      "backup.task.id": request.taskId,
    })
    const answers = yield* Effect.tryPromise({
      try: () => ask(request, STORAGE_ACCESS_TIMEOUT_MS),
      catch: (cause) => hearthUnreachable(request, cause),
    })
    let refusal: string | null = null
    for (const answer of answers) {
      const parsed = backupStorageAccessResponseSchema.safeParse(answer.payload)
      if (!parsed.success) continue
      if (parsed.data.status === "granted") return parsed.data
      refusal ??= parsed.data.reason
    }
    if (refusal === null) return yield* hearthUnreachable(request)
    return yield* RelayBackupError.make({
      code: "storage_access_refused",
      operation: `${request.action}.access`,
      reason: `Hearth refused access to the backup's storage: ${refusal}`,
    })
  })
}

function hearthUnreachable(request: BackupStorageAccessRequest, cause?: unknown) {
  return RelayBackupError.make({
    code: HEARTH_UNREACHABLE,
    operation: `${request.action}.access`,
    reason:
      "Hearth couldn't be reached for access to the backup's storage, which only it holds the keys to",
    ...(cause === undefined ? {} : { cause }),
  })
}
