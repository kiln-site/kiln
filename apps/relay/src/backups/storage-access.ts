import { Effect } from "effect"

import {
  backupStorageAccessResponseSchema,
  type BackupStorageAccessGrant,
  type BackupStorageAccessRequest,
} from "@workspace/contracts"

import { RelayBackupError } from "../effect/errors.js"

// Signing is quick; this is how long a Hearth busy with other work gets.
const STORAGE_ACCESS_TIMEOUT_MS = 20_000

/**
 * Asks Hearth for one signed request to a copy of a backup in a bucket.
 * Hearth holds the bucket's keys and decides whether this Relay may use
 * that copy so, so the Relay never holds more than the one request.
 */
export type BackupStorageAccess = (
  request: BackupStorageAccessRequest
) => Effect.Effect<BackupStorageAccessGrant, RelayBackupError>

/**
 * Asks the Hearth a task is for, and no other: a Relay can be paired with
 * several, and another one's answer would send a backup where that one
 * says. `hearth` is the client the task came from, or null for a task
 * stored before that was kept, which any Hearth with full access to the
 * Relay may answer for. `ask` asks the connections of the clients `only`
 * takes, and answers with what each said, leaving out those that failed or
 * took too long.
 */
export function backupStorageAccessThrough(
  ask: (
    payload: BackupStorageAccessRequest,
    timeoutMs: number,
    only: (client: { readonly id: string; readonly role: string }) => boolean
  ) => Promise<ReadonlyArray<{ readonly payload: unknown }>>
) {
  return Effect.fn("Backups.storageAccess")(function* (
    request: BackupStorageAccessRequest,
    hearth: string | null
  ) {
    yield* Effect.annotateCurrentSpan({
      "backup.artifact.id": request.artifactId,
      "backup.storage.action": request.action,
    })
    const answers = yield* Effect.tryPromise({
      try: () =>
        ask(request, STORAGE_ACCESS_TIMEOUT_MS, (client) =>
          hearth === null ? client.role === "full_access" : client.id === hearth
        ),
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

/**
 * Whether a failure is only that Hearth couldn't be asked: nothing was
 * refused, so what was to be sent can wait for it.
 */
export function isHearthUnreachable(cause: unknown): boolean {
  return cause instanceof RelayBackupError && cause.code === "hearth_unreachable"
}

function hearthUnreachable(
  request: BackupStorageAccessRequest,
  cause?: unknown
) {
  return RelayBackupError.make({
    code: "hearth_unreachable",
    operation: `${request.action}.access`,
    reason:
      "Hearth couldn't be reached for access to the backup's storage, which only it holds the keys to",
    ...(cause === undefined ? {} : { cause }),
  })
}
