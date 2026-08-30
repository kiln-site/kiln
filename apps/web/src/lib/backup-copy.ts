import { request as httpRequest } from "node:http"
import type { IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import type { Readable } from "node:stream"

import { Cause, Effect } from "effect"

import {
  claimBackupCopyTaskEffect,
  completeBackupCopyTaskEffect,
  listRunnableBackupCopyTaskIdsEffect,
  type ClaimedBackupCopyTask,
} from "@/effect/backups"
import { loadBackupStorageCredentialEffect } from "@/backups/destinations/s3"
import { BackupStorageError } from "@/effect/errors"
import { forkAppEffect } from "@/effect/runtime"
import { signLocalBackupDownload } from "@/backups/destinations/local"
import {
  putS3BackupObject,
  withS3BackupObject,
} from "@/backups/destinations/s3"
import { relayControlEndpoint } from "@/lib/relay-control-endpoint"
import { publishBackupChange } from "@/lib/backup-realtime.server"
import {
  listPersistedRelays,
  loadRelayCredentials,
  type PersistedRelay,
} from "@/lib/relay-registry"

let copyWorkerRunning = false
let copyWorkerRequested = false
const BACKUP_COPY_IDLE_TIMEOUT_MS = 60_000

export function scheduleBackupCopyProcessing(): void {
  copyWorkerRequested = true
  if (copyWorkerRunning) return
  copyWorkerRunning = true
  forkAppEffect(
    "backups.copy.worker",
    drainBackupCopyTasksEffect().pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Backup copy worker failed", { cause })
      ),
      Effect.ensuring(
        Effect.sync(() => {
          copyWorkerRunning = false
          if (copyWorkerRequested) queueMicrotask(scheduleBackupCopyProcessing)
        })
      )
    )
  )
}

const drainBackupCopyTasksEffect = Effect.fn("backups.drainCopies")(
  function* () {
    while (copyWorkerRequested) {
      copyWorkerRequested = false
      const taskIds = yield* listRunnableBackupCopyTaskIdsEffect()
      yield* Effect.forEach(taskIds, processBackupCopyTaskEffect, {
        concurrency: 1,
        discard: true,
      })
    }
  }
)

const processBackupCopyTaskEffect = Effect.fn("backups.processCopy")(function* (
  taskId: string
) {
  const task = yield* claimBackupCopyTaskEffect(taskId)
  if (!task) return
  yield* Effect.annotateCurrentSpan({
    backupId: task.backupId,
    destinationStorageId: task.destinationStorageId,
    taskId,
  })
  yield* transferBackupCopyEffect(task).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => {
        const error = backupCopyFailureMessage(cause)
        return completeBackupCopyTaskEffect({
          artifactId: task.destinationArtifactId,
          backupId: task.backupId,
          bytes: null,
          checksumSha256: null,
          error,
          filename: task.filename,
          ok: false,
          taskId: task.taskId,
        }).pipe(
          Effect.tap(() =>
            Effect.logError("Backup copy failed", {
              backupId: task.backupId,
              cause,
              taskId: task.taskId,
            })
          )
        )
      },
      onSuccess: () =>
        completeBackupCopyTaskEffect({
          artifactId: task.destinationArtifactId,
          backupId: task.backupId,
          bytes: task.bytes,
          checksumSha256: task.checksumSha256,
          error: null,
          filename: task.filename,
          ok: true,
          taskId: task.taskId,
        }),
    }),
    Effect.ensuring(
      Effect.sync(() => publishBackupChange(task.relayId, task.backupId))
    )
  )
})

const transferBackupCopyEffect = Effect.fn("backups.transferCopy")(function* (
  task: ClaimedBackupCopyTask
) {
  const destination = yield* loadBackupStorageCredentialEffect(
    task.destinationStorageId
  )
  if (!destination) {
    return yield* copyFailure("Backup destination is unavailable")
  }
  if (task.sourceStorageId !== null) {
    if (!task.sourceObjectKey) {
      return yield* copyFailure("Backup object key is unavailable")
    }
    const source = yield* loadBackupStorageCredentialEffect(
      task.sourceStorageId
    )
    if (!source) {
      return yield* copyFailure("Backup source destination is unavailable")
    }
    return yield* withS3BackupObject(
      source,
      task.sourceObjectKey,
      ({ body, contentLength }) =>
        uploadBackupCopyEffect(
          task,
          destination,
          body,
          contentLength ?? task.bytes ?? undefined
        )
    )
  }
  const source = yield* localBackupCopySourceEffect(task)
  yield* uploadBackupCopyEffect(
    task,
    destination,
    source.body,
    source.contentLength
  ).pipe(Effect.ensuring(Effect.sync(() => source.body.destroy())))
})

const localBackupCopySourceEffect = Effect.fn("backups.localCopySource")(
  function* (task: ClaimedBackupCopyTask) {
    if (task.sourceObjectKey) {
      return yield* copyFailure("Local backup metadata is invalid")
    }
    const relays = yield* Effect.tryPromise({
      try: listPersistedRelays,
      catch: (cause) =>
        BackupStorageError.make({
          code: "copy_relay_lookup_failed",
          operation: "backup.copy.relay",
          reason: "The backup Relay is unavailable",
          cause,
        }),
    })
    const relay = relays.find(
      (candidate) => candidate.enabled && candidate.id === task.relayId
    )
    if (!relay) return yield* copyFailure("The backup Relay is unavailable")
    const signed = yield* Effect.tryPromise({
      try: () =>
        signLocalBackupDownload(
          relay,
          { id: task.backupId },
          task.filename,
          task.requestedBy,
          300
        ),
      catch: (cause) =>
        BackupStorageError.make({
          code: "copy_download_sign_failed",
          operation: "backup.copy.signLocal",
          reason: "The local backup could not be prepared for copying",
          cause,
        }),
    })
    const signedUrl = new URL(signed.url)
    if (signedUrl.origin !== new URL(relay.browserOrigin).origin) {
      return yield* copyFailure("The local backup download URL is invalid")
    }
    const credentials = yield* Effect.tryPromise({
      try: () => loadRelayCredentials(relay.id),
      catch: (cause) =>
        BackupStorageError.make({
          code: "copy_download_failed",
          operation: "backup.copy.download",
          reason: "The backup Relay credentials are unavailable",
          cause,
        }),
    })
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        requestRelayBackup(
          relay,
          credentials.caCertificatePem,
          signedUrl,
          signal
        ),
      catch: (cause) =>
        BackupStorageError.make({
          code: "copy_download_failed",
          operation: "backup.copy.download",
          reason: "The backup file could not be read for copying",
          cause,
        }),
    })
    const statusCode = response.statusCode ?? 0
    if (statusCode < 200 || statusCode >= 300) {
      response.destroy()
      return yield* copyFailure("The backup file could not be read for copying")
    }
    const contentLength = Number(response.headers["content-length"])
    return {
      body: response,
      contentLength:
        Number.isFinite(contentLength) && contentLength > 0
          ? contentLength
          : (task.bytes ?? undefined),
    }
  }
)

function requestRelayBackup(
  relay: PersistedRelay,
  caCertificatePem: string | null,
  signedUrl: URL,
  signal: AbortSignal
): Promise<IncomingMessage> {
  const endpoint = relayControlEndpoint(relay)
  const protocol = endpoint.useTls ? "https" : "http"
  const url = new URL(
    signedUrl.pathname + signedUrl.search,
    `${protocol}://${formatHost(endpoint.hostname)}:${endpoint.port}`
  )
  const request = endpoint.useTls ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        ca: endpoint.useTls ? (caCertificatePem ?? undefined) : undefined,
        method: "GET",
        rejectUnauthorized: endpoint.useTls,
        signal,
      },
      resolve
    )
    outgoing.once("error", reject)
    outgoing.setTimeout(BACKUP_COPY_IDLE_TIMEOUT_MS, () => {
      outgoing.destroy(new Error("The backup copy stopped making progress"))
    })
    outgoing.end()
  })
}

function formatHost(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname
}

function uploadBackupCopyEffect(
  task: ClaimedBackupCopyTask,
  destination: Parameters<typeof putS3BackupObject>[0],
  body: Readable,
  contentLength: number | undefined
) {
  return putS3BackupObject(destination, {
    body,
    ...(contentLength === undefined ? {} : { contentLength }),
    objectKey: task.destinationObjectKey,
  })
}

function copyFailure(reason: string) {
  return BackupStorageError.make({
    code: "copy_failed",
    operation: "backup.copy",
    reason,
  })
}

function backupCopyFailureMessage(cause: Cause.Cause<unknown>): string {
  const failure = Cause.squash(cause)
  return failure instanceof Error
    ? failure.message
    : "The backup could not be copied to that destination"
}
