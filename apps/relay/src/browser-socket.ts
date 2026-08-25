import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto"
import { createReadStream } from "node:fs"
import type { ReadStream } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import type { Readable } from "node:stream"
import {
  constants as zlibConstants,
  createGzip,
  deflateRawSync,
  gzipSync,
} from "node:zlib"
import { Effect, Fiber, Option, Result, Schema } from "effect"
import { WebSocket, WebSocketServer } from "ws"
import * as Sentry from "@sentry/node"
import ZipStream from "zip-stream"

import {
  relayBrowserProofTranscript,
  relayBrowserRequestProofTranscript,
  relayBrowserConsoleProtocol,
  relayBrowserConsoleProtocols,
  relayBrowserProtocol,
  relayInstanceLifecycleEventTime as lifecycleEventTime,
} from "@workspace/contracts"
import type {
  RelayConsole,
  RelayConsoleLine,
  RelayInstanceLifecycleEvent,
} from "@workspace/contracts"
import {
  relayConsoleCommandSchema,
  relayConsoleCompletionInputSchema,
} from "@workspace/contracts"

import { MAX_CONSOLE_HISTORY_LINES, type DockerDriver } from "./docker.js"
import {
  encodeConsoleHistoryFrames,
  encodeConsoleLineFrame,
  encodeNewestConsoleBatch,
} from "./console-frames.js"
import { MAX_TRANSFER_BYTES } from "./files.js"
import type { ArchiveDownloadEntry, FilesystemDriver } from "./files.js"
import type { RelayInstanceConfig } from "./config.js"
import type { RelayIdentity } from "./effect/identity.js"
import { forkPromise } from "./effect/promise.js"
import type { RelayClientGrant, RelayStateStore } from "./effect/state.js"
import type { RelaySnapshotSample } from "./snapshot-hub.js"
import type { Server } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"

const AUTHENTICATION_WINDOW_MS = 10_000
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024
const HTTP_PROOF_WINDOW_MS = 30_000
const MAX_BROWSER_SESSIONS = 512
const MAX_DIRECT_TRANSFERS = 32
const MAX_DIRECT_TRANSFERS_PER_CLIENT = 8
const MAX_DOWNLOAD_FORM_BYTES = 2 * 1024 * 1024
const MAX_ARCHIVE_SELECTION_PATHS = 5_000
const COMPRESSION_SAMPLE_BYTES = 1024 * 1024

type BrowserFileMethod = "GET" | "HEAD" | "POST" | "PUT"

interface BrowserRequestCredentials {
  authorization: string
  nonce: string
  proof: string
  publicKey: string
  requestedAt: string
}

interface BrowserDownloadForm {
  archivePaths: ReadonlyArray<string> | null
  compression: DownloadCompression
  credentials: BrowserRequestCredentials
  name: string
  path: string
}

type DownloadCompression = "gzip" | "none" | "zip"

const BrowserAuthSchema = Schema.Struct({
  capability: Schema.String,
  publicKeyJwk: Schema.Struct({
    crv: Schema.Literal("P-256"),
    kty: Schema.Literal("EC"),
    x: Schema.String,
    y: Schema.String,
  }),
  signature: Schema.String,
  type: Schema.Literal("auth"),
  v: Schema.Literal(1),
})

const BrowserPublicKeySchema = BrowserAuthSchema.fields.publicKeyJwk

const BrowserSubscribeSchema = Schema.Struct({
  instanceId: Schema.String,
  type: Schema.Literal("console.subscribe"),
  v: Schema.Literal(1),
})

const BrowserResourceSubscribeSchema = Schema.Struct({
  instanceId: Schema.String,
  type: Schema.Literal("resource.subscribe"),
  v: Schema.Literal(1),
})

const BrowserConsoleWriteSchema = Schema.Struct({
  command: Schema.String,
  instanceId: Schema.String,
  requestId: Schema.String,
  type: Schema.Literal("console.write"),
  v: Schema.Literal(1),
})

const BrowserConsoleCompleteSchema = Schema.Struct({
  cursor: Schema.Number,
  input: Schema.String,
  instanceId: Schema.String,
  requestId: Schema.String,
  type: Schema.Literal("console.complete"),
  v: Schema.Literal(1),
})

const decodeBrowserMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown)
)
const decodeBrowserSubscription = Schema.decodeUnknownOption(
  BrowserSubscribeSchema
)
const decodeBrowserResourceSubscription = Schema.decodeUnknownOption(
  BrowserResourceSubscribeSchema
)
const decodeBrowserConsoleWrite = Schema.decodeUnknownOption(
  BrowserConsoleWriteSchema
)
const decodeBrowserConsoleComplete = Schema.decodeUnknownOption(
  BrowserConsoleCompleteSchema
)

const CapabilitySchema = Schema.Struct({
  actions: Schema.Array(Schema.String),
  audience: Schema.String,
  capabilityId: Schema.String,
  expiresAt: Schema.Number,
  instanceId: Schema.String,
  issuedAt: Schema.Number,
  issuer: Schema.String,
  keyThumbprint: Schema.String,
  origin: Schema.String,
  path: Schema.NullOr(Schema.String),
  subject: Schema.String,
  version: Schema.Literal(1),
})

type BrowserCapability = typeof CapabilitySchema.Type

export interface BrowserSocketOptions {
  readonly docker: DockerDriver
  readonly filesystem: FilesystemDriver
  readonly identity: RelayIdentity
  readonly runEffect: <T, E>(effect: Effect.Effect<T, E>) => Promise<T>
  readonly server: Server
  readonly state: RelayStateStore["Service"]
  readonly subscribeSnapshots: (
    listener: (sample: RelaySnapshotSample) => void
  ) => () => void
}

export interface BrowserSocketServer {
  readonly close: () => Promise<void>
  readonly handleRequest: (
    request: IncomingMessage,
    response: ServerResponse
  ) => Promise<boolean>
  readonly revokeClient: (clientId: string) => void
}

export function attachBrowserSocket(
  options: BrowserSocketOptions
): BrowserSocketServer {
  const sockets = new Set<WebSocket>()
  const socketIssuers = new Map<WebSocket, string>()
  const requestProofs = new Map<string, number>()
  const pendingRequestProofs = new Set<string>()
  const transfers = { active: 0, byClient: new Map<string, number>() }
  const hubs = new ConsoleHubRegistry(
    options.docker,
    options.subscribeSnapshots
  )
  const resourceHubs = new ResourceHubRegistry(
    options.docker,
    options.subscribeSnapshots
  )
  const wss = new WebSocketServer({
    clientTracking: false,
    handleProtocols: (protocols) => {
      if (protocols.has(relayBrowserConsoleProtocol)) {
        return relayBrowserConsoleProtocol
      }
      return protocols.has(relayBrowserProtocol) ? relayBrowserProtocol : false
    },
    maxPayload: 64 * 1024,
    noServer: true,
    perMessageDeflate: false,
  })

  options.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://relay")
    if (url.pathname !== "/v1/browser") return
    const requestedProtocols = parseProtocols(
      request.headers["sec-websocket-protocol"]
    )
    if (
      !relayBrowserConsoleProtocols.some((protocol) =>
        requestedProtocols.includes(protocol)
      )
    ) {
      socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request)
    })
  })

  wss.on("connection", (socket, request) => {
    if (sockets.size >= MAX_BROWSER_SESSIONS) {
      socket.close(1013, "Relay browser session capacity reached")
      return
    }
    const origin = request.headers.origin
    if (!origin) {
      socket.close(4403, "Browser origin is required")
      return
    }
    sockets.add(socket)
    authenticateBrowser(
      socket,
      origin,
      options,
      hubs,
      resourceHubs,
      (clientId) => {
        socketIssuers.set(socket, clientId)
      }
    )
    socket.once("close", () => {
      sockets.delete(socket)
      socketIssuers.delete(socket)
      hubs.remove(socket)
      resourceHubs.remove(socket)
    })
  })

  return {
    close: async () => {
      hubs.close()
      resourceHubs.close()
      await closeSockets(sockets, "Relay shutting down")
      await Effect.runPromise(closeWebSocketServerEffect(wss))
    },
    handleRequest: (request, response) =>
      handleBrowserFileRequest(
        request,
        response,
        options,
        pendingRequestProofs,
        requestProofs,
        transfers
      ),
    revokeClient: (clientId) => {
      for (const [socket, issuer] of socketIssuers) {
        if (issuer === clientId) socket.close(4403, "Capability issuer changed")
      }
    },
  }
}

function authenticateBrowser(
  socket: WebSocket,
  origin: string,
  options: BrowserSocketOptions,
  hubs: ConsoleHubRegistry,
  resourceHubs: ResourceHubRegistry,
  onAuthenticated: (clientId: string) => void
): void {
  const challenge = {
    expiresAt: Date.now() + AUTHENTICATION_WINDOW_MS,
    nonce: randomBytes(32).toString("base64url"),
    relayId: options.identity.fingerprint,
    sessionId: randomUUID(),
    type: "auth.challenge",
    v: 1,
  }
  send(socket, challenge)
  let capability: BrowserCapability | null = null
  const timer = setTimeout(() => {
    if (!capability) socket.close(4401, "Browser authentication timed out")
  }, AUTHENTICATION_WINDOW_MS)
  timer.unref()

  socket.on("message", (data, binary) => {
    if (binary) {
      socket.close(4400, "Binary browser frames are not supported")
      return
    }
    const input = decodeBrowserMessage(data.toString())
    if (Option.isNone(input)) {
      socket.close(4400, "Invalid browser message")
      return
    }
    if (!capability) {
      forkPromise(
        () => authenticate(input.value),
        () => socket.close(4401, "Browser authentication failed")
      )
      return
    }
    const consoleSubscription = decodeBrowserSubscription(input.value)
    if (Option.isSome(consoleSubscription)) {
      const subscription = consoleSubscription.value
      if (
        subscription.instanceId !== capability.instanceId ||
        !capability.actions.includes("instance.console.read")
      ) {
        socket.close(4403, "Console capability does not allow this instance")
        return
      }
      forkPromise(
        () => hubs.subscribe(socket, subscription.instanceId),
        () => socket.close(4500, "Console stream failed")
      )
      return
    }
    const resourceSubscription = decodeBrowserResourceSubscription(input.value)
    if (Option.isSome(resourceSubscription)) {
      const subscription = resourceSubscription.value
      if (
        subscription.instanceId !== capability.instanceId ||
        !capability.actions.includes("instance.read")
      ) {
        socket.close(4403, "Resource capability does not allow this instance")
        return
      }
      resourceHubs.subscribe(socket, subscription.instanceId)
      return
    }
    const consoleWrite = decodeBrowserConsoleWrite(input.value)
    if (Option.isSome(consoleWrite)) {
      const request = consoleWrite.value
      if (
        request.instanceId !== capability.instanceId ||
        !capability.actions.includes("instance.console.write")
      ) {
        socket.close(4403, "Console capability does not allow writes")
        return
      }
      void executeConsoleWrite(socket, request, options, capability)
      return
    }
    const consoleCompletion = decodeBrowserConsoleComplete(input.value)
    if (Option.isSome(consoleCompletion)) {
      const request = consoleCompletion.value
      if (
        request.instanceId !== capability.instanceId ||
        !capability.actions.includes("instance.console.write")
      ) {
        socket.close(4403, "Console capability does not allow completion")
        return
      }
      void executeConsoleCompletion(socket, request, options.docker)
      return
    }
    socket.close(4400, "Invalid browser operation")
  })

  socket.once("close", () => {
    clearTimeout(timer)
  })

  async function authenticate(value: unknown): Promise<void> {
    if (Date.now() > challenge.expiresAt || capability) {
      throw new Error("Browser challenge expired")
    }
    const auth = Schema.decodeUnknownSync(BrowserAuthSchema)(value)
    const parsed = decodeCapability(auth.capability)
    const client = await options.runEffect(
      options.state.findClientById(parsed.payload.issuer)
    )
    if (!client) throw new Error("Capability issuer was revoked")
    validateCapability(
      parsed,
      client,
      origin,
      options.identity.fingerprint,
      null
    )
    if (
      browserKeyThumbprint(auth.publicKeyJwk) !== parsed.payload.keyThumbprint
    ) {
      throw new Error("Browser key does not match capability")
    }
    const browserKey = createPublicKey({
      format: "jwk",
      key: auth.publicKeyJwk,
    })
    const validProof = verify(
      "sha256",
      Buffer.from(
        relayBrowserProofTranscript(
          {
            capabilityId: parsed.payload.capabilityId,
            expiresAt: challenge.expiresAt,
            nonce: challenge.nonce,
            relayId: challenge.relayId,
            sessionId: challenge.sessionId,
          },
          socket.protocol === relayBrowserConsoleProtocol
            ? relayBrowserConsoleProtocol
            : relayBrowserProtocol
        )
      ),
      { dsaEncoding: "ieee-p1363", key: browserKey },
      Buffer.from(auth.signature, "base64url")
    )
    if (!validProof) throw new Error("Browser proof is invalid")
    capability = parsed.payload
    onAuthenticated(client.id)
    clearTimeout(timer)
    // The short-lived capability limits replay during session establishment.
    // Once proof-of-possession succeeds, the authenticated socket remains valid
    // until it disconnects or its issuing Hearth identity is revoked.
    send(socket, {
      expiresAt: capability.expiresAt,
      instanceId: capability.instanceId,
      type: "auth.ready",
      v: 1,
    })
  }
}

async function executeConsoleWrite(
  socket: WebSocket,
  request: typeof BrowserConsoleWriteSchema.Type,
  options: BrowserSocketOptions,
  capability: BrowserCapability
): Promise<void> {
  await runBrowser(
    browserOperation(async () => {
      const instance = await options.docker.findInstance(request.instanceId)
      if (!instance) throw new Error("Instance not found")
      const input = relayConsoleCommandSchema.parse({
        command: request.command,
      })
      await options.docker.sendCommand(instance, input.command)
      void auditBrowserConsoleWrite(options, capability, instance.id)
      send(socket, {
        operation: "console.write",
        payload: { accepted: true, command: input.command },
        requestId: request.requestId,
        type: "operation.result",
      })
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          send(socket, {
            code: "console_write_failed",
            message: "Command could not be sent",
            requestId: request.requestId,
            type: "operation.error",
          })
        })
      )
    )
  )
}

async function auditBrowserConsoleWrite(
  options: BrowserSocketOptions,
  capability: BrowserCapability,
  instanceId: string
): Promise<void> {
  await runBrowser(
    browserOperation(() =>
      options.runEffect(
        options.state.appendAudit({
          clientId: capability.issuer,
          details: {
            instanceId,
            permission: "instance.console.write",
            subject: capability.subject,
          },
          event: "browser.console.write",
          id: randomUUID(),
          occurredAt: Date.now(),
          requestId: capability.capabilityId,
        })
      )
    ).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          Sentry.captureException(cause, {
            tags: { "kiln.operation": "browser.console.audit" },
          })
        })
      )
    )
  )
}

async function executeConsoleCompletion(
  socket: WebSocket,
  request: typeof BrowserConsoleCompleteSchema.Type,
  docker: DockerDriver
): Promise<void> {
  await runBrowser(
    browserOperation(async () => {
      const instance = await docker.findInstance(request.instanceId)
      if (!instance) throw new Error("Instance not found")
      const input = relayConsoleCompletionInputSchema.parse(request)
      const payload = await docker.completeCommand(
        instance,
        input.input,
        input.cursor
      )
      send(socket, {
        operation: "console.complete",
        payload,
        requestId: request.requestId,
        type: "operation.result",
      })
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          send(socket, {
            code: "console_completion_failed",
            message: "Completions are unavailable",
            requestId: request.requestId,
            type: "operation.error",
          })
        })
      )
    )
  )
}

function decodeCapability(value: string): {
  encoded: string
  payload: BrowserCapability
  signature: string
} {
  const [encoded, signature, extra] = value.split(".")
  if (!encoded || !signature || extra) throw new Error("Invalid capability")
  return {
    encoded,
    payload: Schema.decodeUnknownSync(CapabilitySchema)(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown
    ),
    signature,
  }
}

function validateCapability(
  capability: ReturnType<typeof decodeCapability>,
  client: RelayClientGrant,
  origin: string,
  relayId: string,
  requiredAction: string | null
): void {
  if (
    capability.payload.audience !== relayId ||
    capability.payload.expiresAt <= Date.now() ||
    capability.payload.issuedAt > Date.now() + 5_000 ||
    capability.payload.origin !== origin ||
    !client.origins.includes(origin) ||
    capability.payload.actions.length === 0 ||
    (requiredAction !== null && !client.actions.includes(requiredAction)) ||
    (requiredAction !== null &&
      !capability.payload.actions.includes(requiredAction)) ||
    capability.payload.actions.some(
      (action) => !client.actions.includes(action)
    ) ||
    !verify(
      null,
      Buffer.from(capability.encoded),
      client.publicKey,
      Buffer.from(capability.signature, "base64url")
    )
  ) {
    throw new Error("Browser capability is invalid")
  }
}

async function handleBrowserFileRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: BrowserSocketOptions,
  pendingRequestProofs: Set<string>,
  requestProofs: Map<string, number>,
  transfers: { active: number; byClient: Map<string, number> }
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://relay")
  const match = url.pathname.match(/^\/v1\/browser\/files\/([^/]+)$/u)
  if (!match) return false
  const origin = request.headers.origin
  if (!origin) {
    browserJson(response, 403, { error: "Browser origin is required" })
    return true
  }
  if (request.method === "OPTIONS") {
    const clients = await options.runEffect(options.state.listClients())
    if (!clients.some((client) => client.origins.includes(origin))) {
      browserJson(response, 403, { error: "Browser origin is not paired" })
      return true
    }
    response
      .writeHead(
        204,
        browserCorsHeaders(origin, {
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
        })
      )
      .end()
    return true
  }
  const method = request.method
  if (
    method !== "GET" &&
    method !== "HEAD" &&
    method !== "POST" &&
    method !== "PUT"
  ) {
    browserJson(response, 405, { error: "Method not allowed" }, origin)
    return true
  }
  const decodedInstanceId = Result.try(() => decodeURIComponent(match[1]))
  if (Result.isFailure(decodedInstanceId)) {
    browserJson(response, 400, { error: "Instance path is invalid" }, origin)
    return true
  }
  const instanceId = decodedInstanceId.success
  let downloadForm: BrowserDownloadForm | null = null
  if (method === "POST") {
    const parsedForm = await runBrowser(
      browserOperation(() => readBrowserDownloadForm(request)).pipe(
        Effect.option
      )
    )
    if (Option.isNone(parsedForm)) {
      browserJson(
        response,
        400,
        { error: "Download request is invalid" },
        origin
      )
      return true
    }
    downloadForm = parsedForm.value
  }
  const path = downloadForm?.path ?? url.searchParams.get("path") ?? ""
  const authenticated = await runBrowser(
    browserOperation(() =>
      authenticateBrowserRequest({
        instanceId,
        method,
        options,
        origin,
        path,
        request,
        ...(downloadForm ? { credentials: downloadForm.credentials } : {}),
        pendingRequestProofs,
        requestProofs,
      })
    ).pipe(Effect.option)
  )
  if (Option.isNone(authenticated)) {
    browserJson(
      response,
      401,
      { error: "Browser capability is invalid" },
      origin
    )
    return true
  }
  const authentication = authenticated.value

  const clientId = authentication.clientId
  const clientTransfers = transfers.byClient.get(clientId) ?? 0
  if (
    transfers.active >= MAX_DIRECT_TRANSFERS ||
    clientTransfers >= MAX_DIRECT_TRANSFERS_PER_CLIENT
  ) {
    browserJson(
      response,
      429,
      { error: "Relay file transfer capacity reached" },
      origin
    )
    return true
  }
  transfers.active += 1
  transfers.byClient.set(clientId, clientTransfers + 1)

  await runBrowser(
    browserOperation(async () => {
      const instance = await options.docker.findInstance(instanceId)
      if (!instance) {
        browserJson(response, 404, { error: "Instance not found" }, origin)
        return
      }
      if (method === "PUT") {
        const uploaded = await options.runEffect(
          options.filesystem.upload(instance, path, request)
        )
        void auditBrowserTransfer(
          options,
          authentication,
          method,
          uploaded.size
        )
        browserJson(response, 200, uploaded, origin)
        return
      }
      if (downloadForm?.archivePaths) {
        await options.runEffect(
          options.filesystem.withArchiveDownload(
            instance,
            downloadForm.archivePaths,
            (entries) =>
              Effect.tryPromise({
                try: async () => {
                  const downloadName = normalizedDownloadName(
                    downloadForm.name,
                    "files.zip"
                  )
                  response.writeHead(
                    200,
                    browserCorsHeaders(origin, {
                      "Cache-Control": "no-store",
                      "Content-Disposition": contentDisposition(downloadName),
                      "Content-Type": "application/zip",
                      "X-Content-Type-Options": "nosniff",
                      "X-Kiln-Download-Max-Size": String(MAX_TRANSFER_BYTES),
                    })
                  )
                  const result = await streamArchiveDownload(entries, response)
                  void auditBrowserTransfer(
                    options,
                    authentication,
                    method,
                    result.bytes,
                    result.completed ? "completed" : "aborted"
                  )
                },
                catch: (cause) => cause,
              })
          )
        )
        return
      }
      await options.runEffect(
        options.filesystem.withDownload(instance, path, (download) =>
          Effect.tryPromise({
            try: async () => {
              const compression = downloadForm?.compression ?? "none"
              const range = parseRange(request.headers.range, download.size)
              if (compression !== "none" && range) {
                throw new Error("Compressed downloads do not support ranges")
              }
              const estimatedCompressedSizes =
                method === "HEAD"
                  ? await estimateCompressedSizes(
                      download.file,
                      download.name,
                      download.size
                    )
                  : null
              const downloadName = normalizedDownloadName(
                downloadForm?.name,
                compression === "zip"
                  ? `${download.name}.zip`
                  : compression === "gzip"
                    ? `${download.name}.gz`
                    : download.name
              )
              const headers = browserCorsHeaders(origin, {
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
                ...(estimatedCompressedSizes === null
                  ? {}
                  : {
                      "X-Kiln-Compressed-Size-Estimate": String(
                        estimatedCompressedSizes.zip
                      ),
                      "X-Kiln-Gzip-Size-Estimate": String(
                        estimatedCompressedSizes.gzip
                      ),
                      "X-Kiln-Zip-Size-Estimate": String(
                        estimatedCompressedSizes.zip
                      ),
                    }),
              })
              if (range) {
                headers["Content-Range"] =
                  `bytes ${range.start}-${range.end}/${download.size}`
              }
              response.writeHead(range ? 206 : 200, headers)
              if (method === "HEAD") {
                response.end()
                void auditBrowserTransfer(
                  options,
                  authentication,
                  method,
                  0,
                  "completed"
                )
                return
              }
              const streamOptions = range
                ? { autoClose: false, end: range.end, start: range.start }
                : { autoClose: false }
              const result = await streamDownload(
                download.file.createReadStream(streamOptions),
                response,
                compression,
                download.name,
                download.size
              )
              void auditBrowserTransfer(
                options,
                authentication,
                method,
                result.bytes,
                result.completed ? "completed" : "aborted"
              )
            },
            catch: (cause) => cause,
          })
        )
      )
    }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          Sentry.captureException(cause, {
            tags: {
              "kiln.operation":
                method === "PUT"
                  ? "browser.file.upload"
                  : "browser.file.download",
              "kiln.relay_id": options.identity.fingerprint,
            },
          })
          if (response.headersSent) {
            response.destroy(cause instanceof Error ? cause : undefined)
          } else {
            browserJson(
              response,
              400,
              { error: safeBrowserError(cause) },
              origin
            )
          }
        })
      ),
      Effect.ensuring(
        Effect.sync(() => {
          transfers.active -= 1
          const remaining = (transfers.byClient.get(clientId) ?? 1) - 1
          if (remaining > 0) transfers.byClient.set(clientId, remaining)
          else transfers.byClient.delete(clientId)
        })
      )
    )
  )
  return true
}

async function authenticateBrowserRequest(input: {
  credentials?: BrowserRequestCredentials
  instanceId: string
  method: BrowserFileMethod
  options: BrowserSocketOptions
  origin: string
  path: string
  request: IncomingMessage
  pendingRequestProofs: Set<string>
  requestProofs: Map<string, number>
}): Promise<{
  capabilityId: string
  clientId: string
  instanceId: string
  subject: string
}> {
  const authorization =
    input.credentials?.authorization ?? header(input.request, "authorization")
  if (!authorization.startsWith("Kiln ")) throw new Error("Missing capability")
  const parsed = decodeCapability(authorization.slice(5))
  const requiredAction =
    input.method === "PUT" ? "instance.files.upload" : "instance.files.download"
  const publicKeyJwk = Schema.decodeUnknownSync(BrowserPublicKeySchema)(
    JSON.parse(
      Buffer.from(
        input.credentials?.publicKey ??
          header(input.request, "x-kiln-public-key"),
        "base64url"
      ).toString("utf8")
    ) as unknown
  )
  if (browserKeyThumbprint(publicKeyJwk) !== parsed.payload.keyThumbprint) {
    throw new Error("Browser key does not match capability")
  }
  const requestedAt = Number(
    input.credentials?.requestedAt ??
      header(input.request, "x-kiln-requested-at")
  )
  const nonce =
    input.credentials?.nonce ?? header(input.request, "x-kiln-nonce")
  if (
    !Number.isSafeInteger(requestedAt) ||
    Math.abs(Date.now() - requestedAt) > HTTP_PROOF_WINDOW_MS ||
    Buffer.from(nonce, "base64url").length < 16
  )
    throw new Error("Browser proof freshness is invalid")
  for (const [key, expiresAt] of input.requestProofs) {
    if (expiresAt <= Date.now()) input.requestProofs.delete(key)
  }
  const replayKey = `${parsed.payload.capabilityId}:${nonce}`
  if (
    input.requestProofs.has(replayKey) ||
    input.pendingRequestProofs.has(replayKey)
  )
    throw new Error("Browser proof was replayed")
  input.pendingRequestProofs.add(replayKey)
  return runBrowser(
    browserOperation(async () => {
      const client = await input.options.runEffect(
        input.options.state.findClientById(parsed.payload.issuer)
      )
      if (!client) throw new Error("Capability issuer was revoked")
      validateCapability(
        parsed,
        client,
        input.origin,
        input.options.identity.fingerprint,
        requiredAction
      )
      if (
        parsed.payload.instanceId !== input.instanceId ||
        parsed.payload.path !== input.path
      ) {
        throw new Error("Capability scope does not match the file")
      }

      const browserKey = createPublicKey({ format: "jwk", key: publicKeyJwk })
      const proof = Buffer.from(
        input.credentials?.proof ?? header(input.request, "x-kiln-proof"),
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
            relayId: input.options.identity.fingerprint,
            requestedAt,
          })
        ),
        { dsaEncoding: "ieee-p1363", key: browserKey },
        proof
      )
      if (!valid) throw new Error("Browser request proof is invalid")
      input.requestProofs.set(replayKey, parsed.payload.expiresAt)
      return {
        capabilityId: parsed.payload.capabilityId,
        clientId: client.id,
        instanceId: parsed.payload.instanceId,
        subject: parsed.payload.subject,
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => input.pendingRequestProofs.delete(replayKey))
      )
    )
  )
}

async function auditBrowserTransfer(
  options: BrowserSocketOptions,
  authentication: {
    capabilityId: string
    clientId: string
    instanceId: string
    subject: string
  },
  method: BrowserFileMethod,
  bytes: number,
  outcome: "aborted" | "completed" = "completed"
): Promise<void> {
  await runBrowser(
    browserOperation(() =>
      options.runEffect(
        options.state.appendAudit({
          clientId: authentication.clientId,
          details: {
            bytes,
            instanceId: authentication.instanceId,
            method,
            outcome,
            permission:
              method === "PUT"
                ? "instance.files.upload"
                : "instance.files.download",
            subject: authentication.subject,
          },
          event:
            method === "PUT" ? "browser.file.upload" : "browser.file.download",
          id: randomUUID(),
          occurredAt: Date.now(),
          requestId: authentication.capabilityId,
        })
      )
    ).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          Sentry.captureException(cause, {
            tags: { "kiln.operation": "browser.file.audit" },
          })
        })
      )
    )
  )
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name]
  if (typeof value !== "string" || !value || value.length > 8_192) {
    throw new Error(`${name} header is invalid`)
  }
  return value
}

function runBrowser<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect)
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

function browserJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  origin?: string
): void {
  if (response.destroyed || response.writableEnded) return
  response
    .writeHead(status, {
      ...(origin ? browserCorsHeaders(origin) : {}),
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    })
    .end(JSON.stringify(value))
}

export function parseRange(
  value: string | undefined,
  size: number
): { end: number; start: number } | null {
  if (!value) return null
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error("Requested byte range is invalid")
  }
  const match = value.match(/^bytes=(\d*)-(\d*)$/u)
  if (!match) throw new Error("Only a single byte range is supported")
  if (!match[1] && !match[2]) throw new Error("Requested byte range is invalid")
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new Error("Requested byte range is invalid")
    }
    return { end: size - 1, start: Math.max(0, size - suffixLength) }
  }
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  const end = Math.min(requestedEnd, size - 1)
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    throw new Error("Requested byte range is invalid")
  }
  return { end, start }
}

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^A-Za-z0-9._-]/gu, "_") || "download"
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function normalizedDownloadName(
  requestedName: string | undefined,
  fallback: string
): string {
  const name = requestedName?.trim() || fallback
  if (
    name.length > 255 ||
    name === "." ||
    name === ".." ||
    Array.from(name).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return (
        codePoint < 32 ||
        codePoint === 127 ||
        character === "/" ||
        character === "\\"
      )
    })
  ) {
    throw new Error("Download name is invalid")
  }
  return name
}

async function readBrowserDownloadForm(
  request: IncomingMessage
): Promise<BrowserDownloadForm> {
  if (
    !request.headers["content-type"]?.startsWith(
      "application/x-www-form-urlencoded"
    )
  ) {
    throw new Error("Download request encoding is invalid")
  }
  const chunks: Array<Buffer> = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > MAX_DOWNLOAD_FORM_BYTES) {
      throw new Error("Download request is too large")
    }
    chunks.push(bytes)
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"))
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
        (archivePath) => archivePath.length === 0 || archivePath.length > 2_048
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
}

function archiveSelectionRequestPath(serializedPaths: string): string {
  return `@archive/${createHash("sha256").update(serializedPaths).digest("hex")}`
}

async function estimateCompressedSizes(
  file: FileHandle,
  name: string,
  size: number
): Promise<{ gzip: number; zip: number }> {
  const sampleSize = Math.min(size, COMPRESSION_SAMPLE_BYTES)
  const zipOverhead =
    114 + Buffer.byteLength(name) * 2 + (size > 0xffffffff ? 98 : 0)
  if (sampleSize === 0) {
    const gzip = gzipSync(Buffer.alloc(0), {
      level: zlibConstants.Z_BEST_SPEED,
    }).byteLength
    return { gzip, zip: zipOverhead }
  }
  const sample = Buffer.allocUnsafe(sampleSize)
  const { bytesRead } = await file.read(sample, 0, sampleSize, 0)
  if (bytesRead === 0) {
    const gzip = gzipSync(Buffer.alloc(0), {
      level: zlibConstants.Z_BEST_SPEED,
    }).byteLength
    return { gzip, zip: zipOverhead }
  }
  const contents = sample.subarray(0, bytesRead)
  const gzipSize = gzipSync(contents, {
    level: zlibConstants.Z_BEST_SPEED,
  }).byteLength
  const zipSize = deflateRawSync(contents, {
    level: zlibConstants.Z_BEST_SPEED,
  }).byteLength
  return {
    gzip: Math.ceil((gzipSize / bytesRead) * size),
    zip: Math.ceil((zipSize / bytesRead) * size) + zipOverhead,
  }
}

function streamDownload(
  stream: ReadStream,
  response: ServerResponse,
  compression: DownloadCompression,
  entryName: string,
  size: number
): Promise<{ bytes: number; completed: boolean }> {
  return new Promise((resolveStream, reject) => {
    const archive =
      compression === "zip"
        ? new ZipStream({
            forceZip64: size > 0xffffffff,
            zlib: { level: zlibConstants.Z_BEST_SPEED },
          })
        : null
    const output: Readable = archive
      ? archive
      : compression === "gzip"
        ? stream.pipe(createGzip({ level: zlibConstants.Z_BEST_SPEED }))
        : stream
    let bytes = 0
    let settled = false
    const cleanup = () => {
      stream.off("error", failed)
      if (output !== stream) output.off("error", failed)
      output.off("data", received)
      response.off("finish", finished)
      response.off("close", closed)
    }
    const received = (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk)
    }
    const failed = (cause: Error) => {
      if (settled) return
      settled = true
      cleanup()
      stream.destroy()
      if (output !== stream) output.destroy()
      if (!response.destroyed) response.destroy(cause)
      reject(cause)
    }
    const finished = () => {
      if (settled) return
      settled = true
      cleanup()
      resolveStream({ bytes, completed: true })
    }
    const closed = () => {
      if (settled) return
      settled = true
      stream.destroy()
      archive?.destroy()
      if (output !== stream) output.destroy()
      cleanup()
      resolveStream({ bytes, completed: false })
    }
    stream.once("error", failed)
    if (output !== stream) output.once("error", failed)
    output.on("data", received)
    response.once("finish", finished)
    response.once("close", closed)
    output.pipe(response)
    if (archive) {
      archive.entry(stream, { name: entryName }, (cause) => {
        if (cause) failed(cause)
        else if (!settled) archive.finalize()
      })
    }
  })
}

function streamArchiveDownload(
  entries: ReadonlyArray<ArchiveDownloadEntry>,
  response: ServerResponse
): Promise<{ bytes: number; completed: boolean }> {
  return new Promise((resolveStream, reject) => {
    const archive = new ZipStream({
      forceZip64: entries.some((entry) => entry.size > 0xffffffff),
      zlib: { level: zlibConstants.Z_BEST_SPEED },
    })
    let activeSource: ReturnType<typeof createReadStream> | null = null
    let bytes = 0
    let settled = false
    const cleanup = () => {
      archive.off("error", failed)
      archive.off("data", received)
      response.off("finish", finished)
      response.off("close", closed)
      activeSource?.off("error", failed)
    }
    const complete = (completed: boolean) => {
      if (settled) return
      settled = true
      cleanup()
      resolveStream({ bytes, completed })
    }
    const failed = (cause: Error) => {
      if (settled) return
      settled = true
      activeSource?.destroy()
      archive.destroy()
      cleanup()
      if (!response.destroyed) response.destroy(cause)
      reject(cause)
    }
    const received = (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk)
    }
    const finished = () => complete(true)
    const closed = () => {
      activeSource?.destroy()
      archive.destroy()
      complete(false)
    }
    archive.once("error", failed)
    archive.on("data", received)
    response.once("finish", finished)
    response.once("close", closed)
    archive.pipe(response)

    const append = (index: number) => {
      if (settled) return
      const entry = entries[index]
      if (!entry) {
        archive.finalize()
        return
      }
      if (entry.kind === "directory") {
        archive.entry(null, { name: `${entry.name}/` }, (cause) => {
          if (cause) failed(cause)
          else append(index + 1)
        })
        return
      }
      const source = createReadStream(entry.absolute)
      activeSource = source
      source.once("error", failed)
      archive.entry(source, { name: entry.name }, (cause) => {
        source.off("error", failed)
        activeSource = null
        if (cause) failed(cause)
        else append(index + 1)
      })
    }
    append(0)
  })
}

function safeBrowserError(cause: unknown): string {
  if (!cause || typeof cause !== "object" || !("message" in cause)) {
    return "File transfer failed"
  }
  const message = cause.message
  return typeof message === "string" && message.length <= 200
    ? message
    : "File transfer failed"
}

class ConsoleHubRegistry {
  readonly #docker: DockerDriver
  readonly #hubs = new Map<string, ConsoleHub>()
  readonly #pendingHubs = new Map<string, Fiber.Fiber<ConsoleHub, Error>>()
  readonly #subscribeSnapshots: BrowserSocketOptions["subscribeSnapshots"]
  readonly #subscriptions = new Map<WebSocket, string>()

  constructor(
    docker: DockerDriver,
    subscribeSnapshots: BrowserSocketOptions["subscribeSnapshots"]
  ) {
    this.#docker = docker
    this.#subscribeSnapshots = subscribeSnapshots
  }

  subscribe(socket: WebSocket, instanceId: string): Promise<void> {
    this.remove(socket)
    this.#subscriptions.set(socket, instanceId)
    let hubEffect: Effect.Effect<ConsoleHub, Error>
    const existingHub = this.#hubs.get(instanceId)
    if (existingHub) {
      hubEffect = Effect.succeed(existingHub)
    } else {
      let pending = this.#pendingHubs.get(instanceId)
      if (!pending) {
        pending = Effect.runFork(this.#createHubEffect(instanceId))
        this.#pendingHubs.set(instanceId, pending)
      }
      hubEffect = Fiber.join(pending).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.#pendingHubs.get(instanceId) === pending) {
              this.#pendingHubs.delete(instanceId)
            }
          })
        )
      )
    }
    return Effect.runPromise(
      hubEffect.pipe(
        Effect.tap((hub) =>
          Effect.sync(() => {
            if (
              this.#subscriptions.get(socket) !== instanceId ||
              socket.readyState !== WebSocket.OPEN
            ) {
              const hasWaitingSubscriber = [
                ...this.#subscriptions.values(),
              ].some(
                (subscribedInstanceId) => subscribedInstanceId === instanceId
              )
              if (hub.subscriberCount === 0 && !hasWaitingSubscriber) {
                hub.close()
              }
              return
            }
            hub.add(socket)
          })
        ),
        Effect.asVoid
      )
    )
  }

  remove(socket: WebSocket): void {
    const instanceId = this.#subscriptions.get(socket)
    if (!instanceId) return
    this.#subscriptions.delete(socket)
    this.#hubs.get(instanceId)?.remove(socket)
  }

  close(): void {
    for (const pending of this.#pendingHubs.values()) {
      pending.interruptUnsafe()
    }
    this.#pendingHubs.clear()
    for (const hub of this.#hubs.values()) hub.close()
    this.#hubs.clear()
    this.#subscriptions.clear()
  }

  #createHubEffect(instanceId: string): Effect.Effect<ConsoleHub, Error> {
    return browserOperation(() => this.#docker.findInstance(instanceId)).pipe(
      Effect.flatMap((instance) => {
        if (!instance) return Effect.fail(new Error("Instance not found"))
        return Effect.sync(() => {
          const hub = new ConsoleHub(
            this.#docker,
            instance,
            this.#subscribeSnapshots,
            () => {
              if (hub.subscriberCount === 0) this.#hubs.delete(instanceId)
            }
          )
          this.#hubs.set(instanceId, hub)
          return hub
        })
      })
    )
  }
}

class ResourceHubRegistry {
  readonly #docker: DockerDriver
  readonly #historyDelivered = new Set<WebSocket>()
  readonly #subscribeSnapshots: BrowserSocketOptions["subscribeSnapshots"]
  readonly #subscriptions = new Map<WebSocket, string>()
  #unsubscribe: (() => void) | null = null

  constructor(
    docker: DockerDriver,
    subscribeSnapshots: BrowserSocketOptions["subscribeSnapshots"]
  ) {
    this.#docker = docker
    this.#subscribeSnapshots = subscribeSnapshots
  }

  subscribe(socket: WebSocket, instanceId: string): void {
    this.#subscriptions.set(socket, instanceId)
    this.#unsubscribe ??= this.#subscribeSnapshots((sample) => {
      const byId = new Map(
        sample.snapshot.instances.map((instance) => [instance.id, instance])
      )
      for (const [subscriber, subscribedInstanceId] of this.#subscriptions) {
        const instance = byId.get(subscribedInstanceId)
        if (instance) {
          const includeHistory = !this.#historyDelivered.has(subscriber)
          send(subscriber, {
            history: includeHistory
              ? this.#docker.resourceHistory(instance.id)
              : [],
            instance,
            sequence: sample.sequence,
            type: "resource",
          })
          this.#historyDelivered.add(subscriber)
        }
      }
    })
  }

  remove(socket: WebSocket): void {
    this.#subscriptions.delete(socket)
    this.#historyDelivered.delete(socket)
    if (this.#subscriptions.size === 0) {
      this.#unsubscribe?.()
      this.#unsubscribe = null
    }
  }

  close(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#subscriptions.clear()
    this.#historyDelivered.clear()
  }
}

class ConsoleHub {
  readonly #abort = new AbortController()
  readonly #backgroundFibers = new Set<Fiber.Fiber<void, never>>()
  readonly #docker: DockerDriver
  readonly #instance: RelayInstanceConfig
  readonly #lineIds = new Set<string>()
  readonly #onEmpty: () => void
  readonly #recent: Array<RelayConsoleLine> = []
  readonly #subscribers = new Set<WebSocket>()
  #backfillStartedAt: string | null | undefined
  #closed = false
  #graceFiber: Fiber.Fiber<void, never> | null = null
  #sessionFloor: string | null = null
  #sessionLifecycle: Array<RelayInstanceLifecycleEvent> | undefined
  #streamFiber: Fiber.Fiber<void, never> | null = null
  #transitionStartedAt: string | null = null
  #truncated = false
  #unsubscribeSnapshots: (() => void) | null

  constructor(
    docker: DockerDriver,
    instance: NonNullable<Awaited<ReturnType<DockerDriver["findInstance"]>>>,
    subscribeSnapshots: BrowserSocketOptions["subscribeSnapshots"],
    onEmpty: () => void
  ) {
    this.#docker = docker
    this.#instance = instance
    this.#onEmpty = onEmpty
    this.#unsubscribeSnapshots = subscribeSnapshots((sample) => {
      this.#observeSnapshot(sample)
    })
  }

  get subscriberCount(): number {
    return this.#subscribers.size
  }

  add(socket: WebSocket): void {
    if (this.#closed) return
    this.#graceFiber?.interruptUnsafe()
    this.#graceFiber = null
    this.#subscribers.add(socket)
    if (this.#sessionLifecycle !== undefined) this.#sendSession(socket)
    this.#startStream()
  }

  remove(socket: WebSocket): void {
    this.#subscribers.delete(socket)
    if (this.#subscribers.size > 0 || this.#graceFiber || this.#closed) return
    let graceFiber: Fiber.Fiber<void, never>
    graceFiber = Effect.runFork(
      Effect.sleep("2 seconds").pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (this.#subscribers.size === 0) this.close()
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (this.#graceFiber === graceFiber) this.#graceFiber = null
          })
        )
      )
    )
    this.#graceFiber = graceFiber
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#graceFiber?.interruptUnsafe()
    this.#graceFiber = null
    this.#streamFiber?.interruptUnsafe()
    this.#streamFiber = null
    for (const fiber of this.#backgroundFibers) fiber.interruptUnsafe()
    this.#backgroundFibers.clear()
    this.#unsubscribeSnapshots?.()
    this.#unsubscribeSnapshots = null
    this.#abort.abort()
    this.#onEmpty()
  }

  #startStream(): void {
    if (this.#closed || this.#streamFiber || this.#subscribers.size === 0) {
      return
    }
    let streamFiber: Fiber.Fiber<void, never>
    streamFiber = Effect.runFork(
      this.#streamLoopEffect().pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.#streamFiber === streamFiber) this.#streamFiber = null
          })
        )
      )
    )
    this.#streamFiber = streamFiber
  }

  #streamLoopEffect(): Effect.Effect<void> {
    return this.#streamOnceEffect().pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          if (!this.#abort.signal.aborted) {
            Sentry.captureException(cause, {
              tags: { "kiln.operation": "browser.console.stream" },
            })
          }
        })
      ),
      Effect.andThen(
        Effect.suspend(() =>
          this.#closed ||
          this.#abort.signal.aborted ||
          this.#subscribers.size === 0
            ? Effect.void
            : Effect.sleep("1 second").pipe(
                Effect.andThen(Effect.suspend(() => this.#streamLoopEffect()))
              )
        )
      )
    )
  }

  #streamOnceEffect(): Effect.Effect<void, Error> {
    return browserOperation(() =>
      this.#docker.console(this.#instance, 200)
    ).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          const startedAt = lifecycleEventTime(snapshot.lifecycle, "started")
          const sessionChanged =
            lifecycleEventTime(this.#sessionLifecycle, "started") !== startedAt
          if (this.#sessionLifecycle === undefined || sessionChanged) {
            this.#replaceSession(snapshot)
          } else {
            for (const line of snapshot.lines) this.#append(line)
          }
          if (this.#backfillStartedAt !== startedAt) {
            this.#backfillStartedAt = startedAt
            this.#forkBackground(
              this.#backfillEffect(startedAt),
              "browser.console.backfill"
            )
          }
        })
      ),
      Effect.andThen(
        browserOperation(async () => {
          for await (const line of this.#docker.streamConsole(
            this.#instance,
            this.#abort.signal
          )) {
            this.#append(line)
          }
        })
      )
    )
  }

  #forkBackground(effect: Effect.Effect<void, Error>, operation: string): void {
    let fiber: Fiber.Fiber<void, never>
    fiber = Effect.runFork(
      effect.pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            if (!this.#abort.signal.aborted) {
              Sentry.captureException(cause, {
                tags: { "kiln.operation": operation },
              })
            }
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            this.#backgroundFibers.delete(fiber)
          })
        )
      )
    )
    this.#backgroundFibers.add(fiber)
  }

  #append(line: RelayConsoleLine): void {
    if (
      this.#sessionFloor &&
      line.timestamp &&
      line.timestamp < this.#sessionFloor
    ) {
      return
    }
    if (this.#lineIds.has(line.id)) return
    this.#lineIds.add(line.id)
    this.#recent.push(line)
    if (this.#recent.length > MAX_CONSOLE_HISTORY_LINES) {
      const removed = this.#recent.shift()
      if (removed) this.#lineIds.delete(removed.id)
      this.#truncated = true
    }
    const encoded = encodeConsoleLineFrame(line)
    for (const socket of this.#subscribers) sendEncoded(socket, encoded)
  }

  #observeSnapshot(sample: RelaySnapshotSample): void {
    if (this.#abort.signal.aborted || this.#sessionLifecycle === undefined) {
      return
    }
    const lifecycle = sample.snapshot.instances.find(
      (instance) => instance.id === this.#instance.id
    )?.lifecycle
    const startedAt = lifecycleEventTime(lifecycle, "started")
    if (
      !startedAt ||
      startedAt === lifecycleEventTime(this.#sessionLifecycle, "started") ||
      startedAt === this.#transitionStartedAt
    ) {
      return
    }
    this.#transitionStartedAt = startedAt
    this.#forkBackground(
      this.#transitionSessionEffect(startedAt),
      "browser.console.session-transition"
    )
  }

  #replaceSession(snapshot: RelayConsole): void {
    const startedAt = lifecycleEventTime(snapshot.lifecycle, "started")
    this.#sessionFloor = startedAt
    this.#sessionLifecycle = snapshot.lifecycle
    this.#backfillStartedAt = undefined
    this.#truncated = snapshot.truncated
    this.#recent.splice(0, this.#recent.length, ...snapshot.lines)
    this.#lineIds.clear()
    for (const line of snapshot.lines) this.#lineIds.add(line.id)
    for (const socket of this.#subscribers) this.#sendSession(socket)
  }

  #transitionSessionEffect(startedAt: string): Effect.Effect<void, Error> {
    return browserOperation(() =>
      this.#docker.console(this.#instance, 200)
    ).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          if (
            this.#abort.signal.aborted ||
            this.#transitionStartedAt !== startedAt ||
            lifecycleEventTime(this.#sessionLifecycle, "started") ===
              startedAt ||
            lifecycleEventTime(snapshot.lifecycle, "started") !== startedAt
          ) {
            return
          }
          this.#replaceSession(snapshot)
          this.#backfillStartedAt = startedAt
          this.#forkBackground(
            this.#backfillEffect(startedAt),
            "browser.console.backfill"
          )
        })
      ),
      Effect.asVoid,
      Effect.ensuring(
        Effect.sync(() => {
          if (this.#transitionStartedAt === startedAt) {
            this.#transitionStartedAt = null
          }
        })
      )
    )
  }

  #backfillEffect(startedAt: string | null): Effect.Effect<void, Error> {
    return browserOperation(() =>
      this.#docker.console(this.#instance, MAX_CONSOLE_HISTORY_LINES)
    ).pipe(
      Effect.tap((history) =>
        Effect.sync(() => {
          if (
            this.#abort.signal.aborted ||
            lifecycleEventTime(this.#sessionLifecycle, "started") !==
              startedAt ||
            lifecycleEventTime(history.lifecycle, "started") !== startedAt
          ) {
            return
          }
          const firstRecent = this.#recent[0]
          const firstRecentIndex = firstRecent
            ? history.lines.findIndex((line) => line.id === firstRecent.id)
            : history.lines.length
          const older =
            firstRecentIndex >= 0
              ? history.lines.slice(0, firstRecentIndex)
              : history.lines.filter(
                  (line) =>
                    line.timestamp !== null &&
                    firstRecent?.timestamp !== null &&
                    line.timestamp < firstRecent.timestamp
                )
          if (older.length === 0) {
            this.#truncated ||= history.truncated
            return
          }
          const fresh = older.filter((line) => !this.#lineIds.has(line.id))
          if (fresh.length === 0) return
          for (const line of fresh) this.#lineIds.add(line.id)
          this.#recent.unshift(...fresh)
          if (this.#recent.length > MAX_CONSOLE_HISTORY_LINES) {
            const removed = this.#recent.splice(
              0,
              this.#recent.length - MAX_CONSOLE_HISTORY_LINES
            )
            for (const line of removed) this.#lineIds.delete(line.id)
            this.#truncated = true
          } else {
            this.#truncated ||= history.truncated
          }
          this.#sendHistory(this.#subscribers, fresh)
        })
      ),
      Effect.asVoid
    )
  }

  #sendSession(socket: WebSocket): void {
    const lifecycle = this.#sessionLifecycle ?? []
    const snapshotStart = Math.max(0, this.#recent.length - 200)
    if (socket.protocol === relayBrowserProtocol) {
      send(socket, {
        type: "ready",
        instanceId: this.#instance.id,
        lifecycle,
      })
      for (const line of this.#recent.slice(snapshotStart)) {
        sendEncoded(socket, encodeConsoleLineFrame(line))
      }
      return
    }

    const reset = encodeNewestConsoleBatch({
      type: "reset",
      instanceId: this.#instance.id,
      lifecycle,
      lines: this.#recent.slice(snapshotStart),
      truncated: this.#truncated || snapshotStart > 0,
    })
    sendEncoded(socket, reset.encoded)
    send(socket, {
      type: "ready",
      instanceId: this.#instance.id,
      lifecycle,
    })
    this.#sendHistory(
      new Set([socket]),
      this.#recent.slice(0, snapshotStart + reset.start)
    )
  }

  #sendHistory(
    sockets: ReadonlySet<WebSocket>,
    lines: ReadonlyArray<RelayConsoleLine>
  ): void {
    const subscribers = [...sockets].filter(
      (socket) => socket.protocol === relayBrowserConsoleProtocol
    )
    if (subscribers.length === 0) return
    const frames = encodeConsoleHistoryFrames({
      instanceId: this.#instance.id,
      lifecycle: this.#sessionLifecycle ?? [],
      lines,
      truncated: this.#truncated,
    })
    for (const encoded of frames) {
      for (const socket of subscribers) sendEncoded(socket, encoded)
    }
  }
}

function browserKeyThumbprint(jwk: {
  readonly crv: "P-256"
  readonly kty: "EC"
  readonly x: string
  readonly y: string
}): string {
  return createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest("base64url")
}

function closeSockets(
  sockets: ReadonlySet<WebSocket>,
  reason: string
): Promise<void> {
  return Effect.runPromise(
    Effect.forEach(sockets, (socket) => closeSocketEffect(socket, reason), {
      concurrency: 16,
      discard: true,
    })
  )
}

function closeSocketEffect(
  socket: WebSocket,
  reason: string
): Effect.Effect<void> {
  if (socket.readyState === WebSocket.CLOSED) return Effect.void
  return Effect.callback<void>((resume) => {
    const closed = () => {
      resume(Effect.void)
    }
    socket.once("close", closed)
    socket.close(1001, reason)
    return Effect.sync(() => {
      socket.off("close", closed)
    })
  }).pipe(
    Effect.timeout("1 second"),
    Effect.catchTag("TimeoutError", () =>
      Effect.sync(() => {
        socket.terminate()
      })
    )
  )
}

function closeWebSocketServerEffect(
  server: WebSocketServer
): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    server.close(() => {
      resume(Effect.void)
    })
  })
}

function browserOperation<TResult>(
  run: () => Promise<TResult>
): Effect.Effect<TResult, Error> {
  return Effect.tryPromise({ try: run, catch: asError })
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function send(socket: WebSocket, value: unknown): void {
  sendEncoded(socket, JSON.stringify(value))
}

function sendEncoded(socket: WebSocket, value: string): void {
  if (socket.readyState !== WebSocket.OPEN) return
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    socket.close(1013, "Browser is not consuming console data")
    return
  }
  socket.send(value)
}

function parseProtocols(value: string | undefined): ReadonlyArray<string> {
  return value?.split(",").map((protocol) => protocol.trim()) ?? []
}
