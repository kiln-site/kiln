import { Effect } from "effect"

import {
  backupRepositoryAccessResponseSchema,
  backupStorageAccessResponseSchema,
  backupTaskOfferResponseSchema,
  type BackupRepositoryAccessGrant,
  type BackupRepositoryAccessRequest,
  type BackupRepositoryListing,
  type BackupStorageAccessGrant,
  type BackupStorageAccessRequest,
  type RelayBackupTask,
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
      try: () => ask(request, STORAGE_ACCESS_TIMEOUT_MS, answersFor(hearth)),
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

// The clients that answer for a task: the Hearth it came from, or, for one
// stored before that was kept, any Hearth with full access to the Relay.
const answersFor =
  (hearth: string | null) =>
  (client: { readonly id: string; readonly role: string }) =>
    hearth === null ? client.role === "full_access" : client.id === hearth

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

/**
 * Offers the Hearth a schedule came from a backup the Relay took for it,
 * as the Relay has the task. Hearth catalogs it and says whether it will
 * open the bucket for it (`admitted`) or won't, and why. No answer is
 * Hearth being away: it is offered again.
 */
export function backupTaskOfferThrough(
  offer: (
    payload: RelayBackupTask,
    timeoutMs: number,
    only: (client: { readonly id: string; readonly role: string }) => boolean
  ) => Promise<ReadonlyArray<{ readonly payload: unknown }>>
) {
  return Effect.fn("Backups.offer")(function* (
    task: RelayBackupTask,
    hearth: string | null
  ) {
    yield* Effect.annotateCurrentSpan({
      "backup.id": task.backupId,
      "backup.task.id": task.taskId,
    })
    const unreachable = (cause?: unknown) =>
      RelayBackupError.make({
        code: "hearth_unreachable",
        operation: "create.offer",
        reason: "Hearth couldn't be reached to offer it the backup",
        ...(cause === undefined ? {} : { cause }),
      })
    const answers = yield* Effect.tryPromise({
      try: () => offer(task, STORAGE_ACCESS_TIMEOUT_MS, answersFor(hearth)),
      catch: unreachable,
    })
    let refusal: string | null = null
    for (const answer of answers) {
      const parsed = backupTaskOfferResponseSchema.safeParse(answer.payload)
      if (!parsed.success) continue
      if (parsed.data.status === "admitted") return
      refusal ??= parsed.data.reason
    }
    if (refusal === null) return yield* unreachable()
    return yield* RelayBackupError.make({
      code: "backup_offer_refused",
      operation: "create.offer",
      reason: `Hearth won't store the backup: ${refusal}`,
    })
  })
}

export type BackupTaskOffer = ReturnType<typeof backupTaskOfferThrough>

/**
 * Asks one Hearth client for what restic needs of a repository in a
 * bucket: one signed request to read, write or remove a file of it, or a
 * page of one of its folders. Hearth finds the repository from the task
 * that asks and decides what that task may do to it.
 */
export type HearthRepositoryAccess = (
  request: BackupRepositoryAccessRequest,
  hearth: string | null
) => Effect.Effect<
  BackupRepositoryAccessGrant | BackupRepositoryListing,
  RelayBackupError
>

/**
 * As `backupStorageAccessThrough`, for a restic repository: restic makes
 * many small requests, and each is one Hearth signs. No span of its own,
 * which a backup of any size would make thousands of.
 */
export function backupRepositoryAccessThrough(
  ask: (
    payload: BackupRepositoryAccessRequest,
    timeoutMs: number,
    only: (client: { readonly id: string; readonly role: string }) => boolean
  ) => Promise<ReadonlyArray<{ readonly payload: unknown }>>
): HearthRepositoryAccess {
  return (request, hearth) =>
    Effect.gen(function* () {
      const unreachable = (cause?: unknown) =>
        RelayBackupError.make({
          code: "hearth_unreachable",
          operation: "repository.access",
          reason:
            "Hearth couldn't be reached for access to the backup repository, which only it holds the keys to",
          ...(cause === undefined ? {} : { cause }),
        })
      const answers = yield* Effect.tryPromise({
        try: () => ask(request, STORAGE_ACCESS_TIMEOUT_MS, answersFor(hearth)),
        catch: unreachable,
      })
      let refusal: string | null = null
      for (const answer of answers) {
        const parsed = backupRepositoryAccessResponseSchema.safeParse(
          answer.payload
        )
        if (!parsed.success) continue
        if (parsed.data.status !== "refused") return parsed.data
        refusal ??= parsed.data.reason
      }
      if (refusal === null) return yield* unreachable()
      return yield* RelayBackupError.make({
        code: "storage_access_refused",
        operation: "repository.access",
        reason: `Hearth refused access to the backup repository: ${refusal}`,
      })
    })
}
