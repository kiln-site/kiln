/**
 * Browsers' direct file transfers: `/v1/browser/files/<root>` downloads,
 * uploads, and archive downloads under a game server, an App's data, a
 * database's dumps, or the host's files. Each request carries a capability
 * Hearth signed for one path and a proof from the browser key it names.
 */
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { Effect, Result, Schema, Scope } from "effect"

import {
  appIdFromFileRoot,
  databaseIdFromFileRoot,
  isRelayFileRoot,
  relayBrowserRequestProofTranscript,
} from "@workspace/contracts"

import {
  browserAuthority,
  BrowserPublicKeySchema,
  browserKeyThumbprint,
  decodeCapability,
  validateCapability,
} from "../browser-capability.js"
import { isCanonicalBrowserFileProofNonce } from "../browser-security.js"
import type {
  BrowserSessionAuthority,
  BrowserSessionRegistry,
} from "../browser-session-registry.js"
import type { RelayConfig } from "../config.js"
import type { DockerDriver } from "../docker.js"
import type { RelayIdentity } from "../effect/identity.js"
import {
  reportRelayError,
  runRelayRequest,
  traceParentSpan,
} from "../effect/runtime.js"
import type { RelayStateStore } from "../effect/state.js"
import {
  MAX_TRANSFER_BYTES,
  type FileRoot,
  type FilesystemDriver,
} from "../files.js"
import type { OperationLanes } from "../operation-lanes.js"
import { fileRootTransferLocks } from "../operation-plans.js"
import { fileTransferAction } from "../permissions.js"
import {
  archiveBody,
  estimateCompressedSizes,
  fileBody,
  type DownloadCompression,
} from "./bodies.js"
import type { TransferGate } from "./gate.js"
import {
  contentDisposition,
  normalizedDownloadName,
  parseByteRange,
  readBoundedBody,
  reject,
  requiredHeader,
  sendBody,
  sendJson,
  TransferRejected,
} from "./http.js"
import { serveTransfer, type TransferResult } from "./serve.js"

const HTTP_PROOF_WINDOW_MS = 30_000
const MAX_DOWNLOAD_FORM_BYTES = 2 * 1024 * 1024
const MAX_ARCHIVE_SELECTION_PATHS = 5_000
// A request that hasn't authenticated by then is cut off.
const FILE_AUTHENTICATION_TIMEOUT_MS = 30_000

type BrowserFileMethod = "GET" | "HEAD" | "POST" | "PUT"

interface BrowserRequestCredentials {
  readonly authorization: string
  readonly nonce: string
  readonly proof: string
  readonly publicKey: string
  readonly requestedAt: string
}

// A download a browser asks for with a native form post, which can't set
// headers, so the credentials travel in the form.
interface BrowserDownloadForm {
  readonly archivePaths: ReadonlyArray<string> | null
  readonly compression: DownloadCompression
  readonly credentials: BrowserRequestCredentials
  readonly name: string
  readonly path: string
}

interface BrowserFileAuthentication {
  readonly authority: BrowserSessionAuthority
  readonly current: { issuerGeneration: number; minimumRevision: number }
  readonly capabilityId: string
  readonly clientId: string
  readonly instanceId: string
  readonly subject: string
}

interface FileRootSource {
  readonly filesystem: FilesystemDriver
  readonly root: (id: string) => Promise<FileRoot>
}

export interface BrowserFileTransferOptions {
  readonly config: Pick<RelayConfig, "browserLimits">
  readonly docker: Pick<DockerDriver, "findInstance">
  readonly filesystem: FilesystemDriver
  /** The host's files, addressed as the Relay's file root. */
  readonly hostFiles?: FileRootSource | undefined
  /** Apps' data directories, addressed as `app:<appId>`. */
  readonly appFiles?: FileRootSource | undefined
  /** Databases' dump folders, addressed as `database:<databaseId>`. */
  readonly databaseFiles?: FileRootSource | undefined
  readonly gate: TransferGate
  readonly identity: RelayIdentity
  /** The lanes uploads wait in, with Hearth's requests. */
  readonly lanes: OperationLanes
  readonly registry: BrowserSessionRegistry
  readonly state: RelayStateStore["Service"]
}

export interface BrowserFileTransfers {
  /** Serves a browser file request; false for other requests. */
  readonly handleRequest: (
    request: IncomingMessage,
    response: ServerResponse
  ) => Promise<boolean>
}

export function browserFileTransfers(
  options: BrowserFileTransferOptions
): BrowserFileTransfers {
  // Proofs for v1 capabilities, which the Relay replays against in memory;
  // v2 proofs are reserved in its state.
  const legacyRequestProofs = new Map<string, number>()
  const pendingLegacyRequestProofs = new Set<string>()
  let pendingAuthentications = 0

  const authenticate = Effect.fn("RelayTransfer.authenticateBrowser")(
    function* (input: {
      credentials?: BrowserRequestCredentials | undefined
      instanceId: string
      method: BrowserFileMethod
      origin: string
      path: string
      request: IncomingMessage
    }) {
      const { request } = input
      const parsed = yield* Effect.try(() => {
        const authorization =
          input.credentials?.authorization ??
          requiredHeader(request, "authorization")
        if (!authorization.startsWith("Kiln ")) {
          throw new Error("Missing capability")
        }
        return decodeCapability(authorization.slice(5))
      })
      const requiredAction = browserFileAction(input.method, input.instanceId)
      const { nonce, publicKeyJwk, requestedAt } = yield* Effect.try(() => {
        const publicKeyJwk = Schema.decodeUnknownSync(BrowserPublicKeySchema)(
          JSON.parse(
            Buffer.from(
              input.credentials?.publicKey ??
                requiredHeader(request, "x-kiln-public-key"),
              "base64url"
            ).toString("utf8")
          ) as unknown
        )
        if (
          browserKeyThumbprint(publicKeyJwk) !== parsed.payload.keyThumbprint
        ) {
          throw new Error("Browser key does not match capability")
        }
        const requestedAt = Number(
          input.credentials?.requestedAt ??
            requiredHeader(request, "x-kiln-requested-at")
        )
        const nonce =
          input.credentials?.nonce ?? requiredHeader(request, "x-kiln-nonce")
        if (
          !Number.isSafeInteger(requestedAt) ||
          Math.abs(Date.now() - requestedAt) > HTTP_PROOF_WINDOW_MS ||
          !isCanonicalBrowserFileProofNonce(nonce)
        ) {
          throw new Error("Browser proof freshness is invalid")
        }
        return { nonce, publicKeyJwk, requestedAt }
      })
      const replayKey = `${parsed.payload.capabilityId}:${nonce}`
      if (parsed.payload.version === 1) {
        for (const [key, expiresAt] of legacyRequestProofs) {
          if (expiresAt <= Date.now()) legacyRequestProofs.delete(key)
        }
        if (
          legacyRequestProofs.has(replayKey) ||
          pendingLegacyRequestProofs.has(replayKey)
        ) {
          return yield* Effect.fail(new Error("Browser proof was replayed"))
        }
        const limit = options.config.browserLimits.fileReplayEntries
        if (
          legacyRequestProofs.size >= limit ||
          pendingLegacyRequestProofs.size >= limit
        ) {
          return yield* Effect.fail(new Error("Browser replay table is full"))
        }
        pendingLegacyRequestProofs.add(replayKey)
      }
      return yield* Effect.gen(function* () {
        const client = yield* options.state.findClientById(
          parsed.payload.issuer
        )
        if (!client) {
          return yield* Effect.fail(new Error("Capability issuer was revoked"))
        }
        yield* Effect.try(() => {
          validateCapability(
            parsed,
            client,
            input.origin,
            options.identity.fingerprint,
            requiredAction
          )
          if (
            parsed.payload.version === 2 &&
            parsed.payload.operation !== "file"
          ) {
            throw new Error("Capability is not for file requests")
          }
          if (
            parsed.payload.instanceId !== input.instanceId ||
            parsed.payload.path !== input.path
          ) {
            throw new Error("Capability scope does not match the file")
          }
          const proof = Buffer.from(
            input.credentials?.proof ?? requiredHeader(request, "x-kiln-proof"),
            "base64url"
          )
          const valid = verify(
            "sha256",
            Buffer.from(
              relayBrowserRequestProofTranscript({
                capabilityId: parsed.payload.capabilityId,
                expiresAt: parsed.payload.expiresAt,
                instanceId: input.instanceId,
                method: input.method,
                nonce,
                path: input.path,
                relayId: options.identity.fingerprint,
                requestedAt,
              })
            ),
            {
              dsaEncoding: "ieee-p1363",
              key: createPublicKey({ format: "jwk", key: publicKeyJwk }),
            },
            proof
          )
          if (!valid) throw new Error("Browser request proof is invalid")
        })
        let current = { issuerGeneration: 0, minimumRevision: 0 }
        if (parsed.payload.version === 2) {
          const authority = yield* options.state.browserAuthority({
            instanceId: parsed.payload.instanceId,
            issuer: parsed.payload.issuer,
            loginSessionId: parsed.payload.loginSessionId,
            subject: parsed.payload.subject,
          })
          if (
            parsed.payload.issuerGeneration !== authority.issuerGeneration ||
            parsed.payload.authorizationRevision < authority.minimumRevision
          ) {
            return yield* Effect.fail(
              new Error("Browser authorization is stale")
            )
          }
          current = authority
          const reservation = yield* options.state.reserveBrowserFileReplay({
            capabilityId: parsed.payload.capabilityId,
            expiresAt: parsed.payload.expiresAt,
            maxEntries: options.config.browserLimits.fileReplayEntries,
            nonce,
            now: Date.now(),
          })
          if (reservation !== "reserved") {
            return yield* Effect.fail(
              new Error(
                reservation === "full"
                  ? "Browser replay table is full"
                  : "Browser proof was replayed"
              )
            )
          }
        } else {
          legacyRequestProofs.set(replayKey, parsed.payload.expiresAt)
        }
        return {
          authority: browserAuthority(parsed.payload),
          current,
          capabilityId: parsed.payload.capabilityId,
          clientId: client.id,
          instanceId: parsed.payload.instanceId,
          subject: parsed.payload.subject,
        } satisfies BrowserFileAuthentication
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => pendingLegacyRequestProofs.delete(replayKey))
        )
      )
    }
  )

  const audit = (
    authentication: BrowserFileAuthentication,
    method: BrowserFileMethod,
    bytes: number,
    outcome: "aborted" | "completed"
  ) =>
    options.state
      .appendAudit({
        clientId: authentication.clientId,
        details: {
          bytes,
          instanceId: authentication.instanceId,
          method,
          outcome,
          permission: browserFileAction(method, authentication.instanceId),
          subject: authentication.subject,
        },
        event:
          method === "PUT" ? "browser.file.upload" : "browser.file.download",
        id: randomUUID(),
        occurredAt: Date.now(),
        requestId: authentication.capabilityId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            reportRelayError(cause, { operation: "browser.file.audit" })
          })
        )
      )

  const serve = (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    encodedRootId: string
  ): Effect.Effect<TransferResult | void, unknown, Scope.Scope> =>
    Effect.gen(function* () {
      const origin = request.headers.origin
      if (!origin) return yield* reject(403, "Browser origin is required")
      const cors = (extra: Record<string, string> = {}) =>
        browserCorsHeaders(origin, extra)
      if (request.method === "OPTIONS") {
        const clients = yield* options.state.listClients()
        if (!clients.some((client) => client.origins.includes(origin))) {
          return yield* reject(403, "Browser origin is not paired")
        }
        response.writeHead(204, cors(preflightHeaders)).end()
        return
      }
      const method = request.method
      if (
        method !== "GET" &&
        method !== "HEAD" &&
        method !== "POST" &&
        method !== "PUT"
      ) {
        return yield* reject(405, "Method not allowed")
      }
      const decodedRootId = Result.try(() => decodeURIComponent(encodedRootId))
      if (Result.isFailure(decodedRootId)) {
        return yield* reject(400, "Instance path is invalid")
      }
      const rootId = decodedRootId.success
      yield* Effect.annotateCurrentSpan({
        "kiln.file_root.kind": fileRootKind(rootId),
        "kiln.file_root.id": rootId,
      })

      // Authentication, including reading a download's form, is bounded in
      // how many run at once and how long each may take.
      if (
        pendingAuthentications >=
        options.config.browserLimits.pendingFileAuthentications
      ) {
        return yield* reject(429, "Relay file authentication capacity reached")
      }
      const clientConfiguration = options.registry.clientConfiguration
      const { authentication, form, path } = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          pendingAuthentications += 1
        }),
        () =>
          Effect.gen(function* () {
            const form =
              method === "POST"
                ? yield* readBrowserDownloadForm(request).pipe(
                    Effect.catch((cause) =>
                      reject(400, "Download request is invalid", cause)
                    )
                  )
                : null
            const path = form?.path ?? url.searchParams.get("path") ?? ""
            const authentication = yield* authenticate({
              credentials: form?.credentials,
              instanceId: rootId,
              method,
              origin,
              path,
              request,
            }).pipe(
              Effect.catch((cause) =>
                reject(401, "Browser capability is invalid", cause)
              )
            )
            return { authentication, form, path }
          }).pipe(
            Effect.timeoutOrElse({
              duration: FILE_AUTHENTICATION_TIMEOUT_MS,
              orElse: () =>
                Effect.suspend(() => {
                  if (!request.destroyed) request.destroy()
                  return reject(400, "Download request is invalid")
                }),
            })
          ),
        () =>
          Effect.sync(() => {
            pendingAuthentications -= 1
          })
      )
      if (clientConfiguration !== options.registry.clientConfiguration) {
        return yield* reject(401, "Browser capability is invalid")
      }

      yield* options.gate.admit("browser", authentication.clientId)
      // Revoking the person's access, or the Hearth's, cuts the transfer off.
      const transfer = yield* Effect.acquireRelease(
        Effect.sync(() =>
          options.registry.registerTransfer(
            authentication.authority,
            authentication.current,
            () => {
              if (!request.destroyed) request.destroy()
              if (!response.destroyed) response.destroy()
            }
          )
        ),
        (registered) => Effect.sync(() => registered.release())
      )
      if (!transfer.active()) {
        return yield* reject(403, "Browser authorization changed")
      }

      const target = yield* resolveFileRoot(options, rootId)
      if (!target) return yield* reject(404, "Instance not found")
      const { filesystem, root } = target

      if (method === "PUT") {
        yield* Effect.annotateCurrentSpan("kiln.transfer.operation", "upload")
        const uploaded = yield* options.lanes.run(
          {
            label: "browser.file.upload",
            // An App, database, or host root is addressed by its root ID; a
            // game server by the full ID it was found under.
            locks: fileRootTransferLocks(
              fileRootKind(rootId) === "instance" ? root.id : rootId
            ),
          },
          filesystem.upload(root, path, request, transfer.active)
        )
        // The answer goes first; the audit record doesn't hold it up.
        sendJson(response, 200, uploaded, cors())
        yield* audit(authentication, method, uploaded.size, "completed")
        return {
          bytes: uploaded.size,
          completed: true,
          direction: "received",
        } satisfies TransferResult
      }

      if (form?.archivePaths) {
        yield* Effect.annotateCurrentSpan("kiln.transfer.operation", "archive")
        const archivePaths = form.archivePaths
        const downloadName = yield* Effect.try({
          try: () => normalizedDownloadName(form.name, "files.zip"),
          catch: (cause) =>
            new TransferRejected({ status: 400, reason: asMessage(cause) }),
        })
        const sent = yield* filesystem.withArchiveDownload(
          root,
          archivePaths,
          (entries) =>
            Effect.suspend(() => {
              response.writeHead(
                200,
                cors({
                  "Cache-Control": "no-store",
                  "Content-Disposition": contentDisposition(downloadName),
                  "Content-Type": "application/zip",
                  "X-Content-Type-Options": "nosniff",
                  "X-Kiln-Download-Max-Size": String(MAX_TRANSFER_BYTES),
                })
              )
              return sendBody(archiveBody(entries), response)
            })
        )
        yield* audit(
          authentication,
          method,
          sent.bytes,
          sent.completed ? "completed" : "aborted"
        )
        return { ...sent, direction: "sent" } satisfies TransferResult
      }

      yield* Effect.annotateCurrentSpan(
        "kiln.transfer.operation",
        method === "HEAD" ? "inspect" : "download"
      )
      const sent = yield* filesystem.withDownload(root, path, (download) =>
        Effect.gen(function* () {
          const compression = form?.compression ?? "none"
          const { downloadName, range } = yield* Effect.try({
            try: () => {
              const range = parseByteRange(request.headers.range, download.size)
              if (compression !== "none" && range) {
                throw new Error("Compressed downloads do not support ranges")
              }
              const downloadName = normalizedDownloadName(
                form?.name,
                compression === "zip"
                  ? `${download.name}.zip`
                  : compression === "gzip"
                    ? `${download.name}.gz`
                    : download.name
              )
              return { downloadName, range }
            },
            catch: (cause) =>
              new TransferRejected({ status: 400, reason: asMessage(cause) }),
          })
          const estimates =
            method === "HEAD"
              ? yield* estimateCompressedSizes(
                  download.file,
                  download.name,
                  download.size
                )
              : null
          const headers = cors({
            ...(compression === "none" ? { "Accept-Ranges": "bytes" } : {}),
            "Cache-Control": "no-store",
            "Content-Disposition": contentDisposition(downloadName),
            ...(compression === "none"
              ? {
                  "Content-Length": String(
                    range ? range.end - range.start + 1 : download.size
                  ),
                }
              : {}),
            "Content-Type":
              compression === "zip"
                ? "application/zip"
                : compression === "gzip"
                  ? "application/gzip"
                  : "application/octet-stream",
            "Last-Modified": new Date(download.modifiedAt).toUTCString(),
            "X-Content-Type-Options": "nosniff",
            "X-Kiln-Download-Max-Size": String(MAX_TRANSFER_BYTES),
            ...(estimates === null
              ? {}
              : {
                  "X-Kiln-Compressed-Size-Estimate": String(estimates.zip),
                  "X-Kiln-Gzip-Size-Estimate": String(estimates.gzip),
                  "X-Kiln-Zip-Size-Estimate": String(estimates.zip),
                }),
            ...(range
              ? {
                  "Content-Range": `bytes ${range.start}-${range.end}/${download.size}`,
                }
              : {}),
          })
          response.writeHead(range ? 206 : 200, headers)
          if (method === "HEAD") {
            response.end()
            return { bytes: 0, completed: true }
          }
          return yield* sendBody(
            fileBody({
              compression,
              file: download.file,
              name: download.name,
              range,
              size: download.size,
            }),
            response
          )
        })
      )
      yield* audit(
        authentication,
        method,
        sent.bytes,
        sent.completed ? "completed" : "aborted"
      )
      return { ...sent, direction: "sent" } satisfies TransferResult
    })

  return {
    handleRequest: async (request, response) => {
      const url = new URL(request.url ?? "/", "http://relay")
      const match = url.pathname.match(/^\/v1\/browser\/files\/([^/]+)$/u)
      if (!match) return false
      const origin = request.headers.origin
      await runRelayRequest(
        serveTransfer({
          route: "browser.file",
          request,
          response,
          parent: traceParentSpan(url.searchParams.get("traceparent")),
          headers: () => (origin ? browserCorsHeaders(origin) : {}),
          program: serve(request, response, url, match[1] ?? ""),
        })
      )
      return true
    },
  }
}

const resolveFileRoot = Effect.fn("RelayTransfer.resolveFileRoot")(function* (
  options: BrowserFileTransferOptions,
  rootId: string
) {
  const source = (
    found: FileRootSource | undefined,
    id: string
  ): Effect.Effect<
    { filesystem: FilesystemDriver; root: FileRoot } | null,
    unknown
  > =>
    found
      ? Effect.tryPromise(() => found.root(id)).pipe(
          Effect.map((root) => ({ filesystem: found.filesystem, root }))
        )
      : Effect.succeed(null)
  if (isRelayFileRoot(rootId)) return yield* source(options.hostFiles, rootId)
  const appId = appIdFromFileRoot(rootId)
  if (appId) return yield* source(options.appFiles, appId)
  const databaseId = databaseIdFromFileRoot(rootId)
  if (databaseId) return yield* source(options.databaseFiles, databaseId)
  const instance = yield* Effect.tryPromise(() =>
    options.docker.findInstance(rootId)
  )
  return instance ? { filesystem: options.filesystem, root: instance } : null
})

function fileRootKind(rootId: string) {
  if (isRelayFileRoot(rootId)) return "relay"
  if (appIdFromFileRoot(rootId) !== null) return "app"
  if (databaseIdFromFileRoot(rootId) !== null) return "database"
  return "instance"
}

function browserFileAction(method: BrowserFileMethod, rootId: string) {
  return fileTransferAction(rootId, method === "PUT" ? "upload" : "download")
}

const readBrowserDownloadForm = Effect.fnUntraced(function* (
  request: IncomingMessage
) {
  if (
    !request.headers["content-type"]?.startsWith(
      "application/x-www-form-urlencoded"
    )
  ) {
    return yield* Effect.fail(new Error("Download request encoding is invalid"))
  }
  const body = yield* readBoundedBody(request, MAX_DOWNLOAD_FORM_BYTES)
  return yield* Effect.try((): BrowserDownloadForm => {
    const form = new URLSearchParams(body.toString("utf8"))
    const required = (name: string) => {
      const value = form.get(name)
      if (!value) throw new Error(`Download ${name} is missing`)
      return value
    }
    const compression = form.get("compression")
    if (
      compression !== "gzip" &&
      compression !== "none" &&
      compression !== "zip"
    ) {
      throw new Error("Download compression is invalid")
    }
    const path = required("path")
    const serializedPaths = form.get("archivePaths")
    const archivePaths = serializedPaths
      ? Schema.decodeUnknownSync(Schema.Array(Schema.String))(
          JSON.parse(serializedPaths)
        )
      : null
    if (archivePaths) {
      if (
        compression !== "zip" ||
        !archivePaths.length ||
        archivePaths.length > MAX_ARCHIVE_SELECTION_PATHS ||
        archivePaths.some(
          (archivePath) =>
            archivePath.length === 0 || archivePath.length > 2_048
        ) ||
        serializedPaths === null ||
        path !== archiveSelectionRequestPath(serializedPaths)
      ) {
        throw new Error("Download archive selection is invalid")
      }
    }
    return {
      archivePaths,
      compression,
      credentials: {
        authorization: required("authorization"),
        nonce: required("nonce"),
        proof: required("proof"),
        publicKey: required("publicKey"),
        requestedAt: required("requestedAt"),
      },
      name: required("name"),
      path,
    }
  })
})

// An archive's capability names the digest of its selection, since the
// selection itself is too long for the capability.
function archiveSelectionRequestPath(serializedPaths: string): string {
  return `@archive/${createHash("sha256").update(serializedPaths).digest("hex")}`
}

const preflightHeaders = {
  "Access-Control-Allow-Headers": [
    "Authorization",
    "Content-Type",
    "X-Kiln-Nonce",
    "X-Kiln-Proof",
    "X-Kiln-Public-Key",
    "X-Kiln-Requested-At",
  ].join(", "),
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
  "Access-Control-Max-Age": "600",
}

function browserCorsHeaders(
  origin: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": [
      "Content-Disposition",
      "Content-Length",
      "Content-Range",
      "Last-Modified",
      "X-Kiln-Compressed-Size-Estimate",
      "X-Kiln-Download-Max-Size",
      "X-Kiln-Gzip-Size-Estimate",
      "X-Kiln-Zip-Size-Estimate",
    ].join(", "),
    Vary: "Origin",
    ...extra,
  }
}

function asMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
