import { relayBrowserRequestProofTranscript } from "@workspace/contracts"
import { Effect } from "effect"

import { recoverPromise } from "@/effect/promise"
import { issueFileCapability } from "@/server/relay-capability"
import { saveRelayFile } from "@/server/relay"
import type { FileArchiveFormat } from "@/lib/file-download-preferences"

const HEARTH_FILE_FALLBACK_LIMIT = 2 * 1024 * 1024

class DirectRelayTransferError extends Error {}

interface FileTransferInput {
  instanceId: string
  path: string
  relayId: string
}

export interface RelayFileDownloadPreview {
  gzipSizeEstimate: number
  maxSize: number
  modifiedAt: string
  name: string
  recommendedCompression: boolean
  size: number
  zipSizeEstimate: number
}

type DownloadCompression = FileArchiveFormat | "none"
type FileRequestMethod = "HEAD" | "POST" | "PUT"

interface RelayFileAuthorization {
  headers: {
    Authorization: string
    "X-Kiln-Nonce": string
    "X-Kiln-Proof": string
    "X-Kiln-Public-Key": string
    "X-Kiln-Requested-At": string
  }
  url: URL
}

export async function inspectRelayFileDownload(
  input: FileTransferInput
): Promise<RelayFileDownloadPreview> {
  const response = await runTransfer(
    transferOperation(async () => {
      const result = await relayFileRequest(input, "HEAD")
      if (!result.ok) throw await transferError(result, "download")
      return result
    }).pipe(
      Effect.mapError((cause) => directTransferUnavailable("download", cause))
    )
  )
  const size = requiredSizeHeader(response, "Content-Length")
  const gzipSizeEstimate = requiredSizeHeader(
    response,
    "X-Kiln-Gzip-Size-Estimate"
  )
  const zipSizeEstimate = requiredSizeHeader(
    response,
    "X-Kiln-Zip-Size-Estimate"
  )
  const maxSize = requiredSizeHeader(response, "X-Kiln-Download-Max-Size")
  return {
    gzipSizeEstimate,
    maxSize,
    modifiedAt: response.headers.get("Last-Modified") ?? "",
    name: input.path.split("/").filter(Boolean).at(-1) || "download",
    recommendedCompression: size >= 256 * 1024 && zipSizeEstimate < size * 0.9,
    size,
    zipSizeEstimate,
  }
}

export async function downloadRelayFile(
  input: FileTransferInput & {
    compression: DownloadCompression
    name: string
  }
): Promise<void> {
  const name = input.name.trim()
  if (!isValidRelayDownloadName(name)) {
    throw new Error("Enter a valid file name without slashes")
  }
  const authorization = await runTransfer(
    transferOperation(() => relayFileAuthorization(input, "POST")).pipe(
      Effect.mapError((cause) => directTransferUnavailable("download", cause))
    )
  )
  submitNativeDownload(authorization, {
    compression: input.compression,
    name,
    path: input.path,
  })
}

export async function downloadRelayArchive(
  input: Omit<FileTransferInput, "path"> & {
    name: string
    paths: ReadonlyArray<string>
  }
): Promise<void> {
  if (!input.paths.length) throw new Error("Select files to download")
  const name = input.name.trim()
  if (!isValidRelayDownloadName(name)) {
    throw new Error("Enter a valid file name without slashes")
  }
  const serializedPaths = JSON.stringify(input.paths)
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serializedPaths)
  )
  const path = `@archive/${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`
  const authorization = await runTransfer(
    transferOperation(() =>
      relayFileAuthorization({ ...input, path }, "POST")
    ).pipe(
      Effect.mapError((cause) => directTransferUnavailable("download", cause))
    )
  )
  submitNativeDownload(authorization, {
    compression: "zip",
    name,
    path,
    serializedPaths,
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

export async function uploadRelayFile(
  input: FileTransferInput & {
    file: File
  }
): Promise<{
  modifiedAt: string
  path: string
  sha256: string
  size: number
}> {
  const result = await runTransfer(
    transferOperation(async () => {
      const response = await relayFileRequest(input, "PUT", input.file)
      if (!response.ok) throw await transferError(response, "upload")
      return (await response.json()) as unknown
    }).pipe(
      Effect.catchIf(isDirectConnectionFailure, (cause) => {
        if (input.file.size > HEARTH_FILE_FALLBACK_LIMIT) {
          return Effect.fail(directTransferUnavailable("upload", cause))
        }
        return transferOperation(async () => {
          const bytes = new Uint8Array(await input.file.arrayBuffer())
          const content = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes
          )
          const [saved, digest] = await Promise.all([
            saveRelayFile({
              data: {
                content,
                instanceId: input.instanceId,
                path: input.path,
                relayId: input.relayId,
              },
            }),
            crypto.subtle.digest("SHA-256", bytes),
          ])
          return {
            modifiedAt: saved.modifiedAt,
            path: saved.path,
            sha256: Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0")
            ).join(""),
            size: bytes.byteLength,
          }
        }).pipe(
          Effect.mapError((fallbackCause) =>
            directTransferUnavailable("upload", fallbackCause)
          )
        )
      })
    )
  )
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Relay returned an invalid upload response")
  }
  const value = Object.fromEntries(Object.entries(result))
  if (
    typeof value.modifiedAt !== "string" ||
    typeof value.path !== "string" ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    typeof value.size !== "number"
  )
    throw new Error("Relay returned an invalid upload response")
  return {
    modifiedAt: value.modifiedAt,
    path: value.path,
    sha256: value.sha256,
    size: value.size,
  }
}

async function relayFileRequest(
  input: FileTransferInput,
  method: "HEAD" | "PUT",
  body?: BodyInit
): Promise<Response> {
  const authorization = await relayFileAuthorization(input, method)
  return runTransfer(
    transferOperation(() =>
      fetch(authorization.url, {
        ...(body === undefined ? {} : { body }),
        headers: authorization.headers,
        method,
        mode: "cors",
      })
    ).pipe(
      Effect.mapError(
        (cause) =>
          new DirectRelayTransferError(
            "The browser could not establish the direct Relay transfer",
            { cause }
          )
      )
    )
  )
}

async function relayFileAuthorization(
  input: FileTransferInput,
  method: FileRequestMethod
): Promise<RelayFileAuthorization> {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"]
  )
  const exported = await crypto.subtle.exportKey("jwk", keys.publicKey)
  const publicKeyJwk = {
    crv: "P-256" as const,
    kty: "EC" as const,
    x: requiredCoordinate(exported.x),
    y: requiredCoordinate(exported.y),
  }
  const issued = await issueFileCapability({
    data: {
      action:
        method === "PUT" ? "instance.files.upload" : "instance.files.download",
      instanceId: input.instanceId,
      optInV2: true,
      path: input.path,
      publicKeyJwk,
      relayId: input.relayId,
    },
  })
  if (issued.proxyMode === "hearth") {
    throw new DirectRelayTransferError(
      "This Relay is configured to transfer through Hearth"
    )
  }
  const payload = capabilityPayload(issued.capability)
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32))
  const nonce = bytesToBase64Url(nonceBytes)
  const requestedAt = Date.now()
  const proof = await crypto.subtle.sign(
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
  const url = new URL(
    `/v1/browser/files/${encodeURIComponent(input.instanceId)}`,
    issued.browserOrigin
  )
  url.searchParams.set("path", input.path)
  return {
    headers: {
      Authorization: `Kiln ${issued.capability}`,
      "X-Kiln-Nonce": nonce,
      "X-Kiln-Proof": bytesToBase64Url(new Uint8Array(proof)),
      "X-Kiln-Public-Key": bytesToBase64Url(
        new TextEncoder().encode(JSON.stringify(publicKeyJwk))
      ),
      "X-Kiln-Requested-At": String(requestedAt),
    },
    url,
  }
}

function requiredSizeHeader(response: Response, name: string): number {
  const value = Number(response.headers.get(name))
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Relay returned invalid download metadata")
  }
  return value
}

function isDirectConnectionFailure(cause: unknown): boolean {
  return cause instanceof DirectRelayTransferError
}

function directTransferUnavailable(
  operation: "download" | "upload",
  cause: unknown
): Error {
  return new Error(
    `The secure direct ${operation} edge is unavailable, and Hearth could not safely proxy this file. Configure bundled Traefik or a trusted existing Traefik edge and try again.`,
    { cause }
  )
}

function transferOperation<A>(
  run: () => Promise<A>
): Effect.Effect<A, unknown> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => cause,
  })
}

function runTransfer<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return Effect.runPromise(effect)
}

function capabilityPayload(capability: string): {
  capabilityId: string
  expiresAt: number
} {
  const encoded = capability.split(".", 1)[0]
  if (!encoded) throw new Error("Hearth returned an invalid Relay capability")
  const value = JSON.parse(atobBase64Url(encoded)) as unknown
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hearth returned an invalid Relay capability")
  }
  const payload = Object.fromEntries(Object.entries(value))
  if (
    typeof payload.capabilityId !== "string" ||
    typeof payload.expiresAt !== "number"
  )
    throw new Error("Hearth returned an invalid Relay capability")
  return {
    capabilityId: payload.capabilityId,
    expiresAt: payload.expiresAt,
  }
}

async function transferError(
  response: Response,
  operation: string
): Promise<Error> {
  const body = await recoverPromise(
    () => response.json(),
    () => null
  )
  const message =
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof body.error === "string"
      ? body.error
      : `Relay ${operation} failed with HTTP ${response.status}`
  return new Error(message)
}

function requiredCoordinate(value: string | undefined): string {
  if (!value) throw new Error("Browser could not create a file transfer key")
  return value
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
}

function atobBase64Url(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
  return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))
}
