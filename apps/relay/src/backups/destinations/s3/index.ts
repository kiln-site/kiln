import { createHash, createHmac } from "node:crypto"
import { createReadStream } from "node:fs"
import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"
import { Transform } from "node:stream"

import { Effect } from "effect"

import {
  resticRepositoryPrefixSchema,
  resticS3BucketSchema,
  resticS3RegionSchema,
  type BackupS3CredentialUploadDestination,
  type ResticRepositoryLocation,
} from "@workspace/contracts"

import { RelayBackupError } from "../../../effect/errors.js"
import {
  isPublicRemoteAddress,
  secureRemoteLookup,
} from "../../../source-policy.js"
import { backupArchivePath } from "../local/index.js"
import {
  defineBackupDestination,
  type ResticS3DriverLocation,
} from "../types.js"

const MAX_S3_SINGLE_PUT_BYTES = 5 * 1024 ** 3
const BACKUP_TRANSFER_IDLE_TIMEOUT_MS = 30_000

export function s3ResticDriverLocation(
  location: Extract<ResticRepositoryLocation, { kind: "s3" }>
): ResticS3DriverLocation {
  if (!location.accessKeyId || !location.secretAccessKey) {
    throw RelayBackupError.make({
      code: "repository_credentials_missing",
      operation: "restic.repository",
      reason: "The restic S3 repository credentials were not provided to Relay",
    })
  }
  const parsedBucket = resticS3BucketSchema.safeParse(location.bucket)
  if (!parsedBucket.success) {
    throw RelayBackupError.make({
      code: "invalid_restic_repository",
      operation: "restic.repository",
      reason:
        parsedBucket.error.issues[0]?.message ??
        "The restic S3 bucket name is invalid",
    })
  }
  const parsedRegion = resticS3RegionSchema.safeParse(location.region)
  if (!parsedRegion.success) {
    throw RelayBackupError.make({
      code: "invalid_restic_repository",
      operation: "restic.repository",
      reason:
        parsedRegion.error.issues[0]?.message ??
        "The restic S3 region is invalid",
    })
  }
  const parsedPrefix = resticRepositoryPrefixSchema.safeParse(
    location.repositoryPrefix
  )
  if (!parsedPrefix.success) {
    throw RelayBackupError.make({
      code: "invalid_restic_repository",
      operation: "restic.repository",
      reason:
        parsedPrefix.error.issues[0]?.message ??
        "The restic S3 repository prefix is invalid",
    })
  }
  return {
    accessKeyId: location.accessKeyId,
    allowPrivateNetwork: location.allowPrivateNetwork,
    bucket: location.bucket,
    endpoint: location.endpoint,
    forcePathStyle: location.forcePathStyle,
    kind: "s3",
    region: location.region,
    repositoryPrefix: location.repositoryPrefix,
    secretAccessKey: location.secretAccessKey,
  }
}

export function s3ResticRepositoryString(
  location: ResticS3DriverLocation
): string {
  return `s3:${new URL(location.endpoint).origin}/${location.bucket}/${location.repositoryPrefix}`
}

export function s3ResticGlobalArgs(
  location: ResticS3DriverLocation
): Array<string> {
  const args = ["-o", `s3.region=${location.region}`]
  if (location.forcePathStyle) args.push("-o", "s3.bucket-lookup=path")
  return args
}

export function applyS3ResticEnvironment(
  env: NodeJS.ProcessEnv,
  location: ResticS3DriverLocation,
  options: { cacheDirectory?: string; proxyUrl?: string }
): void {
  env.AWS_ACCESS_KEY_ID = location.accessKeyId
  env.AWS_SECRET_ACCESS_KEY = location.secretAccessKey
  if (options.cacheDirectory) env.RESTIC_CACHE_DIR = options.cacheDirectory
  if (options.proxyUrl) env.HTTPS_PROXY = options.proxyUrl
}

export function resticS3EndpointPort(endpoint: string): number {
  const parsed = new URL(endpoint)
  return parsed.port ? Number(parsed.port) : 443
}

export const s3BackupDestination = defineBackupDestination({
  deleteFullBackup: ({ destination }) =>
    Effect.tryPromise({
      try: () =>
        sendSignedBackupRequest({
          allowPrivateNetwork: destination.allowPrivateNetwork,
          headers: destination.headers,
          method: "DELETE",
          url: destination.deleteUrl,
        }),
      catch: (cause) =>
        RelayBackupError.make({
          code: "s3_delete_failed",
          operation: "delete.remote",
          reason: "The backup archive could not be deleted from S3 storage",
          cause,
        }),
    }).pipe(Effect.as({ warnings: [] })),
  kind: "s3",
  maximumFullBackupBytes: MAX_S3_SINGLE_PUT_BYTES,
  retainsFullBackupLocally: false,
  saveFullBackup: ({
    backupId,
    config,
    destination,
    onChunk,
    result,
    signal,
  }) => {
    if (result.bytes > MAX_S3_SINGLE_PUT_BYTES) {
      return RelayBackupError.make({
        code: "s3_single_put_too_large",
        operation: "create.upload",
        reason:
          "S3 backups cannot exceed 5 GiB until multipart upload support is enabled",
      })
    }
    const request =
      "uploadUrl" in destination
        ? {
            headers: destination.headers,
            url: destination.uploadUrl,
          }
        : signS3CredentialUpload(destination, result.checksumSha256)
    return Effect.tryPromise({
      try: () =>
        sendSignedBackupRequest({
          allowPrivateNetwork: destination.allowPrivateNetwork,
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
          reason: "The backup archive could not be uploaded to S3 storage",
          cause,
        }),
    }).pipe(Effect.as(result))
  },
})

export function signS3CredentialUpload(
  destination: BackupS3CredentialUploadDestination,
  payloadSha256: string,
  now = new Date()
): { headers: Record<string, string>; url: string } {
  if (!destination.accessKeyId || !destination.secretAccessKey) {
    throw RelayBackupError.make({
      code: "s3_credentials_missing",
      operation: "create.upload",
      reason: "The scheduled S3 credentials were not provided to Relay",
    })
  }
  const url = s3ObjectUrl(destination)
  const amzDate = now
    .toISOString()
    .replaceAll(/[:-]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z")
  const date = amzDate.slice(0, 8)
  const headers = {
    "content-type": "application/zip",
    host: url.host,
    "x-amz-content-sha256": payloadSha256,
    "x-amz-date": amzDate,
  }
  const signedHeaders = Object.keys(headers).join(";")
  const canonicalHeaders = Object.entries(headers)
    .map(([key, value]) => `${key}:${value}\n`)
    .join("")
  const canonicalRequest = [
    "PUT",
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadSha256,
  ].join("\n")
  const scope = `${date}/${destination.region}/s3/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n")
  const dateKey = hmac(`AWS4${destination.secretAccessKey}`, date)
  const regionKey = hmac(dateKey, destination.region)
  const serviceKey = hmac(regionKey, "s3")
  const signingKey = hmac(serviceKey, "aws4_request")
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex")
  return {
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${destination.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "content-type": headers["content-type"],
      "x-amz-content-sha256": headers["x-amz-content-sha256"],
      "x-amz-date": headers["x-amz-date"],
    },
    url: url.toString(),
  }
}

function s3ObjectUrl(destination: BackupS3CredentialUploadDestination): URL {
  const url = new URL(destination.endpoint)
  const virtualHosted =
    !destination.forcePathStyle &&
    isIP(url.hostname.replace(/^\[|\]$/gu, "")) === 0 &&
    /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u.test(destination.bucket)
  const objectPath = destination.objectKey
    .split("/")
    .map(encodeS3PathSegment)
    .join("/")
  if (virtualHosted) {
    url.hostname = `${destination.bucket}.${url.hostname}`
    url.pathname = `/${objectPath}`
  } else {
    url.pathname = `/${encodeS3PathSegment(destination.bucket)}/${objectPath}`
  }
  return url
}

function encodeS3PathSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest()
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
        let responseBytes = 0
        response.on("data", (chunk: Buffer) => {
          responseBytes += chunk.byteLength
          if (responseBytes > 64 * 1024) {
            response.destroy(new Error("S3 storage response was too large"))
          }
        })
        response.once("aborted", () => {
          rejectRequest(new Error("S3 storage closed the response early"))
        })
        response.once("end", () => {
          const status = response.statusCode ?? 0
          if (status >= 200 && status < 300) resolveRequest()
          else rejectRequest(new Error(`S3 storage returned HTTP ${status}`))
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
