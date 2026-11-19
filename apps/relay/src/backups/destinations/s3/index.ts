import { createReadStream } from "node:fs"
import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"
import { Transform } from "node:stream"

import { Effect } from "effect"

import type {
  BackupS3CopyDestination,
  BackupStorageAccessAction,
  ResticRepositoryLocation,
} from "@workspace/contracts"

import { RelayBackupError } from "../../../effect/errors.js"
import {
  isPublicRemoteAddress,
  secureRemoteLookup,
} from "../../../source-policy.js"
import type { ResticRepositoryAccess } from "../../restic-bridge.js"
import type { BackupStorageAccess } from "../../storage-access.js"
import { backupArchivePath } from "../local/index.js"
import {
  defineBackupDestination,
  type ResticS3DriverLocation,
} from "../types.js"

const MAX_S3_SINGLE_PUT_BYTES = 5 * 1024 ** 3
const BACKUP_TRANSFER_IDLE_TIMEOUT_MS = 30_000
const MAX_S3_RESPONSE_BYTES = 64 * 1024
const MAX_S3_ERROR_FIELD_LENGTH = 512

export function s3ResticDriverLocation(
  location: Extract<ResticRepositoryLocation, { kind: "s3" }>,
  access: ResticRepositoryAccess
): ResticS3DriverLocation {
  return { access, kind: "s3", repositoryId: location.repositoryId ?? null }
}

export function applyS3ResticEnvironment(
  env: NodeJS.ProcessEnv,
  options: { cacheDirectory?: string }
): void {
  // What restic keeps of a repository's metadata, so it asks the bucket,
  // and so Hearth, for less each run.
  if (options.cacheDirectory) env.RESTIC_CACHE_DIR = options.cacheDirectory
}

// One signed request for a copy the Relay holds no keys to, from Hearth.
function storageAccess(
  access: BackupStorageAccess,
  action: BackupStorageAccessAction,
  destination: BackupS3CopyDestination
) {
  if (!destination.artifactId) {
    return RelayBackupError.make({
      code: "backup_copy_unnamed",
      operation: `${action}.access`,
      reason: "The task doesn't say which stored copy of the backup it means",
    })
  }
  return access({ action, artifactId: destination.artifactId })
}

export const s3BackupDestination = defineBackupDestination({
  deleteFullBackup: ({ access, destination }) =>
    Effect.gen(function* () {
      const grant = yield* storageAccess(access, "delete", destination)
      yield* Effect.tryPromise({
        try: () =>
          sendSignedBackupRequest({
            allowPrivateNetwork: grant.allowPrivateNetwork,
            headers: grant.headers,
            method: "DELETE",
            url: grant.url,
          }),
        catch: (cause) =>
          RelayBackupError.make({
            code: "s3_delete_failed",
            operation: "delete.remote",
            reason: `The backup archive could not be deleted from S3 storage: ${errorMessage(cause)}`,
            cause,
          }),
      })
      return { warnings: [] }
    }),
  kind: "s3",
  maximumFullBackupBytes: MAX_S3_SINGLE_PUT_BYTES,
  retainsFullBackupLocally: false,
  saveFullBackup: ({
    access,
    backupId,
    config,
    destination,
    onChunk,
    result,
    signal,
  }) =>
    Effect.gen(function* () {
      if (result.bytes > MAX_S3_SINGLE_PUT_BYTES) {
        return yield* RelayBackupError.make({
          code: "s3_single_put_too_large",
          operation: "create.upload",
          reason:
            "S3 backups cannot exceed 5 GiB until multipart upload support is enabled",
        })
      }
      // Asked for only now, with the archive ready: what Hearth signs is
      // good for minutes.
      const request = yield* storageAccess(access, "upload", destination)
      yield* Effect.tryPromise({
        try: () =>
          sendSignedBackupRequest({
            allowPrivateNetwork: request.allowPrivateNetwork,
            bodyPath: backupArchivePath(config, backupId),
            headers: {
              ...request.headers,
              "content-length": String(result.bytes),
            },
            method: "PUT",
            onBodyChunk: onChunk,
            signal,
            url: request.url,
          }),
        catch: (cause) =>
          RelayBackupError.make({
            code: "s3_upload_failed",
            operation: "create.upload",
            reason: `The backup archive could not be uploaded to S3 storage: ${errorMessage(cause)}`,
            cause,
          }),
      })
      return result
    }),
})

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function s3ErrorDetail(body: string): string | null {
  const field = (name: string) =>
    new RegExp(`<${name}>([^<]{1,${MAX_S3_ERROR_FIELD_LENGTH}})</${name}>`, "u")
      .exec(body)?.[1]
      ?.replaceAll(/[\p{Cc}]+/gu, " ")
      .trim() || null
  const code = field("Code")
  const message = field("Message")
  if (code && message) return `${code}: ${message}`
  return code ?? message
}

function sendSignedBackupRequest(input: {
  allowPrivateNetwork: boolean
  bodyPath?: string
  headers: Readonly<Record<string, string>>
  method: "DELETE" | "PUT"
  onBodyChunk?: (bytes: number) => void
  signal?: AbortSignal
  url: string
}): Promise<void> {
  const url = new URL(input.url)
  if (url.protocol !== "https:" || url.username || url.password) {
    return Promise.reject(new Error("Signed backup URLs must use HTTPS"))
  }
  const literal = url.hostname.replace(/^\[|\]$/gu, "")
  if (
    !input.allowPrivateNetwork &&
    isIP(literal) !== 0 &&
    !isPublicRemoteAddress(literal)
  ) {
    return Promise.reject(
      new Error("Signed backup URL resolves to a private or reserved address")
    )
  }
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest(
      url,
      {
        headers: input.headers,
        lookup: input.allowPrivateNetwork ? undefined : secureRemoteLookup,
        method: input.method,
        signal: input.signal,
      },
      (response) => {
        const chunks: Array<Buffer> = []
        let responseBytes = 0
        response.on("data", (chunk: Buffer) => {
          responseBytes += chunk.byteLength
          if (responseBytes > MAX_S3_RESPONSE_BYTES) {
            response.destroy(new Error("S3 storage response was too large"))
            return
          }
          chunks.push(chunk)
        })
        response.once("aborted", () => {
          rejectRequest(new Error("S3 storage closed the response early"))
        })
        response.once("end", () => {
          const status = response.statusCode ?? 0
          if (status >= 200 && status < 300) {
            resolveRequest()
            return
          }
          const detail = s3ErrorDetail(Buffer.concat(chunks).toString("utf8"))
          rejectRequest(
            new Error(
              `S3 storage returned HTTP ${status}${detail ? `: ${detail}` : ""}`
            )
          )
        })
        response.once("error", rejectRequest)
      }
    )
    request.setTimeout(BACKUP_TRANSFER_IDLE_TIMEOUT_MS, () => {
      request.destroy(new Error("S3 backup request timed out"))
    })
    request.once("error", rejectRequest)
    if (input.bodyPath) {
      const body = createReadStream(input.bodyPath, { signal: input.signal })
      body.once("error", (cause) => request.destroy(cause))
      const onBodyChunk = input.onBodyChunk
      if (!onBodyChunk) {
        body.pipe(request)
        return
      }
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          onBodyChunk(chunk.byteLength)
          callback(null, chunk)
        },
      })
      meter.once("error", (cause) => request.destroy(cause))
      body.pipe(meter).pipe(request)
    } else {
      request.end()
    }
  })
}
