/**
 * The browser's half of direct Relay transfers. Each request is authorized
 * by a capability Hearth signs for one path, proven with a key the page
 * holds, and sent straight to the Relay, which continues this page's trace.
 * Transfers are effects, so callers can run them concurrently and cancel
 * them; the promise wrappers below run them through browser telemetry.
 */
import { relayBrowserRequestProofTranscript } from "@workspace/contracts"
import { Effect, Option, Result, Schema } from "effect"
import { Base64Url, Hex } from "effect/encoding"

import {
  currentBrowserTraceparent,
  runBrowserEffect,
} from "@/lib/browser-telemetry"
import type { FileArchiveFormat } from "@/lib/file-download-preferences"
import { issueFileCapability } from "@/server/relay-capability"
import { saveRelayFile } from "@/server/relay"

// A small text file can still be saved through Hearth when the browser
// can't reach the Relay directly.
const HEARTH_FILE_FALLBACK_LIMIT = 2 * 1024 * 1024

/**
 * Why a transfer didn't happen: the Relay couldn't be reached directly, it
 * refused the request, the transfer was cancelled, or it answered with
 * something other than a transfer result.
 */
export class RelayTransferError extends Schema.TaggedError<RelayTransferError>()(
  "RelayTransferError",
  {
    reason: Schema.Literals([
      "aborted",
      "invalid_response",
      "rejected",
      "unavailable",
    ]),
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

interface FileTransferInput {
  readonly instanceId: string
  readonly path: string
  readonly relayId: string
}

export type DownloadCompression = FileArchiveFormat | "none"
type FileRequestMethod = "GET" | "HEAD" | "POST" | "PUT"

interface RelayFileAuthorization {
  readonly headers: {
    readonly Authorization: string
    readonly "X-Kiln-Nonce": string
    readonly "X-Kiln-Proof": string
    readonly "X-Kiln-Public-Key": string
    readonly "X-Kiln-Requested-At": string
  }
  readonly url: URL
}

const RelayUploadResult = Schema.Struct({
  modifiedAt: Schema.String,
  path: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  size: Schema.Number,
})
export type RelayUploadResult = typeof RelayUploadResult.Type

const RelayFailureBody = Schema.fromJsonString(
  Schema.Struct({ error: Schema.String })
)

const CapabilityPayload = Schema.fromJsonString(
  Schema.Struct({ capabilityId: Schema.String, expiresAt: Schema.Number })
)

const SizeHeader = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)

export interface RelayFileDownloadPreview {
  readonly gzipSizeEstimate: number
  readonly maxSize: number
  readonly modifiedAt: string
  readonly name: string
  readonly recommendedCompression: boolean
  readonly size: number
  readonly zipSizeEstimate: number
}

/** What a download would send, from the Relay's answer to a HEAD request. */
export const inspectRelayFileDownloadEffect = Effect.fn(
  "RelayTransfer.inspect"
)(function* (input: FileTransferInput) {
  const authorization = yield* authorizeRelayFileRequest(input, "HEAD")
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(authorization.url, {
        headers: authorization.headers,
        method: "HEAD",
        mode: "cors",
        signal,
      }),
    catch: (cause) => unavailable("download", cause),
  })
  if (!response.ok) return yield* rejected(response, "download")
  const header = (name: string) =>
    Schema.decodeUnknownEffect(SizeHeader)(response.headers.get(name)).pipe(
      Effect.mapError(
        (cause) =>
          new RelayTransferError({
            reason: "invalid_response",
            message: "Relay returned invalid download metadata",
            cause,
          })
      )
    )
  const [size, gzipSizeEstimate, zipSizeEstimate, maxSize] = yield* Effect.all([
    header("Content-Length"),
    header("X-Kiln-Gzip-Size-Estimate"),
    header("X-Kiln-Zip-Size-Estimate"),
    header("X-Kiln-Download-Max-Size"),
  ] as const)
  return {
    gzipSizeEstimate,
    maxSize,
    modifiedAt: response.headers.get("Last-Modified") ?? "",
    name: input.path.split("/").filter(Boolean).at(-1) || "download",
    recommendedCompression: size >= 256 * 1024 && zipSizeEstimate < size * 0.9,
    size,
    zipSizeEstimate,
  } satisfies RelayFileDownloadPreview
})

/**
 * A small file's bytes, read straight from the Relay into the page, as for
 * an icon chosen from a game server's files. Larger files are refused
 * before they're read.
 */
export const readRelayFileEffect = Effect.fn("RelayTransfer.read")(function* (
  input: FileTransferInput & { readonly maxBytes: number }
) {
  const authorization = yield* authorizeRelayFileRequest(input, "GET")
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(authorization.url, {
        headers: authorization.headers,
        method: "GET",
        mode: "cors",
        signal,
      }),
    catch: (cause) => unavailable("download", cause),
  })
  if (!response.ok) return yield* rejected(response, "download")
  const size = Number(response.headers.get("Content-Length") ?? "0")
  if (size > input.maxBytes) {
    yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
    return yield* new RelayTransferError({
      reason: "rejected",
      message: `Files larger than ${Math.round(input.maxBytes / 1024)} KiB can't be used`,
    })
  }
  const blob = yield* Effect.tryPromise({
    try: () => response.blob(),
    catch: (cause) => unavailable("download", cause),
  })
  yield* Effect.annotateCurrentSpan("kiln.transfer.bytes", blob.size)
  if (blob.size > input.maxBytes) {
    return yield* new RelayTransferError({
      reason: "rejected",
      message: `Files larger than ${Math.round(input.maxBytes / 1024)} KiB can't be used`,
    })
  }
  return blob
})

/**
 * Hands a file's download to the browser's own download manager, which
 * streams it to disk and shows its progress. A form post carries the
 * credentials, since a native download can't send headers.
 */
export const downloadRelayFileEffect = Effect.fn("RelayTransfer.download")(
  function* (
    input: FileTransferInput & {
      readonly compression: DownloadCompression
      readonly name: string
    }
  ) {
    const name = input.name.trim()
    if (!isValidRelayDownloadName(name)) {
      return yield* new RelayTransferError({
        reason: "rejected",
        message: "Enter a valid file name without slashes",
      })
    }
    yield* Effect.annotateCurrentSpan(
      "kiln.transfer.compression",
      input.compression
    )
    const authorization = yield* authorizeRelayFileRequest(input, "POST")
    submitNativeDownload(authorization, {
      compression: input.compression,
      name,
      path: input.path,
    })
  }
)

/** Hands a zip of several files and folders to the browser's downloads. */
export const downloadRelayArchiveEffect = Effect.fn(
  "RelayTransfer.downloadArchive"
)(function* (
  input: Omit<FileTransferInput, "path"> & {
    readonly name: string
    readonly paths: ReadonlyArray<string>
  }
) {
  if (!input.paths.length) {
    return yield* new RelayTransferError({
      reason: "rejected",
      message: "Select files to download",
    })
  }
  const name = input.name.trim()
  if (!isValidRelayDownloadName(name)) {
    return yield* new RelayTransferError({
      reason: "rejected",
      message: "Enter a valid file name without slashes",
    })
  }
  yield* Effect.annotateCurrentSpan("kiln.transfer.paths", input.paths.length)
  // The capability names the selection's digest, which the Relay checks
  // against the paths the form sends.
  const serializedPaths = JSON.stringify(input.paths)
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(serializedPaths))
  )
  const path = `@archive/${Hex.encode(new Uint8Array(digest))}`
  const authorization = yield* authorizeRelayFileRequest(
    { ...input, path },
    "POST"
  )
  submitNativeDownload(authorization, {
    compression: "zip",
    name,
    path,
    serializedPaths,
  })
})

/**
 * Streams a file to the Relay, reporting how much has been sent. Without a
 * direct connection, a small text file is saved through Hearth instead.
 */
export const uploadRelayFileEffect = Effect.fn("RelayTransfer.upload")(
  function* (
    input: FileTransferInput & {
      readonly file: File
      readonly onProgress?: ((uploadedBytes: number) => void) | undefined
    }
  ) {
    yield* Effect.annotateCurrentSpan("kiln.transfer.bytes", input.file.size)
    const result = yield* sendUpload(input).pipe(
      Effect.catchIf(
        (error) => error.reason === "unavailable",
        (error) =>
          input.file.size > HEARTH_FILE_FALLBACK_LIMIT
            ? Effect.fail(error)
            : Effect.sync(() => input.onProgress?.(0)).pipe(
                // The direct attempt's progress doesn't count toward Hearth's.
                Effect.andThen(saveThroughHearth(input)),
                Effect.mapError((cause) => unavailable("upload", cause))
              )
      )
    )
    input.onProgress?.(input.file.size)
    return result
  }
)

export interface RelayUploadItem {
  readonly file: File
  readonly path: string
}

export interface RelayUploadOutcome {
  readonly cause: RelayTransferError | null
  readonly item: RelayUploadItem
}

/**
 * Uploads several files, three at a time, under one span. Each file's
 * failure is kept rather than stopping the rest. `onProgress` is called
 * with the file and how much of it has been sent.
 */
export const uploadRelayFilesEffect = Effect.fn("RelayTransfer.uploadBatch")(
  function* (input: {
    readonly instanceId: string
    readonly items: ReadonlyArray<RelayUploadItem>
    readonly onStart?: (item: RelayUploadItem) => void
    readonly onProgress?: (item: RelayUploadItem, uploadedBytes: number) => void
    readonly onSettled?: (outcome: RelayUploadOutcome) => void
    readonly relayId: string
  }) {
    yield* Effect.annotateCurrentSpan({
      "kiln.transfer.files": input.items.length,
      "kiln.transfer.bytes": input.items.reduce(
        (total, item) => total + item.file.size,
        0
      ),
    })
    return yield* Effect.forEach(
      input.items,
      (item) =>
        Effect.sync(() => input.onStart?.(item)).pipe(
          Effect.andThen(
            uploadRelayFileEffect({
              file: item.file,
              instanceId: input.instanceId,
              onProgress: (loaded) => input.onProgress?.(item, loaded),
              path: item.path,
              relayId: input.relayId,
            })
          ),
          Effect.match({
            onFailure: (cause): RelayUploadOutcome => ({ cause, item }),
            onSuccess: (): RelayUploadOutcome => ({ cause: null, item }),
          }),
          Effect.tap((outcome) => Effect.sync(() => input.onSettled?.(outcome)))
        ),
      { concurrency: 3 }
    )
  }
)

export function inspectRelayFileDownload(
  input: FileTransferInput & { signal?: AbortSignal }
): Promise<RelayFileDownloadPreview> {
  return runBrowserEffect(inspectRelayFileDownloadEffect(input), {
    signal: input.signal,
  })
}

export function downloadRelayFile(
  input: FileTransferInput & {
    compression: DownloadCompression
    name: string
  }
): Promise<void> {
  return runBrowserEffect(downloadRelayFileEffect(input))
}

export function downloadRelayArchive(
  input: Omit<FileTransferInput, "path"> & {
    name: string
    paths: ReadonlyArray<string>
  }
): Promise<void> {
  return runBrowserEffect(downloadRelayArchiveEffect(input))
}

export function readRelayFile(
  input: FileTransferInput & { maxBytes: number; signal?: AbortSignal }
): Promise<Blob> {
  return runBrowserEffect(readRelayFileEffect(input), { signal: input.signal })
}

export function uploadRelayFile(
  input: FileTransferInput & {
    file: File
    onProgress?: (uploadedBytes: number) => void
    signal?: AbortSignal
  }
): Promise<RelayUploadResult> {
  return runBrowserEffect(uploadRelayFileEffect(input), {
    signal: input.signal,
  })
}

export function isValidRelayDownloadName(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 255 || trimmed === "." || trimmed === "..") {
    return false
  }
  return !Array.from(trimmed).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return (
      codePoint < 32 ||
      codePoint === 127 ||
      character === "/" ||
      character === "\\"
    )
  })
}

// The upload itself, over XHR for its progress events, which fetch still
// lacks. Interrupting it aborts the request.
const sendUpload = Effect.fnUntraced(function* (
  input: FileTransferInput & {
    readonly file: File
    readonly onProgress?: ((uploadedBytes: number) => void) | undefined
  }
) {
  const authorization = yield* authorizeRelayFileRequest(input, "PUT")
  const response = yield* Effect.callback<
    { body: string; status: number },
    RelayTransferError
  >((resume) => {
    const request = new XMLHttpRequest()
    request.upload.onprogress = (event) =>
      input.onProgress?.(Math.min(event.loaded, input.file.size))
    request.onload = () =>
      resume(
        Effect.succeed({ body: request.responseText, status: request.status })
      )
    request.onerror = () =>
      resume(
        Effect.fail(
          unavailable("upload", new TypeError("Relay upload connection failed"))
        )
      )
    request.onabort = () =>
      resume(
        Effect.fail(
          new RelayTransferError({
            reason: "aborted",
            message: "Relay upload was cancelled",
          })
        )
      )
    request.open("PUT", authorization.url)
    for (const [name, value] of Object.entries(authorization.headers)) {
      request.setRequestHeader(name, value)
    }
    request.send(input.file)
    return Effect.sync(() => request.abort())
  })
  if (response.status < 200 || response.status >= 300) {
    return yield* new RelayTransferError({
      reason: "rejected",
      message: failureMessage(response.body, response.status, "upload"),
      status: response.status,
    })
  }
  return yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(RelayUploadResult)
  )(response.body).pipe(
    Effect.mapError(
      (cause) =>
        new RelayTransferError({
          reason: "invalid_response",
          message: "Relay returned an invalid upload response",
          cause,
        })
    )
  )
})

const saveThroughHearth = Effect.fn("RelayTransfer.saveThroughHearth")(
  function* (input: FileTransferInput & { readonly file: File }) {
    const bytes = new Uint8Array(
      yield* Effect.promise(() => input.file.arrayBuffer())
    )
    const content = yield* Effect.try(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    )
    const [saved, digest] = yield* Effect.all(
      [
        Effect.tryPromise(() =>
          saveRelayFile({
            data: {
              content,
              instanceId: input.instanceId,
              path: input.path,
              relayId: input.relayId,
            },
          })
        ),
        Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)),
      ],
      { concurrency: 2 }
    )
    return {
      modifiedAt: saved.modifiedAt,
      path: saved.path,
      sha256: Hex.encode(new Uint8Array(digest)),
      size: bytes.byteLength,
    } satisfies RelayUploadResult
  }
)

/**
 * A request's credentials: a capability Hearth signs for this path and
 * method, and this page's proof that it holds the key the capability names.
 * The URL carries the current span's `traceparent`, so the Relay's work
 * joins this trace.
 */
const authorizeRelayFileRequest = Effect.fn("RelayTransfer.authorize")(
  function* (input: FileTransferInput, method: FileRequestMethod) {
    const keys = yield* pageTransferKeys
    const issued = yield* Effect.tryPromise({
      try: () =>
        issueFileCapability({
          data: {
            action:
              method === "PUT"
                ? "instance.files.upload"
                : "instance.files.download",
            instanceId: input.instanceId,
            optInV2: true,
            path: input.path,
            publicKeyJwk: keys.publicKeyJwk,
            relayId: input.relayId,
          },
        }),
      catch: (cause) =>
        new RelayTransferError({
          reason: "rejected",
          message:
            cause instanceof Error
              ? cause.message
              : "Hearth could not authorize this transfer",
          cause,
        }),
    })
    const payload = yield* Schema.decodeUnknownEffect(CapabilityPayload)(
      Result.getOrElse(
        Base64Url.decodeString(issued.capability.split(".", 1)[0] ?? ""),
        () => ""
      )
    ).pipe(
      Effect.mapError(
        (cause) =>
          new RelayTransferError({
            reason: "invalid_response",
            message: "Hearth returned an invalid Relay capability",
            cause,
          })
      )
    )
    const nonce = Base64Url.encode(crypto.getRandomValues(new Uint8Array(32)))
    const requestedAt = Date.now()
    const proof = yield* Effect.promise(() =>
      crypto.subtle.sign(
        { hash: "SHA-256", name: "ECDSA" },
        keys.privateKey,
        new TextEncoder().encode(
          relayBrowserRequestProofTranscript({
            capabilityId: payload.capabilityId,
            expiresAt: payload.expiresAt,
            instanceId: input.instanceId,
            method,
            nonce,
            path: input.path,
            relayId: input.relayId,
            requestedAt,
          })
        )
      )
    )
    // A Relay browsers can't reach gets its transfers through Hearth,
    // which passes them on unchanged.
    const url =
      issued.proxyMode === "hearth"
        ? new URL(
            `/api/relays/${encodeURIComponent(input.relayId)}/browser/files/${encodeURIComponent(input.instanceId)}`,
            window.location.origin
          )
        : new URL(
            `/v1/browser/files/${encodeURIComponent(input.instanceId)}`,
            issued.browserOrigin
          )
    url.searchParams.set("path", input.path)
    const traceparent = yield* currentBrowserTraceparent
    if (traceparent) url.searchParams.set("traceparent", traceparent)
    return {
      headers: {
        Authorization: `Kiln ${issued.capability}`,
        "X-Kiln-Nonce": nonce,
        "X-Kiln-Proof": Base64Url.encode(new Uint8Array(proof)),
        "X-Kiln-Public-Key": Base64Url.encode(
          new TextEncoder().encode(JSON.stringify(keys.publicKeyJwk))
        ),
        "X-Kiln-Requested-At": String(requestedAt),
      },
      url,
    } satisfies RelayFileAuthorization
  }
)

// One key pair for the page's transfers. Its private half can't leave the
// browser, and each capability still names one path and method, so a
// folder upload doesn't generate a key per file.
const pageTransferKeys = Effect.cached(
  Effect.promise(async () => {
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"]
    )
    const exported = await crypto.subtle.exportKey("jwk", keys.publicKey)
    if (!exported.x || !exported.y) {
      throw new Error("Browser could not create a file transfer key")
    }
    return {
      privateKey: keys.privateKey,
      publicKeyJwk: {
        crv: "P-256" as const,
        kty: "EC" as const,
        x: exported.x,
        y: exported.y,
      },
    }
  })
).pipe(Effect.runSync)

function submitNativeDownload(
  authorization: RelayFileAuthorization,
  input: {
    compression: DownloadCompression
    name: string
    path: string
    serializedPaths?: string
  }
): void {
  const target = `kiln-download-${crypto.randomUUID()}`
  const frame = document.createElement("iframe")
  frame.hidden = true
  frame.name = target
  const form = document.createElement("form")
  form.hidden = true
  form.action = authorization.url.toString()
  form.method = "post"
  form.target = target
  const values = {
    authorization: authorization.headers.Authorization,
    compression: input.compression,
    name: input.name,
    nonce: authorization.headers["X-Kiln-Nonce"],
    path: input.path,
    proof: authorization.headers["X-Kiln-Proof"],
    publicKey: authorization.headers["X-Kiln-Public-Key"],
    requestedAt: authorization.headers["X-Kiln-Requested-At"],
    ...(input.serializedPaths === undefined
      ? {}
      : { archivePaths: input.serializedPaths }),
  }
  for (const [key, value] of Object.entries(values)) {
    const field = document.createElement("input")
    field.name = key
    field.value = value
    form.append(field)
  }
  document.body.append(frame, form)
  form.submit()
  form.remove()
  window.setTimeout(() => frame.remove(), 60_000)
}

function unavailable(
  operation: "download" | "upload",
  cause: unknown
): RelayTransferError {
  return new RelayTransferError({
    reason: "unavailable",
    message: `The secure direct ${operation} edge is unavailable, and Hearth could not safely proxy this file. Configure bundled Traefik or a trusted existing Traefik edge and try again.`,
    cause,
  })
}

function rejected(
  response: Response,
  operation: "download" | "upload"
): Effect.Effect<never, RelayTransferError> {
  return Effect.tryPromise(() => response.text()).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((body) =>
      Effect.fail(
        new RelayTransferError({
          reason: "rejected",
          message: failureMessage(body, response.status, operation),
          status: response.status,
        })
      )
    )
  )
}

// The Relay's reason for refusing, or a generic one for an empty answer
// such as a HEAD request's.
function failureMessage(
  body: string,
  status: number,
  operation: "download" | "upload"
): string {
  return Option.match(Schema.decodeUnknownOption(RelayFailureBody)(body), {
    onNone: () => `Relay ${operation} failed with HTTP ${status}`,
    onSome: (failure) => failure.error,
  })
}
