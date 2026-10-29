import { createHash, randomUUID } from "node:crypto"
import { lookup } from "node:dns"
import { Agent } from "node:https"
import { BlockList, isIP } from "node:net"
import type { LookupFunction } from "node:net"
import { Readable } from "node:stream"

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { NodeHttpHandler } from "@smithy/node-http-handler"
import { Effect, Result, Schedule } from "effect"

import {
  backupArtifactFilename,
  type BackupArtifactKind,
  type BackupTargetKind,
} from "@workspace/contracts"

import { BackupStorageError } from "@/effect/errors"

const CONNECTION_TEST_PREFIX = "kiln/connection-tests"
const PRESIGNED_UPLOAD_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_S3_REQUEST_TIMEOUT_MS = 30_000
const BACKUP_TRANSFER_IDLE_TIMEOUT_MS = 60_000
const S3_DELETE_PAGE_SIZE = 1_000
const RESTIC_PREFIX_SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u
const RESTIC_PREFIX_SAFE_PATH = /^[A-Za-z0-9._/-]*$/u
export const RESTIC_OBJECT_PREFIX_LENGTH_ERROR =
  "The object prefix must be 512 bytes or fewer"
export const RESTIC_OBJECT_PREFIX_ERROR =
  "The object prefix can contain only letters, numbers, periods, underscores, slashes, and hyphens, and cannot contain '.' or '..' path segments"
const BLOCKED_ADDRESSES = new BlockList()
const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]
const BLOCKED_IPV6: ReadonlyArray<readonly [string, number]> = [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
]

for (const [network, prefix] of BLOCKED_IPV4) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv4")
}
for (const [network, prefix] of BLOCKED_IPV6) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv6")
}

export interface S3BackupCredential {
  accessKeyId: string
  allowPrivateNetwork: boolean
  bucket: string
  endpoint: string
  forcePathStyle: boolean
  objectPrefix: string
  region: string
  secretAccessKey: string
}

export function normalizeS3Endpoint(value: string): string {
  const parsed = Result.try(() => new URL(value.trim()))
  if (Result.isFailure(parsed)) {
    throw backupStorageError(
      "invalid_endpoint",
      "storage.validate",
      "The S3 endpoint must be an absolute HTTPS URL",
      parsed.failure
    )
  }
  const endpoint = parsed.success
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "")
  ) {
    throw backupStorageError(
      "invalid_endpoint",
      "storage.validate",
      "The S3 endpoint must be an HTTPS origin without credentials, a path, query, or fragment"
    )
  }
  return endpoint.origin
}

export function normalizeObjectPrefix(value: string): string {
  const normalized = value
    .trim()
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\/{2,}/gu, "/")
  if (!normalized) return ""
  if (Buffer.byteLength(normalized) > 512) {
    throw backupStorageError(
      "invalid_prefix",
      "storage.validate",
      RESTIC_OBJECT_PREFIX_LENGTH_ERROR
    )
  }
  if (!isSafeResticObjectPrefix(normalized)) {
    throw backupStorageError(
      "invalid_prefix",
      "storage.validate",
      RESTIC_OBJECT_PREFIX_ERROR
    )
  }
  return normalized
}

export function backupObjectKey(input: {
  artifactKind: BackupArtifactKind
  backupId: string
  installationId: string
  objectPrefix: string
  relayId: string
  targetId: string
  targetKind: BackupTargetKind
}): string {
  return [
    backupObjectKeyPrefix(input),
    objectKeySegment(input.backupId),
    backupArtifactFilename(input.backupId, input.artifactKind),
  ].join("/")
}

export function backupObjectKeyPrefix(input: {
  installationId: string
  objectPrefix: string
  relayId: string
  targetId: string
  targetKind: BackupTargetKind
}): string {
  return [
    input.objectPrefix,
    "kiln",
    objectKeySegment(input.installationId),
    objectKeySegment(input.relayId),
    input.targetKind,
    objectKeySegment(input.targetId),
  ]
    .filter(Boolean)
    .join("/")
}

export function isSafeResticObjectPrefix(value: string): boolean {
  return (
    RESTIC_PREFIX_SAFE_PATH.test(value) &&
    !value.startsWith("/") &&
    !value.split("/").some((segment) => segment === "." || segment === "..")
  )
}

export function resticPrefixSegment(value: string): string {
  if (
    RESTIC_PREFIX_SAFE_SEGMENT.test(value) &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith("sha256-")
  ) {
    return value
  }
  return `sha256-${createHash("sha256").update(value).digest("hex")}`
}

export function resticRepositoryObjectPrefix(input: {
  installationId: string
  objectPrefix: string
  relayId: string
  repositoryId: string
  targetId: string
}): string {
  return [
    input.objectPrefix,
    "kiln",
    resticPrefixSegment(input.installationId),
    resticPrefixSegment(input.relayId),
    "restic",
    "instance",
    resticPrefixSegment(input.targetId),
    resticPrefixSegment(input.repositoryId),
  ]
    .filter(Boolean)
    .join("/")
}

export function deleteS3BackupPrefix(
  credential: S3BackupCredential,
  prefix: string
) {
  if (!prefix) {
    return Effect.fail(
      backupStorageError(
        "invalid_prefix",
        "storage.deletePrefix",
        "Refusing to delete an empty S3 prefix"
      )
    )
  }
  return withS3Client(credential, (client) =>
    deleteS3PrefixPages(client, credential.bucket, prefix).pipe(
      Effect.retry({
        schedule: Schedule.exponential("200 millis").pipe(Schedule.jittered),
        times: 2,
        while: isRetryableS3Failure,
      })
    )
  )
}

export async function deleteS3PrefixObjectPages(
  listPage: (token?: string) => Promise<{
    keys: Array<string>
    nextToken?: string
  }>,
  deleteKeys: (keys: ReadonlyArray<string>) => Promise<void>
): Promise<void> {
  while (true) {
    let deleted = 0
    let token: string | undefined
    do {
      const page = await listPage(token)
      if (page.keys.length > 0) {
        await deleteKeys(page.keys)
        deleted += page.keys.length
      }
      token = page.nextToken
    } while (token)
    if (deleted === 0) return
  }
}

export function failIfS3DeleteObjectsErrored(result: {
  Errors?: ReadonlyArray<{
    Code?: string
    Key?: string
    Message?: string
  }>
}): void {
  const errors = result.Errors ?? []
  if (errors.length === 0) return
  const sample = errors[0]
  const detail = [sample?.Key, sample?.Code, sample?.Message]
    .filter(Boolean)
    .join(": ")
  throw backupStorageError(
    "s3_request_failed",
    "storage.deletePrefix",
    errors.length === 1
      ? `S3 could not delete ${detail || "an object"} under this prefix`
      : `S3 could not delete ${errors.length} objects under this prefix`,
    errors
  )
}

export function isRetryableS3Failure(error: unknown): boolean {
  if (!(error instanceof BackupStorageError)) return false
  if (error.code !== "s3_request_failed") return false
  const status = s3FailureStatus(error.cause)
  if (status === 403 || status === 404) return false
  if (status !== null && status >= 400 && status < 500) return false
  return true
}

export function verifyS3BackupCredential(credential: S3BackupCredential) {
  const objectKey = [
    credential.objectPrefix,
    CONNECTION_TEST_PREFIX,
    `${randomUUID()}.probe`,
  ]
    .filter(Boolean)
    .join("/")
  return withS3Client(credential, (client) =>
    Effect.acquireUseRelease(
      s3Request("storage.verify.put", (signal) =>
        client.send(
          new PutObjectCommand({
            Body: new Uint8Array(),
            Bucket: credential.bucket,
            ContentType: "application/octet-stream",
            Key: objectKey,
          }),
          { abortSignal: signal }
        )
      ),
      () =>
        s3Request("storage.verify.head", (signal) =>
          client.send(
            new HeadObjectCommand({
              Bucket: credential.bucket,
              Key: objectKey,
            }),
            { abortSignal: signal }
          )
        ),
      () =>
        s3Request("storage.verify.delete", (signal) =>
          client.send(
            new DeleteObjectCommand({
              Bucket: credential.bucket,
              Key: objectKey,
            }),
            { abortSignal: signal }
          )
        ).pipe(Effect.ignore)
    ).pipe(Effect.asVoid)
  )
}

export function putS3BackupObject(
  credential: S3BackupCredential,
  input: {
    body: Readable | Uint8Array
    contentLength?: number
    contentType?: string
    objectKey: string
  }
) {
  return withS3Client(
    credential,
    (client) =>
      s3Request("storage.putObject", (signal) =>
        client.send(
          new PutObjectCommand({
            Body: input.body,
            Bucket: credential.bucket,
            ContentLength: input.contentLength,
            ContentType: input.contentType ?? "application/zip",
            Key: input.objectKey,
          }),
          { abortSignal: signal }
        )
      ).pipe(Effect.asVoid),
    BACKUP_TRANSFER_IDLE_TIMEOUT_MS
  )
}

export function withS3BackupObject<TResult, TError, TRequirements>(
  credential: S3BackupCredential,
  objectKey: string,
  use: (input: {
    body: Readable
    contentLength: number | undefined
  }) => Effect.Effect<TResult, TError, TRequirements>
) {
  return withS3Client(
    credential,
    (client) =>
      Effect.gen(function* () {
        const output = yield* s3Request("storage.getObject", (signal) =>
          client.send(
            new GetObjectCommand({
              Bucket: credential.bucket,
              Key: objectKey,
            }),
            { abortSignal: signal }
          )
        )
        if (!(output.Body instanceof Readable)) {
          return yield* Effect.fail(
            backupStorageError(
              "invalid_s3_body",
              "storage.getObject",
              "The S3-compatible storage response could not be streamed"
            )
          )
        }
        const body = output.Body
        return yield* use({
          body,
          contentLength: output.ContentLength,
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              body.destroy()
            })
          )
        )
      }),
    BACKUP_TRANSFER_IDLE_TIMEOUT_MS
  )
}

export function signS3BackupUpload(
  credential: S3BackupCredential,
  objectKey: string
) {
  return withS3Client(credential, (client) =>
    s3Request("storage.signUpload", () =>
      getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: credential.bucket,
          ContentType: "application/zip",
          Key: objectKey,
        }),
        { expiresIn: PRESIGNED_UPLOAD_SECONDS }
      )
    ).pipe(
      Effect.map((uploadUrl) => ({
        allowPrivateNetwork: credential.allowPrivateNetwork,
        headers: { "content-type": "application/zip" },
        kind: "s3" as const,
        objectKey,
        uploadUrl,
      }))
    )
  )
}

export function signS3BackupDelete(
  credential: S3BackupCredential,
  objectKey: string
) {
  return withS3Client(credential, (client) =>
    s3Request("storage.signDelete", () =>
      getSignedUrl(
        client,
        new DeleteObjectCommand({
          Bucket: credential.bucket,
          Key: objectKey,
        }),
        { expiresIn: PRESIGNED_UPLOAD_SECONDS }
      )
    ).pipe(
      Effect.map((deleteUrl) => ({
        allowPrivateNetwork: credential.allowPrivateNetwork,
        deleteUrl,
        headers: {},
        kind: "s3" as const,
        objectKey,
      }))
    )
  )
}

export function signS3BackupDownload(
  credential: S3BackupCredential,
  objectKey: string,
  filename: string,
  expiresInSeconds: number
) {
  return withS3Client(credential, (client) =>
    s3Request("storage.signDownload", () =>
      getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: credential.bucket,
          Key: objectKey,
          ResponseContentDisposition: `attachment; filename="${filename.replace(/["\\\r\n]/gu, "_")}"`,
        }),
        { expiresIn: expiresInSeconds }
      )
    ).pipe(
      Effect.map((url) => ({
        expiresAt: new Date(
          Date.now() + expiresInSeconds * 1_000
        ).toISOString(),
        url,
      }))
    )
  )
}

export function signS3BackupRestore(
  credential: S3BackupCredential,
  objectKey: string
) {
  return withS3Client(credential, (client) =>
    s3Request("storage.signRestore", () =>
      getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: credential.bucket,
          Key: objectKey,
        }),
        { expiresIn: PRESIGNED_UPLOAD_SECONDS }
      )
    ).pipe(
      Effect.map((downloadUrl) => ({
        allowPrivateNetwork: credential.allowPrivateNetwork,
        downloadUrl,
        headers: {},
        kind: "remote" as const,
      }))
    )
  )
}

function withS3Client<TResult, TError, TRequirements>(
  credential: S3BackupCredential,
  use: (client: S3Client) => Effect.Effect<TResult, TError, TRequirements>,
  requestTimeout = DEFAULT_S3_REQUEST_TIMEOUT_MS
) {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => makeS3Client(credential, requestTimeout),
      catch: (cause) =>
        backupStorageError(
          "invalid_s3_client",
          "storage.connect",
          "The S3 client could not be configured",
          cause
        ),
    }),
    use,
    (client) =>
      Effect.sync(() => {
        client.destroy()
      })
  )
}

function makeS3Client(
  credential: S3BackupCredential,
  socketTimeout: number
): S3Client {
  const endpoint = normalizeS3Endpoint(credential.endpoint)
  const endpointHost = new URL(endpoint).hostname.replace(/^\[|\]$/gu, "")
  if (
    !credential.allowPrivateNetwork &&
    isIP(endpointHost) !== 0 &&
    !isPublicS3Address(endpointHost)
  ) {
    throw backupStorageError(
      "blocked_endpoint",
      "storage.connect",
      "The S3 endpoint resolves to a private or reserved network address"
    )
  }
  const requestHandler = new NodeHttpHandler({
    connectionTimeout: 10_000,
    ...(credential.allowPrivateNetwork
      ? {}
      : { httpsAgent: new Agent({ lookup: publicS3Lookup }) }),
    socketTimeout,
  })
  return new S3Client({
    credentials: {
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
    },
    endpoint,
    forcePathStyle: credential.forcePathStyle,
    region: credential.region,
    requestHandler,
  })
}

function objectKeySegment(value: string): string {
  const encoded = encodeURIComponent(value)
  if (encoded.length <= 180) return encoded
  return `sha256-${createHash("sha256").update(value).digest("hex")}`
}

const publicS3Lookup: LookupFunction = (hostname, options, callback) => {
  lookup(
    hostname,
    {
      all: true,
      family: options.family,
      hints: options.hints,
      order: options.order ?? "verbatim",
    },
    (cause, addresses) => {
      if (cause) {
        callback(cause, "")
        return
      }
      const blocked = addresses.find(
        ({ address }) => !isPublicS3Address(address)
      )
      if (blocked) {
        callback(
          backupStorageError(
            "blocked_endpoint",
            "storage.connect",
            "The S3 endpoint resolves to a private or reserved network address"
          ),
          ""
        )
        return
      }
      const selected = addresses.at(0)
      if (!selected) {
        callback(new Error("The S3 endpoint did not resolve to an address"), "")
        return
      }
      if (options.all) callback(null, addresses)
      else callback(null, selected.address, selected.family)
    }
  )
}

export function isPublicS3Address(address: string): boolean {
  const normalized = normalizePeerAddress(address)
  const family = isIP(normalized)
  return (
    family !== 0 &&
    !BLOCKED_ADDRESSES.check(normalized, family === 4 ? "ipv4" : "ipv6")
  )
}

function normalizePeerAddress(value: string): string {
  const withoutZone = value.split("%", 1)[0] ?? value
  const mappedIpv4 = withoutZone.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)
  if (mappedIpv4?.[1]) return mappedIpv4[1]
  if (isIP(withoutZone) !== 6) return withoutZone
  return Result.try(() => {
    const hostname = new URL(`http://[${withoutZone}]/`).hostname.slice(1, -1)
    const mappedHex = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/iu.exec(hostname)
    if (!mappedHex?.[1] || !mappedHex[2]) return withoutZone
    const high = Number.parseInt(mappedHex[1], 16)
    const low = Number.parseInt(mappedHex[2], 16)
    return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`
  }).pipe(Result.getOrElse(() => withoutZone))
}

function s3Request<TResult>(
  operation: string,
  request: (signal: AbortSignal) => Promise<TResult>
) {
  return Effect.tryPromise({
    try: request,
    catch: (cause) =>
      backupStorageError(
        "s3_request_failed",
        operation,
        "The S3-compatible storage request failed. Check the endpoint, region, bucket, credentials, and key permissions.",
        cause
      ),
  })
}

function deleteS3PrefixPages(client: S3Client, bucket: string, prefix: string) {
  return Effect.tryPromise({
    try: () =>
      deleteS3PrefixObjectPages(
        async (token) => {
          const page = await client.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              ContinuationToken: token,
              MaxKeys: S3_DELETE_PAGE_SIZE,
              Prefix: prefix,
            })
          )
          return {
            keys:
              page.Contents?.flatMap((entry) =>
                entry.Key ? [entry.Key] : []
              ) ?? [],
            nextToken: page.IsTruncated
              ? page.NextContinuationToken
              : undefined,
          }
        },
        async (keys) => {
          const result = await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: {
                Objects: keys.map((Key) => ({ Key })),
                Quiet: true,
              },
            })
          )
          failIfS3DeleteObjectsErrored(result)
        }
      ),
    catch: (cause) =>
      cause instanceof BackupStorageError
        ? cause
        : backupStorageError(
            "s3_request_failed",
            "storage.deletePrefix",
            "The S3-compatible storage request failed. Check the endpoint, region, bucket, credentials, and key permissions.",
            cause
          ),
  })
}

function s3FailureStatus(cause: unknown): number | null {
  if (cause === null || typeof cause !== "object") return null
  const metadata = (cause as { $metadata?: { httpStatusCode?: unknown } })
    .$metadata
  const status = metadata?.httpStatusCode
  return typeof status === "number" && Number.isSafeInteger(status)
    ? status
    : null
}

function backupStorageError(
  code: string,
  operation: string,
  reason: string,
  cause?: unknown
) {
  return BackupStorageError.make({
    code,
    operation,
    reason,
    ...(cause === undefined ? {} : { cause }),
  })
}
