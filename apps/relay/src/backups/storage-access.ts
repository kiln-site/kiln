import { Effect } from "effect"

import {
  backupCopySettledResponseSchema,
  backupStorageAccessResponseSchema,
  type BackupCopySettledRequest,
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
 * Asks one Hearth client for access to a backup's copy in a bucket: the
 * one its task came from, or null for one stored before that was kept.
 */
export type HearthStorageAccess = (
  request: BackupStorageAccessRequest,
  hearth: string | null
) => ReturnType<BackupStorageAccess>

/** Whether Hearth said not yet, which asking again later may change. */
export function isAccessDeferred(cause: unknown): boolean {
  return (
    cause instanceof RelayBackupError &&
    cause.code === "storage_access_deferred"
  )
}

/** Whether nothing came of asking only because Hearth couldn't be asked. */
export function isHearthUnreachable(cause: unknown): boolean {
  return cause instanceof RelayBackupError && cause.code === "hearth_unreachable"
}

// The Hearth clients that may answer for a copy: the one it is for, or,
// for one that names none, any with full access to the Relay.
const answersFor =
  (hearth: string | null) =>
  (client: { readonly id: string; readonly role: string }) =>
    hearth === null ? client.role === "full_access" : client.id === hearth

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
        ask(request, STORAGE_ACCESS_TIMEOUT_MS, answersFor(hearth)),
      catch: (cause) => hearthUnreachable(request, cause),
    })
    let refusal: string | null = null
    let later: string | null = null
    for (const answer of answers) {
      const parsed = backupStorageAccessResponseSchema.safeParse(answer.payload)
      if (!parsed.success) continue
      if (parsed.data.status === "granted") return parsed.data
      if (parsed.data.status === "later") later ??= parsed.data.reason
      else refusal ??= parsed.data.reason
    }
    // Not yet, from a Hearth that may say otherwise later, outweighs
    // another's no: the copy is kept and asked for again.
    if (later !== null) {
      return yield* RelayBackupError.make({
        code: "storage_access_deferred",
        operation: `${request.action}.access`,
        reason: `Hearth won't open the backup's storage yet: ${later}`,
      })
    }
    if (refusal === null) return yield* hearthUnreachable(request)
    return yield* RelayBackupError.make({
      code: "storage_access_refused",
      operation: `${request.action}.access`,
      reason: `Hearth refused access to the backup's storage: ${refusal}`,
    })
  })
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
 * Tells the Hearth a copy is for how sending it to its bucket ended, and
 * answers whether Hearth has it (`recorded`) or knows no such copy of this
 * Relay's (`unknown`). No answer is Hearth being away: it is told again.
 */
export function backupCopySettledThrough(
  tell: (
    payload: BackupCopySettledRequest,
    timeoutMs: number,
    only: (client: { readonly id: string; readonly role: string }) => boolean
  ) => Promise<ReadonlyArray<{ readonly payload: unknown }>>
) {
  return Effect.fn("Backups.copySettled")(function* (
    report: BackupCopySettledRequest,
    hearth: string | null
  ) {
    yield* Effect.annotateCurrentSpan({
      "backup.artifact.id": report.artifactId,
      "backup.copy.status": report.status,
    })
    const unreachable = (cause?: unknown) =>
      RelayBackupError.make({
        code: "hearth_unreachable",
        operation: "copy.settled",
        reason: "Hearth couldn't be told how sending the backup's copy went",
        ...(cause === undefined ? {} : { cause }),
      })
    const answers = yield* Effect.tryPromise({
      try: () => tell(report, STORAGE_ACCESS_TIMEOUT_MS, answersFor(hearth)),
      catch: unreachable,
    })
    let unknown = false
    for (const answer of answers) {
      const parsed = backupCopySettledResponseSchema.safeParse(answer.payload)
      if (!parsed.success) continue
      if (parsed.data.status === "recorded") return "recorded" as const
      unknown = true
    }
    return unknown ? ("unknown" as const) : yield* unreachable()
  })
}

export type BackupCopySettled = ReturnType<typeof backupCopySettledThrough>
