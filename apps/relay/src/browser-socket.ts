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
  RelayBrowserCapabilitySchema,
  RelayBrowserRenewSchema,
  relayBrowserProofTranscript,
  relayBrowserRequestProofTranscript,
  relayBrowserConsoleProtocol,
  relayBrowserConsoleProtocols,
  relayBrowserProtocol,
  relayInstanceLifecycleEventTime as lifecycleEventTime,
} from "@workspace/contracts"
import type {
  RelayBrowserAuthorizationRevision,
  RelayBrowserCapability,
  RelayBrowserCapabilityV2,
  RelayConsole,
  RelayConsoleLine,
  RelayInstanceLifecycleEvent,
} from "@workspace/contracts"
import {
  relayConsoleCommandSchema,
  relayConsoleCompletionInputSchema,
} from "@workspace/contracts"

import {
  MAX_CONSOLE_HISTORY_LINES,
  type DockerConsoleSession,
  type DockerDriver,
} from "./docker.js"
import {
  encodeConsoleHistoryFrames,
  encodeConsoleLineFrame,
  encodeNewestConsoleBatch,
} from "./console-frames.js"
import { MAX_TRANSFER_BYTES } from "./files.js"
import type { ArchiveDownloadEntry, FilesystemDriver } from "./files.js"
import type { RelayIdentity } from "./effect/identity.js"
import { ensuringPromise, forkPromise } from "./effect/promise.js"
import type { RelayClientGrant, RelayStateStore } from "./effect/state.js"
import type { RelaySnapshotSample } from "./snapshot-hub.js"
import type { RelayConfig } from "./config.js"
import { BrowserOutbox, type BrowserOutboxKind } from "./browser-outbox.js"
import {
  authorityFromCapability,
  BrowserSessionRegistry,
  type BrowserSessionAuthority,
} from "./browser-session-registry.js"
import type { Server } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"

const AUTHENTICATION_WINDOW_MS = 10_000
const HTTP_PROOF_WINDOW_MS = 30_000
const HEARTBEAT_INTERVAL_MS = 15_000
const MAX_DIRECT_TRANSFERS = 32
const MAX_DIRECT_TRANSFERS_PER_CLIENT = 8
const MAX_PENDING_CONSOLE_OPERATIONS_PER_SOCKET = 8
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
const decodeBrowserRenew = Schema.decodeUnknownOption(RelayBrowserRenewSchema)

export interface BrowserSocketOptions {
  readonly config: Pick<RelayConfig, "browserLimits" | "proxyMode">
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
  readonly reviseAuthorization: (
    issuer: string,
    items: ReadonlyArray<RelayBrowserAuthorizationRevision>,
    issuerGeneration: number
  ) => void
}

export function attachBrowserSocket(
  options: BrowserSocketOptions
): BrowserSocketServer {
  const sockets = new Set<WebSocket>()
  const registry = new BrowserSessionRegistry(options.config.browserLimits)
  const outboxes = new Map<WebSocket, BrowserOutbox>()
  const legacyRequestProofs = new Map<string, number>()
  const pendingLegacyRequestProofs = new Set<string>()
  const transfers = {
    active: 0,
    byClient: new Map<string, number>(),
    pendingAuthentications: 0,
  }
  const hubs = new ConsoleHubRegistry(
    options.docker,
    options.subscribeSnapshots,
    (socket, encoded, kind, action) =>
      outboxes.get(socket)?.send(encoded, kind, action) ?? false
  )
  const resourceHubs = new ResourceHubRegistry(
    options.docker,
    options.subscribeSnapshots,
    (socket, encoded, kind, action) =>
      outboxes.get(socket)?.send(encoded, kind, action) ?? false
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
    const origin = request.headers.origin
    if (!origin) {
      socket.close(4403, "Browser origin is required")
      return
    }
    if (
      !registry.acquirePending(
        socket,
        request.socket.remoteAddress ?? "unknown",
        options.config.proxyMode === "none"
      )
    ) {
      socket.close(1013, "Relay browser handshake capacity reached")
      return
    }
    sockets.add(socket)
    const outbox = new BrowserOutbox({
      authorize: (action) => registry.isActive(socket, action),
      maxBytes: options.config.browserLimits.outboxBytes,
      maxMessages: options.config.browserLimits.outboxMessages,
      socket,
    })
    outboxes.set(socket, outbox)
    authenticateBrowser(
      socket,
      origin,
      options,
      hubs,
      resourceHubs,
      registry,
      outbox
    )
    socket.on("pong", () => {
      ;(socket as TrackedWebSocket).kilnAlive = true
    })
    ;(socket as TrackedWebSocket).kilnAlive = true
    socket.once("close", () => {
      sockets.delete(socket)
      registry.release(socket)
      outboxes.get(socket)?.close()
      outboxes.delete(socket)
      hubs.remove(socket)
      resourceHubs.remove(socket)
    })
  })

  const heartbeatFiber = Effect.runFork(
    Effect.sleep(HEARTBEAT_INTERVAL_MS).pipe(
      Effect.andThen(
        Effect.sync(() => {
          for (const socket of sockets) {
            const tracked = socket as TrackedWebSocket
            if (tracked.kilnAlive === false) {
              socket.terminate()
              continue
            }
            tracked.kilnAlive = false
            socket.ping()
          }
        })
      ),
      Effect.forever
    )
  )

  return {
    close: async () => {
      heartbeatFiber.interruptUnsafe()
      registry.close()
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
        registry,
        pendingLegacyRequestProofs,
        legacyRequestProofs,
        transfers
      ),
    reviseAuthorization: (issuer, items, issuerGeneration) =>
      registry.revise(issuer, items, issuerGeneration),
    revokeClient: (clientId) => registry.revokeIssuer(clientId),
  }
}

interface TrackedWebSocket extends WebSocket {
  kilnAlive?: boolean
}

function authenticateBrowser(
  socket: WebSocket,
  origin: string,
  options: BrowserSocketOptions,
  hubs: ConsoleHubRegistry,
  resourceHubs: ResourceHubRegistry,
  registry: BrowserSessionRegistry,
  outbox: BrowserOutbox
): void {
  const challenge = {
    expiresAt: Date.now() + AUTHENTICATION_WINDOW_MS,
    nonce: randomBytes(32).toString("base64url"),
    relayId: options.identity.fingerprint,
    sessionId: randomUUID(),
    type: "auth.challenge",
    v: 1,
  }
  socket.send(JSON.stringify(challenge))
  let authenticationAttempt = false
  let browserKey: ReturnType<typeof createPublicKey> | null = null
  let capability: RelayBrowserCapability | null = null
  let pendingConsoleOperations = 0
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
      if (authenticationAttempt) {
        socket.close(4401, "Browser authentication is already in progress")
        return
      }
      authenticationAttempt = true
      forkPromise(
        () =>
          ensuringPromise(
            () =>
              Sentry.startSpan(
                {
                  name: "Authenticate browser session",
                  op: "relay.browser.auth",
                },
                () => authenticate(input.value)
              ),
            () => {
              authenticationAttempt = false
            }
          ),
        () => socket.close(4401, "Browser authentication failed")
      )
      return
    }
    const renewal = decodeBrowserRenew(input.value)
    if (Option.isSome(renewal)) {
      if (authenticationAttempt || capability.version !== 2) {
        socket.close(4400, "Browser renewal is not available")
        return
      }
      authenticationAttempt = true
      forkPromise(
        () =>
          ensuringPromise(
            () =>
              Sentry.startSpan(
                { name: "Renew browser lease", op: "relay.browser.renew" },
                () => renew(renewal.value)
              ),
            () => {
              authenticationAttempt = false
            }
          ),
        () => socket.close(4403, "Browser renewal failed")
      )
      return
    }
    const consoleSubscription = decodeBrowserSubscription(input.value)
    if (Option.isSome(consoleSubscription)) {
      const subscription = consoleSubscription.value
      if (
        subscription.instanceId !== capability.instanceId ||
        (capability.version === 2 && capability.operation !== "console") ||
        !registry.isActive(socket, "instance.console.read")
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
        (capability.version === 2 && capability.operation !== "resources") ||
        !registry.isActive(socket, "instance.read")
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
        (capability.version === 2 && capability.operation !== "console") ||
        !registry.isActive(socket, "instance.console.write")
      ) {
        socket.close(4403, "Console capability does not allow writes")
        return
      }
      executeBoundedConsoleOperation(
        request.requestId,
        "console_write_capacity_reached",
        "Too many console operations are pending",
        () =>
          executeConsoleWrite(
            socket,
            request,
            options,
            capability!,
            outbox,
            () => registry.isActive(socket, "instance.console.write")
          )
      )
      return
    }
    const consoleCompletion = decodeBrowserConsoleComplete(input.value)
    if (Option.isSome(consoleCompletion)) {
      const request = consoleCompletion.value
      if (
        request.instanceId !== capability.instanceId ||
        (capability.version === 2 && capability.operation !== "console") ||
        !registry.isActive(socket, "instance.console.write")
      ) {
        socket.close(4403, "Console capability does not allow completion")
        return
      }
      executeBoundedConsoleOperation(
        request.requestId,
        "console_completion_capacity_reached",
        "Too many completions are pending",
        () =>
          executeConsoleCompletion(
            socket,
            request,
            options.docker,
            outbox,
            () => registry.isActive(socket, "instance.console.write")
          )
      )
      return
    }
    socket.close(4400, "Invalid browser operation")
  })

  socket.once("close", () => {
    clearTimeout(timer)
  })

  function executeBoundedConsoleOperation(
    requestId: string,
    code: string,
    message: string,
    operation: () => Promise<void>
  ): void {
    if (pendingConsoleOperations >= MAX_PENDING_CONSOLE_OPERATIONS_PER_SOCKET) {
      outbox.send(
        JSON.stringify({ code, message, requestId, type: "operation.error" }),
        "priority",
        "instance.console.write"
      )
      return
    }
    pendingConsoleOperations += 1
    forkPromise(
      () =>
        ensuringPromise(operation, () => {
          pendingConsoleOperations -= 1
        }),
      () => undefined
    )
  }

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
    browserKey = createPublicKey({
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
    const authority = browserAuthority(parsed.payload)
    const current =
      parsed.payload.version === 2
        ? await options.runEffect(
            options.state.browserAuthority({
              instanceId: parsed.payload.instanceId,
              issuer: parsed.payload.issuer,
              loginSessionId: parsed.payload.loginSessionId,
              subject: parsed.payload.subject,
            })
          )
        : { issuerGeneration: 0, minimumRevision: 0 }
    const nextRenewal =
      parsed.payload.version === 2
        ? renewalChallenge(parsed.payload.expiresAt)
        : undefined
    const admission = registry.activate(
      socket,
      authority,
      challenge.sessionId,
      current,
      nextRenewal
    )
    if (!admission.accepted) {
      clearTimeout(timer)
      socket.close(
        admission.reason === "capacity" ? 1013 : 4403,
        admission.reason === "capacity"
          ? "Relay browser session capacity reached"
          : "Browser authorization is stale"
      )
      return
    }
    capability = parsed.payload
    clearTimeout(timer)
    outbox.send(
      JSON.stringify({
        expiresAt: capability.expiresAt,
        instanceId: capability.instanceId,
        ...(nextRenewal
          ? {
              renewalNonce: nextRenewal.nonce,
              renewalNonceExpiresAt: nextRenewal.nonceExpiresAt,
              sessionId: challenge.sessionId,
            }
          : {}),
        type: "auth.ready",
        v: 1,
      }),
      "priority"
    )
  }

  async function renew(
    value: typeof RelayBrowserRenewSchema.Type
  ): Promise<void> {
    if (!browserKey || !capability || capability.version !== 2) {
      throw new Error("Browser session cannot renew")
    }
    const renewal = registry.renewalChallenge(socket)
    if (!renewal || renewal.nonceExpiresAt <= Date.now()) {
      throw new Error("Browser renewal challenge expired")
    }
    const parsed = decodeCapability(value.capability)
    if (parsed.payload.version !== 2) {
      throw new Error("Browser renewal requires capability v2")
    }
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
    const validProof = verify(
      "sha256",
      Buffer.from(
        relayBrowserProofTranscript(
          {
            capabilityId: parsed.payload.capabilityId,
            expiresAt: renewal.nonceExpiresAt,
            nonce: renewal.nonce,
            relayId: options.identity.fingerprint,
            sessionId: renewal.sessionId,
          },
          socket.protocol === relayBrowserConsoleProtocol
            ? relayBrowserConsoleProtocol
            : relayBrowserProtocol
        )
      ),
      { dsaEncoding: "ieee-p1363", key: browserKey },
      Buffer.from(value.signature, "base64url")
    )
    if (!validProof) throw new Error("Browser renewal proof is invalid")
    const current = await options.runEffect(
      options.state.browserAuthority({
        instanceId: parsed.payload.instanceId,
        issuer: parsed.payload.issuer,
        loginSessionId: parsed.payload.loginSessionId,
        subject: parsed.payload.subject,
      })
    )
    if (
      parsed.payload.issuerGeneration !== current.issuerGeneration ||
      parsed.payload.authorizationRevision < current.minimumRevision
    ) {
      throw new Error("Browser authorization is stale")
    }
    const next = renewalChallenge(parsed.payload.expiresAt)
    if (
      !registry.renew(
        socket,
        authorityFromCapability(parsed.payload),
        next.nonce,
        next.nonceExpiresAt
      )
    ) {
      throw new Error("Browser renewal changed ownership")
    }
    capability = parsed.payload
    outbox.send(
      JSON.stringify({
        actions: parsed.payload.actions,
        authorizationRevision: parsed.payload.authorizationRevision,
        expiresAt: parsed.payload.expiresAt,
        renewalNonce: next.nonce,
        renewalNonceExpiresAt: next.nonceExpiresAt,
        type: "auth.renewed",
        v: 1,
      }),
      "priority"
    )
  }
}

async function executeConsoleWrite(
  socket: WebSocket,
  request: typeof BrowserConsoleWriteSchema.Type,
  options: BrowserSocketOptions,
  capability: RelayBrowserCapability,
  outbox: BrowserOutbox,
  authorize: () => boolean
): Promise<void> {
  await runBrowser(
    timedBrowserOperation(
      "Execute browser console write",
      "relay.browser.console.write",
      async () => {
        const instance = await options.docker.findInstance(request.instanceId)
        if (!instance) throw new Error("Instance not found")
        if (!authorize()) throw new Error("Browser authorization changed")
        const input = relayConsoleCommandSchema.parse({
          command: request.command,
        })
        await options.docker.sendCommand(instance, input.command)
        void auditBrowserConsoleWrite(options, capability, instance.id)
        outbox.send(
          JSON.stringify({
            operation: "console.write",
            payload: { accepted: true, command: input.command },
            requestId: request.requestId,
            type: "operation.result",
          }),
          "priority",
          "instance.console.write"
        )
      }
    ).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          outbox.send(
            JSON.stringify({
              code: "console_write_failed",
              message: "Command could not be sent",
              requestId: request.requestId,
              type: "operation.error",
            }),
            "priority",
            "instance.console.write"
          )
        })
      )
    )
  )
}

async function auditBrowserConsoleWrite(
  options: BrowserSocketOptions,
  capability: RelayBrowserCapability,
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
  docker: DockerDriver,
  outbox: BrowserOutbox,
  authorize: () => boolean
): Promise<void> {
  await runBrowser(
    timedBrowserOperation(
      "Execute browser console completion",
      "relay.browser.console.complete",
      async () => {
        const instance = await docker.findInstance(request.instanceId)
        if (!instance) throw new Error("Instance not found")
        if (!authorize()) throw new Error("Browser authorization changed")
        const input = relayConsoleCompletionInputSchema.parse(request)
        const payload = await docker.completeCommand(
          instance,
          input.input,
          input.cursor
        )
        outbox.send(
          JSON.stringify({
            operation: "console.complete",
            payload,
            requestId: request.requestId,
            type: "operation.result",
          }),
          "priority",
          "instance.console.write"
        )
      }
    ).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          outbox.send(
            JSON.stringify({
              code: "console_completion_failed",
              message: "Completions are unavailable",
              requestId: request.requestId,
              type: "operation.error",
            }),
            "priority",
            "instance.console.write"
          )
        })
      )
    )
  )
}

function decodeCapability(value: string): {
  encoded: string
  payload: RelayBrowserCapability
  signature: string
} {
  if (value.length > 16_384) throw new Error("Capability is too large")
  const [encoded, signature, extra] = value.split(".")
  if (!encoded || !signature || extra) throw new Error("Invalid capability")
  return {
    encoded,
    payload: Schema.decodeUnknownSync(RelayBrowserCapabilitySchema)(
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
  const now = Date.now()
  const payload = capability.payload
  if (payload.version === 2) validateCapabilityV2(payload, now)
  if (
    payload.audience !== relayId ||
    payload.expiresAt <= now ||
    payload.issuedAt > now + 5_000 ||
    payload.origin !== origin ||
    !client.origins.includes(origin) ||
    payload.actions.length === 0 ||
    (requiredAction !== null && !client.actions.includes(requiredAction)) ||
    (requiredAction !== null && !payload.actions.includes(requiredAction)) ||
    payload.actions.some((action) => !client.actions.includes(action)) ||
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

function validateCapabilityV2(
  capability: RelayBrowserCapabilityV2,
  now: number
): void {
  const allowed =
    capability.operation === "console"
      ? new Set(["instance.console.read", "instance.console.write"])
      : capability.operation === "resources"
        ? new Set(["instance.read"])
        : new Set(["instance.files.download", "instance.files.upload"])
  const writes = capability.actions.some(
    (action) =>
      action === "instance.console.write" || action === "instance.files.upload"
  )
  const maximumLease = writes ? 30_000 : 60_000
  if (
    !Number.isSafeInteger(capability.issuedAt) ||
    !Number.isSafeInteger(capability.expiresAt) ||
    !Number.isSafeInteger(capability.authorizationRevision) ||
    !Number.isSafeInteger(capability.issuerGeneration) ||
    capability.authorizationRevision < 0 ||
    capability.issuerGeneration < 0 ||
    capability.expiresAt <= capability.issuedAt ||
    capability.expiresAt - capability.issuedAt > maximumLease ||
    capability.issuedAt > now + 5_000 ||
    capability.actions.length > allowed.size ||
    capability.actions.some((action) => !allowed.has(action)) ||
    new Set(capability.actions).size !== capability.actions.length ||
    capability.loginSessionId.length === 0 ||
    capability.loginSessionId.length > 240 ||
    capability.subject.length === 0 ||
    capability.subject.length > 240 ||
    capability.capabilityId.length === 0 ||
    capability.capabilityId.length > 240 ||
    (capability.operation === "file") !== (capability.path !== null) ||
    (capability.path?.length ?? 0) > 2_048
  ) {
    throw new Error("Browser capability v2 is invalid")
  }
}

function browserAuthority(
  capability: RelayBrowserCapability
): BrowserSessionAuthority {
  if (capability.version === 2) return authorityFromCapability(capability)
  return {
    actions: new Set(capability.actions),
    expiresAt: capability.expiresAt,
    instanceId: capability.instanceId,
    issuer: capability.issuer,
    issuerGeneration: 0,
    keyThumbprint: capability.keyThumbprint,
    loginSessionId: null,
    operation: null,
    origin: capability.origin,
    revision: 0,
    subject: capability.subject,
    version: 1,
  }
}

function renewalChallenge(capabilityExpiresAt: number) {
  return {
    nonce: randomBytes(32).toString("base64url"),
    nonceExpiresAt: capabilityExpiresAt,
  }
}

async function handleBrowserFileRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: BrowserSocketOptions,
  registry: BrowserSessionRegistry,
  pendingLegacyRequestProofs: Set<string>,
  legacyRequestProofs: Map<string, number>,
  transfers: {
    active: number
    byClient: Map<string, number>
    pendingAuthentications: number
  }
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
  if (
    transfers.pendingAuthentications >=
    options.config.browserLimits.pendingFileAuthentications
  ) {
    browserJson(
      response,
      429,
      { error: "Relay file authentication capacity reached" },
      origin
    )
    return true
  }
  transfers.pendingAuthentications += 1
  const attempted = await ensuringPromise(
    async () => {
      let downloadForm: BrowserDownloadForm | null = null
      if (method === "POST") {
        const parsedForm = await runBrowser(
          browserOperation(() => readBrowserDownloadForm(request)).pipe(
            Effect.option
          )
        )
        if (Option.isNone(parsedForm)) return Option.none()
        downloadForm = parsedForm.value
      }
      const path = downloadForm?.path ?? url.searchParams.get("path") ?? ""
      const authenticated = await runBrowser(
        timedBrowserOperation(
          "Authenticate browser file request",
          "relay.browser.file.auth",
          () =>
            authenticateBrowserRequest({
              instanceId,
              method,
              options,
              origin,
              path,
              request,
              ...(downloadForm
                ? { credentials: downloadForm.credentials }
                : {}),
              pendingLegacyRequestProofs,
              legacyRequestProofs,
            })
        ).pipe(Effect.option)
      )
      return Option.some({ authenticated, downloadForm, path })
    },
    () => {
      transfers.pendingAuthentications -= 1
    }
  )
  if (Option.isNone(attempted)) {
    browserJson(response, 400, { error: "Download request is invalid" }, origin)
    return true
  }
  const { authenticated, downloadForm, path } = attempted.value
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
  const transfer = registry.registerTransfer(authentication.authority, () => {
    if (!request.destroyed) request.destroy()
    if (!response.destroyed) response.destroy()
  })
  if (!transfer.active()) {
    transfer.release()
    transfers.active -= 1
    const remaining = (transfers.byClient.get(clientId) ?? 1) - 1
    if (remaining > 0) transfers.byClient.set(clientId, remaining)
    else transfers.byClient.delete(clientId)
    browserJson(
      response,
      403,
      { error: "Browser authorization changed" },
      origin
    )
    return true
  }

  await runBrowser(
    browserOperation(async () => {
      const instance = await options.docker.findInstance(instanceId)
      if (!instance) {
        browserJson(response, 404, { error: "Instance not found" }, origin)
        return
      }
      if (method === "PUT") {
        const uploaded = await options.runEffect(
          options.filesystem.upload(instance, path, request, transfer.active)
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
          transfer.release()
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
  pendingLegacyRequestProofs: Set<string>
  legacyRequestProofs: Map<string, number>
}): Promise<{
  authority: BrowserSessionAuthority
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
  for (const [key, expiresAt] of input.legacyRequestProofs) {
    if (expiresAt <= Date.now()) input.legacyRequestProofs.delete(key)
  }
  const replayKey = `${parsed.payload.capabilityId}:${nonce}`
  if (
    parsed.payload.version === 1 &&
    (input.legacyRequestProofs.has(replayKey) ||
      input.pendingLegacyRequestProofs.has(replayKey))
  )
    throw new Error("Browser proof was replayed")
  if (parsed.payload.version === 1) {
    if (
      input.legacyRequestProofs.size >=
        input.options.config.browserLimits.fileReplayEntries ||
      input.pendingLegacyRequestProofs.size >=
        input.options.config.browserLimits.fileReplayEntries
    ) {
      throw new Error("Browser replay table is full")
    }
    input.pendingLegacyRequestProofs.add(replayKey)
  }
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
      if (parsed.payload.version === 2 && parsed.payload.operation !== "file") {
        throw new Error("Capability is not for file requests")
      }
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
      if (parsed.payload.version === 2) {
        const authority = await input.options.runEffect(
          input.options.state.browserAuthority({
            instanceId: parsed.payload.instanceId,
            issuer: parsed.payload.issuer,
            loginSessionId: parsed.payload.loginSessionId,
            subject: parsed.payload.subject,
          })
        )
        if (
          parsed.payload.issuerGeneration !== authority.issuerGeneration ||
          parsed.payload.authorizationRevision < authority.minimumRevision
        ) {
          throw new Error("Browser authorization is stale")
        }
        const reservation = await input.options.runEffect(
          input.options.state.reserveBrowserFileReplay({
            capabilityId: parsed.payload.capabilityId,
            expiresAt: parsed.payload.expiresAt,
            maxEntries: input.options.config.browserLimits.fileReplayEntries,
            nonce,
            now: Date.now(),
          })
        )
        if (reservation !== "reserved") {
          throw new Error(
            reservation === "full"
              ? "Browser replay table is full"
              : "Browser proof was replayed"
          )
        }
      } else {
        input.legacyRequestProofs.set(replayKey, parsed.payload.expiresAt)
      }
      return {
        authority: browserAuthority(parsed.payload),
        capabilityId: parsed.payload.capabilityId,
        clientId: client.id,
        instanceId: parsed.payload.instanceId,
        subject: parsed.payload.subject,
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => input.pendingLegacyRequestProofs.delete(replayKey))
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

export function startConsoleBackfillIfNeeded(
  snapshot: Pick<RelayConsole, "truncated">,
  start: () => void
): void {
  if (snapshot.truncated) start()
}

type BrowserDelivery = (
  socket: WebSocket,
  encoded: string,
  kind: BrowserOutboxKind,
  action?: string
) => boolean

class ConsoleHubRegistry {
  readonly #deliver: BrowserDelivery
  readonly #docker: DockerDriver
  readonly #hubs = new Map<string, ConsoleHub>()
  readonly #pendingHubs = new Map<string, Fiber.Fiber<ConsoleHub, Error>>()
  readonly #subscribeSnapshots: BrowserSocketOptions["subscribeSnapshots"]
  readonly #subscriptions = new Map<WebSocket, string>()

  constructor(
    docker: DockerDriver,
    subscribeSnapshots: BrowserSocketOptions["subscribeSnapshots"],
    deliver: BrowserDelivery
  ) {
    this.#docker = docker
    this.#subscribeSnapshots = subscribeSnapshots
    this.#deliver = deliver
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
    return timedBrowserOperation(
      "Discover console session",
      "relay.console.discovery",
      (signal) => this.#docker.consoleSession(instanceId, signal)
    ).pipe(
      Effect.map((session) => {
        const hub = new ConsoleHub(
          this.#docker,
          session,
          this.#subscribeSnapshots,
          this.#deliver,
          () => {
            if (hub.subscriberCount === 0) this.#hubs.delete(instanceId)
          }
        )
        this.#hubs.set(instanceId, hub)
        return hub
      })
    )
  }
}

class ResourceHubRegistry {
  readonly #deliver: BrowserDelivery
  readonly #docker: DockerDriver
  readonly #historyDelivered = new Set<WebSocket>()
  readonly #subscribeSnapshots: BrowserSocketOptions["subscribeSnapshots"]
  readonly #subscriptions = new Map<WebSocket, string>()
  #lastSample: RelaySnapshotSample | null = null
  #unsubscribe: (() => void) | null = null

  constructor(
    docker: DockerDriver,
    subscribeSnapshots: BrowserSocketOptions["subscribeSnapshots"],
    deliver: BrowserDelivery
  ) {
    this.#docker = docker
    this.#subscribeSnapshots = subscribeSnapshots
    this.#deliver = deliver
  }

  subscribe(socket: WebSocket, instanceId: string): void {
    this.#subscriptions.set(socket, instanceId)
    if (!this.#unsubscribe) {
      this.#unsubscribe = this.#subscribeSnapshots((sample) => {
        this.#lastSample = sample
        this.#deliverSample(sample)
      })
    } else if (this.#lastSample) {
      this.#deliverSample(this.#lastSample, socket)
    }
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
    this.#lastSample = null
  }

  #deliverSample(sample: RelaySnapshotSample, only?: WebSocket): void {
    const byId = new Map(
      sample.snapshot.instances.map((instance) => [instance.id, instance])
    )
    const groups = new Map<string, Array<WebSocket>>()
    for (const [subscriber, instanceId] of this.#subscriptions) {
      if (only && subscriber !== only) continue
      const sockets = groups.get(instanceId) ?? []
      sockets.push(subscriber)
      groups.set(instanceId, sockets)
    }
    for (const [instanceId, subscribers] of groups) {
      const instance = byId.get(instanceId)
      if (!instance) continue
      const live = JSON.stringify({
        history: [],
        instance,
        sequence: sample.sequence,
        type: "resource",
      })
      let withHistory: string | null = null
      for (const subscriber of subscribers) {
        const first = !this.#historyDelivered.has(subscriber)
        if (first) {
          withHistory ??= JSON.stringify({
            history: this.#docker.resourceHistory(instanceId),
            instance,
            sequence: sample.sequence,
            type: "resource",
          })
        }
        this.#deliver(
          subscriber,
          first ? (withHistory ?? live) : live,
          "resource",
          "instance.read"
        )
        this.#historyDelivered.add(subscriber)
      }
    }
  }
}

class ConsoleHub {
  readonly #backgroundFibers = new Set<Fiber.Fiber<void, never>>()
  readonly #docker: DockerDriver
  readonly #deliver: BrowserDelivery
  readonly #instanceId: string
  readonly #lineIds = new Set<string>()
  readonly #onEmpty: () => void
  readonly #recent: Array<RelayConsoleLine> = []
  readonly #subscribers = new Set<WebSocket>()
  #backfillStartedAt: string | null | undefined
  #closed = false
  #graceFiber: Fiber.Fiber<void, never> | null = null
  #nextSession: DockerConsoleSession | null
  #sessionFloor: string | null = null
  #sessionLifecycle: Array<RelayInstanceLifecycleEvent> | undefined
  #streamFiber: Fiber.Fiber<void, never> | null = null
  #transitionStartedAt: string | null = null
  #truncated = false
  #unsubscribeSnapshots: (() => void) | null

  constructor(
    docker: DockerDriver,
    session: DockerConsoleSession,
    subscribeSnapshots: BrowserSocketOptions["subscribeSnapshots"],
    deliver: BrowserDelivery,
    onEmpty: () => void
  ) {
    this.#docker = docker
    this.#deliver = deliver
    this.#instanceId = session.instance.id
    this.#nextSession = session
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
          if (!this.#closed) {
            Sentry.captureException(cause, {
              tags: { "kiln.operation": "browser.console.stream" },
            })
          }
        })
      ),
      Effect.andThen(
        Effect.suspend(() =>
          this.#closed || this.#subscribers.size === 0
            ? Effect.void
            : Effect.sleep("1 second").pipe(
                Effect.andThen(Effect.suspend(() => this.#streamLoopEffect()))
              )
        )
      )
    )
  }

  #streamOnceEffect(): Effect.Effect<void, Error> {
    return this.#takeSessionEffect().pipe(
      Effect.flatMap((session) =>
        timedBrowserOperation(
          "Read initial console history",
          "relay.console.history",
          (signal) => session.history(200, signal)
        ).pipe(
          Effect.tap((snapshot) =>
            Effect.sync(() => {
              const startedAt = lifecycleEventTime(
                snapshot.lifecycle,
                "started"
              )
              const sessionChanged =
                lifecycleEventTime(this.#sessionLifecycle, "started") !==
                startedAt
              if (this.#sessionLifecycle === undefined || sessionChanged) {
                this.#replaceSession(snapshot)
              } else {
                for (const line of snapshot.lines) this.#append(line)
              }
              if (this.#backfillStartedAt !== startedAt) {
                this.#backfillStartedAt = startedAt
                startConsoleBackfillIfNeeded(snapshot, () => {
                  this.#forkBackground(
                    this.#backfillEffect(session, startedAt),
                    "browser.console.backfill"
                  )
                })
              }
            })
          ),
          Effect.andThen(
            browserOperation(async (signal) => {
              for await (const line of session.stream(signal)) {
                this.#append(line)
              }
            })
          )
        )
      )
    )
  }

  #takeSessionEffect(): Effect.Effect<DockerConsoleSession, Error> {
    const session = this.#nextSession
    this.#nextSession = null
    return session
      ? Effect.succeed(session)
      : timedBrowserOperation(
          "Rediscover console session",
          "relay.console.discovery",
          (signal) => this.#docker.consoleSession(this.#instanceId, signal)
        )
  }

  #forkBackground(effect: Effect.Effect<void, Error>, operation: string): void {
    let fiber: Fiber.Fiber<void, never>
    fiber = Effect.runFork(
      effect.pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            if (!this.#closed) {
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
    if (this.#closed) return
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
    for (const socket of this.#subscribers) {
      this.#deliver(socket, encoded, "console", "instance.console.read")
    }
  }

  #observeSnapshot(sample: RelaySnapshotSample): void {
    if (this.#closed || this.#sessionLifecycle === undefined) {
      return
    }
    const lifecycle = sample.snapshot.instances.find(
      (instance) => instance.id === this.#instanceId
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
    return timedBrowserOperation(
      "Discover replacement console session",
      "relay.console.discovery",
      (signal) => this.#docker.consoleSession(this.#instanceId, signal)
    ).pipe(
      Effect.flatMap((session) =>
        timedBrowserOperation(
          "Read replacement console history",
          "relay.console.history",
          (signal) => session.history(200, signal)
        ).pipe(
          Effect.tap((snapshot) =>
            Effect.sync(() => {
              if (
                this.#closed ||
                this.#transitionStartedAt !== startedAt ||
                lifecycleEventTime(this.#sessionLifecycle, "started") ===
                  startedAt ||
                lifecycleEventTime(snapshot.lifecycle, "started") !== startedAt
              ) {
                return
              }
              this.#replaceSession(snapshot)
              this.#backfillStartedAt = startedAt
              startConsoleBackfillIfNeeded(snapshot, () => {
                this.#forkBackground(
                  this.#backfillEffect(session, startedAt),
                  "browser.console.backfill"
                )
              })
            })
          )
        )
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

  #backfillEffect(
    session: DockerConsoleSession,
    startedAt: string | null
  ): Effect.Effect<void, Error> {
    return timedBrowserOperation(
      "Backfill console history",
      "relay.console.backfill",
      (signal) => session.history(MAX_CONSOLE_HISTORY_LINES, signal)
    ).pipe(
      Effect.tap((history) =>
        Effect.sync(() => {
          if (
            this.#closed ||
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
      this.#deliver(
        socket,
        JSON.stringify({
          type: "ready",
          instanceId: this.#instanceId,
          lifecycle,
        }),
        "console",
        "instance.console.read"
      )
      for (const line of this.#recent.slice(snapshotStart)) {
        this.#deliver(
          socket,
          encodeConsoleLineFrame(line),
          "console",
          "instance.console.read"
        )
      }
      return
    }

    const reset = encodeNewestConsoleBatch({
      type: "reset",
      instanceId: this.#instanceId,
      lifecycle,
      lines: this.#recent.slice(snapshotStart),
      truncated: this.#truncated || snapshotStart > 0,
    })
    this.#deliver(socket, reset.encoded, "console", "instance.console.read")
    this.#deliver(
      socket,
      JSON.stringify({
        type: "ready",
        instanceId: this.#instanceId,
        lifecycle,
      }),
      "console",
      "instance.console.read"
    )
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
      instanceId: this.#instanceId,
      lifecycle: this.#sessionLifecycle ?? [],
      lines,
      truncated: this.#truncated,
    })
    for (const encoded of frames) {
      for (const socket of subscribers) {
        this.#deliver(socket, encoded, "console", "instance.console.read")
      }
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
  run: (signal: AbortSignal) => Promise<TResult>
): Effect.Effect<TResult, Error> {
  return Effect.tryPromise({ try: run, catch: asError })
}

function timedBrowserOperation<TResult>(
  name: string,
  op: string,
  run: (signal: AbortSignal) => Promise<TResult>
): Effect.Effect<TResult, Error> {
  return browserOperation((signal) =>
    Sentry.startSpan({ name, op }, () => run(signal))
  )
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function parseProtocols(value: string | undefined): ReadonlyArray<string> {
  return value?.split(",").map((protocol) => protocol.trim()) ?? []
}
