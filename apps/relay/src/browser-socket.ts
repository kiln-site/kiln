import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto"
import { Effect, Fiber, Option, Schema } from "effect"
import type { Tracer } from "effect"
import { WebSocket, WebSocketServer } from "ws"

import {
  projectRelayInstanceOverview,
  RelayBrowserRenewSchema,
  relayBrowserProofTranscript,
  relayBrowserConsoleProtocol,
  relayBrowserConsoleProtocols,
  relayBrowserMaxFrameBytes,
  relayBrowserProtocol,
  relayInstanceLifecycleEventTime as lifecycleEventTime,
} from "@workspace/contracts"
import type {
  RelayBrowserAuthorizationRevision,
  RelayBrowserCapability,
  RelayConsole,
  RelayConsoleResource,
  RelayConsoleLine,
  RelayInstance,
  RelayInstanceLifecycleEvent,
  RelayInstanceResources,
  RelayWorkloadResourceKind,
  RelayWorkloadUsage,
  RelayWorkloadUsageHistory,
} from "@workspace/contracts"
import {
  relayConsoleCommandSchema,
  relayConsoleCompletionInputSchema,
} from "@workspace/contracts"

import {
  reportRelayError,
  traceParentSpan,
  traceRelayPromise,
} from "./effect/runtime.js"
import {
  MAX_CONSOLE_HISTORY_CHARACTERS,
  MAX_CONSOLE_HISTORY_LINES,
  type DockerConsoleSession,
  type DockerDriver,
} from "./docker.js"
import {
  consoleLineCharacters,
  encodeConsoleHistoryFrame,
  encodeConsoleLineFrame,
  encodeNewestConsoleBatch,
} from "./console-frames.js"
import type { ConsoleSource, ConsoleSources } from "./console-sources.js"
import type { FileRoot, FilesystemDriver } from "./files.js"
import type { LaneTicket, OperationLanes } from "./operation-lanes.js"
import { instanceLifecycleLocks } from "./operation-plans.js"
import type { RelayIdentity } from "./effect/identity.js"
import {
  ensuringPromise,
  forkPromise,
  recoverPromise,
} from "./effect/promise.js"
import type { RelayStateStore } from "./effect/state.js"
import type { RelaySnapshotSample } from "./snapshot-hub.js"
import type { RelayConfig } from "./config.js"
import { BrowserOutbox, type BrowserOutboxKind } from "./browser-outbox.js"
import {
  authorityFromCapability,
  BrowserSessionRegistry,
} from "./browser-session-registry.js"
import { requestUrl } from "./request-url.js"
import {
  browserAuthority,
  BrowserPublicKeySchema,
  browserKeyThumbprint,
  capabilityResourceKind,
  decodeCapability,
  serverScopeId,
  validateCapability,
} from "./browser-capability.js"
import { browserFileTransfers } from "./transfers/browser-files.js"
import { TransferGate } from "./transfers/gate.js"
import type { Server } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"

const AUTHENTICATION_WINDOW_MS = 10_000
// Advertised in the browser challenge: messages may follow the auth at once.
export const BROWSER_EARLY_MESSAGES_FEATURE = "early-messages"
// A browser has one message to send behind its auth; a few are tolerated.
const MAX_EARLY_BROWSER_MESSAGES = 4
const HEARTBEAT_INTERVAL_MS = 15_000
const MAX_PENDING_CONSOLE_OPERATIONS_PER_SOCKET = 8

const BrowserAuthSchema = Schema.Struct({
  capability: Schema.String,
  publicKeyJwk: BrowserPublicKeySchema,
  signature: Schema.String,
  type: Schema.Literal("auth"),
  v: Schema.Literal(1),
})

const BrowserSubscribeSchema = Schema.Struct({
  instanceId: Schema.String,
  // One of the resource's outputs, such as an app's deployment log.
  stream: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
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
type BrowserMessage = unknown
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
  readonly consoleSources: ConsoleSources
  readonly docker: DockerDriver
  readonly filesystem: FilesystemDriver
  // Serves app data directories, addressed as `app:<appId>`.
  readonly hostFiles?: {
    readonly filesystem: FilesystemDriver
    readonly root: (relayId: string) => Promise<FileRoot>
  }
  readonly appFiles?: {
    readonly filesystem: FilesystemDriver
    readonly root: (appId: string) => Promise<FileRoot>
  }
  // Serves databases' dump folders, addressed as `database:<databaseId>`.
  readonly databaseFiles?: {
    readonly filesystem: FilesystemDriver
    readonly root: (databaseId: string) => Promise<FileRoot>
  }
  /** Admits direct file transfers; shared with the Relay's other transfers. */
  readonly gate?: TransferGate
  readonly identity: RelayIdentity
  /** The lanes console input and uploads wait in, with Hearth's requests. */
  readonly lanes: OperationLanes
  /** Notes a stop typed into a server's console as someone's power change. */
  readonly onConsoleStop: (instanceId: string) => void
  readonly runEffect: <T, E>(effect: Effect.Effect<T, E>) => Promise<T>
  readonly server: Server
  readonly state: RelayStateStore["Service"]
  readonly subscribeSnapshots: (
    listener: (sample: RelaySnapshotSample) => void
  ) => () => void
  /** An App's or database's live usage, sampled on the snapshot loop. */
  readonly workloadUsage: (
    kind: RelayWorkloadResourceKind,
    id: string,
    history: RelayWorkloadUsageHistory
  ) => RelayWorkloadUsage
}

export interface BrowserSocketServer {
  /** Direct file transfers running, across every Hearth. */
  readonly activeTransfers: () => number
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
  const gate = options.gate ?? new TransferGate()
  const files = browserFileTransfers({ ...options, gate, registry })
  const hubs = new ConsoleHubRegistry(
    options.subscribeSnapshots,
    (socket, encoded, kind, action) =>
      outboxes.get(socket)?.send(encoded, kind, action) ?? false,
    (socket, bytes) =>
      outboxes.get(socket)?.whenRoomFor(bytes) ?? Promise.resolve(false)
  )
  const resourceHubs = new ResourceHubRegistry(
    options.docker,
    options.workloadUsage,
    options.subscribeSnapshots,
    (socket, encoded, kind, action) =>
      outboxes.get(socket)?.send(encoded, kind, action) ?? false,
    (socket, bytes) =>
      outboxes.get(socket)?.whenRoomFor(bytes) ?? Promise.resolve(false)
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
    if (requestUrl(request)?.pathname !== "/v1/browser") return
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
    activeTransfers: () => gate.active("browser"),
    close: async () => {
      heartbeatFiber.interruptUnsafe()
      registry.close()
      hubs.close()
      resourceHubs.close()
      await closeSockets(sockets, "Relay shutting down")
      await Effect.runPromise(closeWebSocketServerEffect(wss))
    },
    handleRequest: files.handleRequest,
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
    // Browsers that see this may send their next message, such as a console
    // subscription, right behind their auth instead of waiting for it.
    features: [BROWSER_EARLY_MESSAGES_FEATURE],
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
  // A browser's trace is continued for one auth and one subscription per
  // socket, so it cannot have every message of a busy socket sampled.
  let tracedAuth = false
  let tracedSubscription = false
  // Messages that arrived while the auth was being checked, handled once it
  // is accepted with the same checks as if they had arrived after it.
  let earlyMessages: Array<BrowserMessage> = []
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
    handleMessage(input.value)
  })

  function handleMessage(value: BrowserMessage): void {
    if (!capability) {
      if (authenticationAttempt) {
        if (earlyMessages.length >= MAX_EARLY_BROWSER_MESSAGES) {
          socket.close(4401, "Browser authentication is already in progress")
          return
        }
        earlyMessages.push(value)
        return
      }
      authenticationAttempt = true
      const parent = tracedAuth ? undefined : browserTraceParent(value)
      tracedAuth = true
      forkPromise(
        () =>
          ensuringPromise(
            () =>
              traceRelayPromise(
                "relay.browser.auth",
                () => authenticate(value),
                undefined,
                parent
              ),
            () => {
              authenticationAttempt = false
              const early = earlyMessages
              earlyMessages = []
              // A rejected auth has already closed the socket.
              if (capability)
                for (const message of early) handleMessage(message)
            }
          ),
        () => socket.close(4401, "Browser authentication failed")
      )
      return
    }
    const renewal = decodeBrowserRenew(value)
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
              traceRelayPromise("relay.browser.renew", () =>
                renew(renewal.value)
              ),
            () => {
              authenticationAttempt = false
            }
          ),
        () => socket.close(4403, "Browser renewal failed")
      )
      return
    }
    const consoleSubscription = decodeBrowserSubscription(value)
    if (Option.isSome(consoleSubscription)) {
      const subscription = consoleSubscription.value
      // The capability decides the resource's kind; the subscription only
      // names the resource it is for.
      const resource: RelayConsoleResource = {
        id: capability.instanceId,
        kind: capabilityResourceKind(capability),
        ...(subscription.stream ? { stream: subscription.stream } : {}),
      }
      const source = options.consoleSources(
        resource.kind,
        resource.id,
        resource.stream
      )
      if (
        subscription.instanceId !== resource.id ||
        (capability.version === 2 && capability.operation !== "console") ||
        !registry.isActive(socket, source.readAction)
      ) {
        socket.close(4403, "Console capability does not allow this resource")
        return
      }
      const parent = tracedSubscription ? undefined : browserTraceParent(value)
      tracedSubscription = true
      const subscribe = () =>
        forkPromise(
          () =>
            traceRelayPromise(
              "Subscribe browser console",
              (span) => hubs.subscribe(socket, resource, source, span),
              {
                "kiln.operation": "relay.console.subscribe",
                "kiln.resource.kind": resource.kind,
              },
              parent
            ),
          () => socket.close(4500, "Console stream failed")
        )
      // Some kinds hold the Hearth that issued the capability to more than
      // the read action, as Kiln's services do.
      const { authorize } = source
      if (authorize) {
        const issuer = capability.issuer
        forkPromise(
          async () => {
            await authorize(issuer)
            subscribe()
          },
          () =>
            socket.close(
              4403,
              "Console capability does not allow this resource"
            )
        )
      } else {
        subscribe()
      }
      return
    }
    const resourceSubscription = decodeBrowserResourceSubscription(value)
    if (Option.isSome(resourceSubscription)) {
      const subscription = resourceSubscription.value
      // The capability decides the resource's kind, and the action that
      // reads it.
      const kind = capabilityResourceKind(capability)
      if (
        !isResourceUsageKind(kind) ||
        subscription.instanceId !== capability.instanceId ||
        (capability.version === 2 && capability.operation !== "resources") ||
        !registry.isActive(socket, resourceReadActions[kind])
      ) {
        socket.close(4403, "Resource capability does not allow this instance")
        return
      }
      resourceHubs.subscribe(socket, { id: subscription.instanceId, kind })
      return
    }
    const consoleWrite = decodeBrowserConsoleWrite(value)
    if (Option.isSome(consoleWrite)) {
      const request = consoleWrite.value
      if (
        capabilityResourceKind(capability) !== "instance" ||
        request.instanceId !== capability.instanceId ||
        (capability.version === 2 && capability.operation !== "console") ||
        !registry.isActive(socket, "instance.console.write")
      ) {
        socket.close(4403, "Console capability does not allow writes")
        return
      }
      executeBoundedConsoleOperation(
        request.requestId,
        request.instanceId,
        "console_write_capacity_reached",
        "Too many console operations are pending",
        (ticket) =>
          executeConsoleWrite(
            socket,
            request,
            options,
            capability!,
            outbox,
            ticket,
            () => registry.isActive(socket, "instance.console.write")
          )
      )
      return
    }
    const consoleCompletion = decodeBrowserConsoleComplete(value)
    if (Option.isSome(consoleCompletion)) {
      const request = consoleCompletion.value
      if (
        capabilityResourceKind(capability) !== "instance" ||
        request.instanceId !== capability.instanceId ||
        (capability.version === 2 && capability.operation !== "console") ||
        !registry.isActive(socket, "instance.console.write")
      ) {
        socket.close(4403, "Console capability does not allow completion")
        return
      }
      executeBoundedConsoleOperation(
        request.requestId,
        request.instanceId,
        "console_completion_capacity_reached",
        "Too many completions are pending",
        (ticket) =>
          executeConsoleCompletion(
            socket,
            request,
            options.docker,
            outbox,
            ticket,
            () => registry.isActive(socket, "instance.console.write")
          )
      )
      return
    }
    socket.close(4400, "Invalid browser operation")
  }

  // Console input still waiting its turn is withdrawn when the browser goes.
  const consoleTickets = new Set<LaneTicket>()
  socket.once("close", () => {
    clearTimeout(timer)
    for (const ticket of consoleTickets) ticket.cancel()
  })

  function executeBoundedConsoleOperation(
    requestId: string,
    instanceId: string,
    code: string,
    message: string,
    operation: (ticket: LaneTicket) => Promise<void>
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
    // Input takes its place in the server's power lane as it arrives, so it
    // stays in order with power changes and other consoles.
    const ticket = options.lanes.admit({
      label: "browser.console",
      locks: /^[a-f0-9]{40}$/u.test(instanceId)
        ? instanceLifecycleLocks(instanceId)
        : recoverPromise(
            async () =>
              (await options.docker.findInstance(instanceId))?.id ?? instanceId,
            () => instanceId
          ).then(instanceLifecycleLocks),
    })
    consoleTickets.add(ticket)
    forkPromise(
      () =>
        ensuringPromise(
          () => operation(ticket),
          () => {
            ticket.cancel()
            consoleTickets.delete(ticket)
            pendingConsoleOperations -= 1
          }
        ),
      () => undefined
    )
  }

  async function authenticate(value: unknown): Promise<void> {
    if (Date.now() > challenge.expiresAt || capability) {
      throw new Error("Browser challenge expired")
    }
    const auth = Schema.decodeUnknownSync(BrowserAuthSchema)(value)
    const parsed = decodeCapability(auth.capability)
    const clientConfiguration = registry.clientConfiguration
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
              instanceId: serverScopeId(parsed.payload),
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
    if (clientConfiguration !== registry.clientConfiguration) {
      throw new Error("Capability issuer changed during authentication")
    }
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
        instanceId: serverScopeId(parsed.payload),
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
  ticket: LaneTicket,
  authorize: () => boolean
): Promise<void> {
  await runBrowser(
    ticket
      .run(
        timedBrowserOperation(
          "Execute browser console write",
          "relay.browser.console.write",
          async () => {
            const instance = await options.docker.findInstance(
              request.instanceId
            )
            if (!instance) throw new Error("Instance not found")
            if (!authorize()) throw new Error("Browser authorization changed")
            const input = relayConsoleCommandSchema.parse({
              command: request.command,
            })
            const { intentionalStop } = await options.docker.sendCommand(
              instance,
              input.command
            )
            if (intentionalStop) options.onConsoleStop(instance.id)
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
        )
      )
      .pipe(
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
          reportRelayError(cause, { operation: "browser.console.audit" })
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
  ticket: LaneTicket,
  authorize: () => boolean
): Promise<void> {
  await runBrowser(
    ticket
      .run(
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
        )
      )
      .pipe(
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

function renewalChallenge(capabilityExpiresAt: number) {
  return {
    nonce: randomBytes(32).toString("base64url"),
    nonceExpiresAt: capabilityExpiresAt,
  }
}

type BrowserDelivery = (
  socket: WebSocket,
  encoded: string,
  kind: BrowserOutboxKind,
  action?: string
) => boolean

// Resolves once a socket's outbox has room for `bytes` more, or false once
// the socket is gone.
type BrowserRoom = (socket: WebSocket, bytes: number) => Promise<boolean>

// One hub per resource, keyed by its kind and ID, shared by every socket
// following that resource's console.
class ConsoleHubRegistry {
  readonly #deliver: BrowserDelivery
  readonly #room: BrowserRoom
  readonly #hubs = new Map<string, ConsoleHub>()
  readonly #pendingHubs = new Map<string, Fiber.Fiber<ConsoleHub, Error>>()
  readonly #subscribeSnapshots: BrowserSocketOptions["subscribeSnapshots"]
  readonly #subscriptions = new Map<WebSocket, string>()
  // Each socket's latest subscription. One it replaced while its hub was
  // still starting is settled as left instead of joining the hub.
  readonly #subscriptionTokens = new Map<WebSocket, symbol>()

  constructor(
    subscribeSnapshots: BrowserSocketOptions["subscribeSnapshots"],
    deliver: BrowserDelivery,
    room: BrowserRoom
  ) {
    this.#subscribeSnapshots = subscribeSnapshots
    this.#deliver = deliver
    this.#room = room
  }

  // Resolves once the socket has been sent its session, or has left.
  subscribe(
    socket: WebSocket,
    resource: RelayConsoleResource,
    source: ConsoleSource,
    span?: Tracer.Span
  ): Promise<void> {
    const key = `${resource.kind}:${resource.id}:${resource.stream ?? ""}`
    const token = Symbol(key)
    this.remove(socket)
    this.#subscriptions.set(socket, key)
    this.#subscriptionTokens.set(socket, token)
    let hubEffect: Effect.Effect<ConsoleHub, Error>
    const existingHub = this.#hubs.get(key)
    if (existingHub) {
      span?.attribute("kiln.console.hub", "existing")
      hubEffect = Effect.succeed(existingHub)
    } else {
      let pending = this.#pendingHubs.get(key)
      span?.attribute("kiln.console.hub", pending ? "pending" : "new")
      if (!pending) {
        pending = Effect.runFork(
          this.#createHubEffect(key, resource.id, source, span)
        )
        this.#pendingHubs.set(key, pending)
      }
      hubEffect = Fiber.join(pending).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.#pendingHubs.get(key) === pending) {
              this.#pendingHubs.delete(key)
            }
          })
        )
      )
    }
    return Effect.runPromise(
      hubEffect.pipe(
        Effect.flatMap((hub) =>
          Effect.callback<void>((resume) => {
            if (
              this.#subscriptionTokens.get(socket) !== token ||
              socket.readyState !== WebSocket.OPEN
            ) {
              const hasWaitingSubscriber = [
                ...this.#subscriptions.values(),
              ].some((subscribedKey) => subscribedKey === key)
              if (hub.subscriberCount === 0 && !hasWaitingSubscriber) {
                hub.close()
              }
              span?.attribute("kiln.console.result", "left")
              resume(Effect.void)
              return
            }
            hub.add(socket, (sent) => {
              span?.attribute("kiln.console.result", sent ? "sent" : "left")
              resume(Effect.void)
            })
          })
        )
      )
    )
  }

  remove(socket: WebSocket): void {
    const key = this.#subscriptions.get(socket)
    if (!key) return
    this.#subscriptions.delete(socket)
    this.#subscriptionTokens.delete(socket)
    this.#hubs.get(key)?.remove(socket)
  }

  close(): void {
    for (const pending of this.#pendingHubs.values()) {
      pending.interruptUnsafe()
    }
    this.#pendingHubs.clear()
    for (const hub of this.#hubs.values()) hub.close()
    this.#hubs.clear()
    this.#subscriptions.clear()
    this.#subscriptionTokens.clear()
  }

  // `span` is the subscription that asked for the hub, which its discovery
  // and first history read nest under.
  #createHubEffect(
    key: string,
    resourceId: string,
    source: ConsoleSource,
    span?: Tracer.Span
  ): Effect.Effect<ConsoleHub, Error> {
    return timedBrowserOperation(
      "Discover console session",
      "relay.console.discovery",
      (signal) => source.session(signal),
      span
    ).pipe(
      Effect.map((session) => {
        const hub = new ConsoleHub(
          source,
          resourceId,
          session,
          this.#subscribeSnapshots,
          this.#deliver,
          this.#room,
          () => {
            if (hub.subscriberCount === 0) this.#hubs.delete(key)
          },
          span
        )
        this.#hubs.set(key, hub)
        return hub
      })
    )
  }
}

type ResourceUsageKind = "app" | "database" | "instance"

// The action that reads each kind's usage.
const resourceReadActions = {
  app: "app.read",
  database: "database.read",
  instance: "instance.read",
} as const satisfies Record<ResourceUsageKind, string>

function isResourceUsageKind(kind: string): kind is ResourceUsageKind {
  return Object.hasOwn(resourceReadActions, kind)
}

interface ResourceSubscription {
  readonly id: string
  readonly kind: ResourceUsageKind
}

// Delivers each subscribed resource's usage with every snapshot sample, so
// game servers', Apps', and databases' arrive on one loop.
class ResourceHubRegistry {
  readonly #deliver: BrowserDelivery
  readonly #docker: DockerDriver
  readonly #historyDelivered = new Set<WebSocket>()
  readonly #room: BrowserRoom
  readonly #subscribeSnapshots: BrowserSocketOptions["subscribeSnapshots"]
  readonly #subscriptions = new Map<WebSocket, ResourceSubscription>()
  readonly #workloadUsage: BrowserSocketOptions["workloadUsage"]
  #lastSample: RelaySnapshotSample | null = null
  #unsubscribe: (() => void) | null = null

  constructor(
    docker: DockerDriver,
    workloadUsage: BrowserSocketOptions["workloadUsage"],
    subscribeSnapshots: BrowserSocketOptions["subscribeSnapshots"],
    deliver: BrowserDelivery,
    room: BrowserRoom
  ) {
    this.#docker = docker
    this.#room = room
    this.#workloadUsage = workloadUsage
    this.#subscribeSnapshots = subscribeSnapshots
    this.#deliver = deliver
  }

  subscribe(socket: WebSocket, subscription: ResourceSubscription): void {
    this.#subscriptions.set(socket, subscription)
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
    const groups = new Map<
      string,
      { subscription: ResourceSubscription; sockets: Array<WebSocket> }
    >()
    for (const [subscriber, subscription] of this.#subscriptions) {
      if (only && subscriber !== only) continue
      const key = `${subscription.kind}:${subscription.id}`
      const group = groups.get(key) ?? { sockets: [], subscription }
      group.sockets.push(subscriber)
      groups.set(key, group)
    }
    let instances: ReadonlyMap<string, RelayInstance> | null = null
    for (const { sockets, subscription } of groups.values()) {
      let events: {
        live: string
        withHistory: () => ReadonlyArray<string>
      } | null
      if (subscription.kind === "instance") {
        instances ??= new Map(
          sample.snapshot.instances.map((instance) => [instance.id, instance])
        )
        events = this.#instanceEvents(
          instances,
          subscription.id,
          sample.sequence
        )
      } else {
        events = this.#workloadEvents(
          subscription.kind,
          subscription.id,
          sample.sequence
        )
      }
      if (!events) continue
      let withHistory: ReadonlyArray<string> | null = null
      const action = resourceReadActions[subscription.kind]
      for (const subscriber of sockets) {
        if (this.#historyDelivered.has(subscriber)) {
          // A live sample replaces the one still waiting, as it's older.
          this.#deliver(subscriber, events.live, "resource", action)
          continue
        }
        this.#historyDelivered.add(subscriber)
        withHistory ??= events.withHistory()
        this.#deliverHistory(subscriber, withHistory, action)
      }
    }
  }

  // History queues in order, as console lines do, a frame at a time as the
  // outbox has room, so a large App's never overflows it and none is lost.
  #deliverHistory(
    socket: WebSocket,
    frames: ReadonlyArray<string>,
    action: string
  ): void {
    const send = Effect.gen({ self: this }, function* () {
      for (const frame of frames) {
        const open = yield* Effect.promise(() =>
          this.#room(socket, Buffer.byteLength(frame))
        )
        if (!open || !this.#subscriptions.has(socket)) return
        this.#deliver(socket, frame, "console", action)
      }
    })
    Effect.runFork(send)
  }

  #instanceEvents(
    instances: ReadonlyMap<string, RelayInstance>,
    instanceId: string,
    sequence: number
  ) {
    const current = instances.get(instanceId)
    if (!current) return null
    const instance = projectRelayInstanceOverview(current)
    const event = (history: ReadonlyArray<RelayInstanceResources>) =>
      JSON.stringify({ history, instance, sequence, type: "resource" })
    return {
      live: event([]),
      withHistory: () => [event(this.#docker.resourceHistory(instanceId))],
    }
  }

  // Each event carries the latest samples. The minutes before follow a new
  // subscriber in one event per history, the resource's and then each
  // service's, so no frame holds more than one window of samples.
  #workloadEvents(
    kind: RelayWorkloadResourceKind,
    id: string,
    sequence: number
  ) {
    const event = (history: RelayWorkloadUsageHistory) => {
      const usage = this.#workloadUsage(kind, id, history)
      return JSON.stringify({ ...usage, id, kind, sequence, type: "resource.usage" })
    }
    const live = event("none")
    return {
      live,
      withHistory: () => [
        event("resource"),
        ...this.#workloadUsage(kind, id, "none").services.map((service) =>
          event({ service: service.service })
        ),
      ],
    }
  }
}

class ConsoleHub {
  readonly #backgroundFibers = new Set<Fiber.Fiber<void, never>>()
  readonly #deliver: BrowserDelivery
  readonly #room: BrowserRoom
  // Sent as `instanceId` in console frames, whatever the resource's kind.
  readonly #resourceId: string
  readonly #source: ConsoleSource
  // Recently sent history frames, by the position they end at.
  readonly #historyFrames = new Map<number, HistoryFrame>()
  // Where each browser still being sent history is up to.
  readonly #historyReaders = new Map<WebSocket, { position: number }>()
  readonly #lineIds = new Set<string>()
  readonly #onEmpty: () => void
  // Told whether each new subscriber was sent its session or left first.
  readonly #sessionWaiters = new Map<WebSocket, (sent: boolean) => void>()
  // The session's newest output, within MAX_CONSOLE_HISTORY_LINES and
  // MAX_CONSOLE_HISTORY_CHARACTERS.
  readonly #recent: Array<RelayConsoleLine> = []
  readonly #subscribers = new Set<WebSocket>()
  // Lines appended this session. The line `n` from the end of `#recent` is
  // at position `#appended - n`, which stays put as older lines are trimmed
  // or backfilled.
  #appended = 0
  #backfillStartedAt: string | null | undefined
  #closed = false
  // The subscription that created the hub, which its first read nests under.
  #firstReadParent: Tracer.Span | undefined
  #historyFrameCharacters = 0
  #graceFiber: Fiber.Fiber<void, never> | null = null
  #recentCharacters = 0
  // Changes with each session, which ends history still being sent for the
  // last.
  #session = 0
  #nextSession: DockerConsoleSession | null
  #sessionFloor: string | null = null
  #sessionLifecycle: Array<RelayInstanceLifecycleEvent> | undefined
  #streamFiber: Fiber.Fiber<void, never> | null = null
  #transitionStartedAt: string | null = null
  #truncated = false
  #unsubscribeSnapshots: (() => void) | null

  constructor(
    source: ConsoleSource,
    resourceId: string,
    session: DockerConsoleSession,
    subscribeSnapshots: BrowserSocketOptions["subscribeSnapshots"],
    deliver: BrowserDelivery,
    room: BrowserRoom,
    onEmpty: () => void,
    firstReadParent?: Tracer.Span
  ) {
    this.#deliver = deliver
    this.#firstReadParent = firstReadParent
    this.#room = room
    this.#resourceId = resourceId
    this.#source = source
    this.#nextSession = session
    this.#onEmpty = onEmpty
    this.#unsubscribeSnapshots = source.lifecycle
      ? subscribeSnapshots((sample) => {
          this.#observeSnapshot(sample)
        })
      : null
  }

  get subscriberCount(): number {
    return this.#subscribers.size
  }

  add(socket: WebSocket, onSession?: (sent: boolean) => void): void {
    if (this.#closed) {
      onSession?.(false)
      return
    }
    this.#graceFiber?.interruptUnsafe()
    this.#graceFiber = null
    this.#subscribers.add(socket)
    if (onSession) {
      this.#notifySession(socket, false)
      this.#sessionWaiters.set(socket, onSession)
    }
    if (this.#sessionLifecycle !== undefined) this.#sendSession(socket)
    this.#startStream()
  }

  remove(socket: WebSocket): void {
    this.#notifySession(socket, false)
    this.#subscribers.delete(socket)
    this.#historyReaders.delete(socket)
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
    for (const socket of this.#sessionWaiters.keys()) {
      this.#notifySession(socket, false)
    }
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
            reportRelayError(cause, { operation: "browser.console.stream" })
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
          (signal) => session.history(200, signal),
          this.#takeFirstReadParent()
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
                if (snapshot.truncated) {
                  this.#forkBackground(
                    this.#backfillEffect(session, startedAt),
                    "browser.console.backfill"
                  )
                }
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

  #takeFirstReadParent(): Tracer.Span | undefined {
    const parent = this.#firstReadParent
    this.#firstReadParent = undefined
    return parent
  }

  #takeSessionEffect(): Effect.Effect<DockerConsoleSession, Error> {
    const session = this.#nextSession
    this.#nextSession = null
    return session
      ? Effect.succeed(session)
      : timedBrowserOperation(
          "Rediscover console session",
          "relay.console.discovery",
          (signal) => this.#source.session(signal)
        )
  }

  #forkBackground(effect: Effect.Effect<void, Error>, operation: string): void {
    let fiber: Fiber.Fiber<void, never>
    fiber = Effect.runFork(
      effect.pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            if (!this.#closed) {
              reportRelayError(cause, { operation: operation })
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
    this.#recentCharacters += consoleLineCharacters(line)
    this.#appended += 1
    this.#trim()
    const encoded = encodeConsoleLineFrame(line)
    for (const socket of this.#subscribers) {
      this.#deliver(socket, encoded, "console", this.#source.readAction)
    }
  }

  // Drops the oldest lines past the line or character budget, returning how
  // many it dropped.
  #trim(): number {
    let removed = 0
    while (
      this.#recent.length > MAX_CONSOLE_HISTORY_LINES ||
      (this.#recentCharacters > MAX_CONSOLE_HISTORY_CHARACTERS &&
        this.#recent.length > 1)
    ) {
      const line = this.#recent.shift()!
      this.#recentCharacters -= consoleLineCharacters(line)
      this.#lineIds.delete(line.id)
      this.#truncated = true
      removed += 1
    }
    return removed
  }

  #observeSnapshot(sample: RelaySnapshotSample): void {
    if (this.#closed || this.#sessionLifecycle === undefined) {
      return
    }
    const lifecycle = this.#source.lifecycle?.(sample)
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
    this.#session += 1
    // History still being sent is for the last session.
    this.#historyReaders.clear()
    this.#clearHistoryFrames()
    this.#backfillStartedAt = undefined
    this.#truncated = snapshot.truncated
    this.#recent.splice(0, this.#recent.length, ...snapshot.lines)
    this.#recentCharacters = 0
    this.#lineIds.clear()
    for (const line of snapshot.lines) {
      this.#lineIds.add(line.id)
      this.#recentCharacters += consoleLineCharacters(line)
    }
    this.#appended = snapshot.lines.length
    this.#trim()
    for (const socket of this.#subscribers) this.#sendSession(socket)
  }

  #transitionSessionEffect(startedAt: string): Effect.Effect<void, Error> {
    return timedBrowserOperation(
      "Discover replacement console session",
      "relay.console.discovery",
      (signal) => this.#source.session(signal)
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
              if (snapshot.truncated) {
                this.#forkBackground(
                  this.#backfillEffect(session, startedAt),
                  "browser.console.backfill"
                )
              }
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
          for (const line of fresh) {
            this.#lineIds.add(line.id)
            this.#recentCharacters += consoleLineCharacters(line)
          }
          this.#recent.unshift(...fresh)
          this.#truncated ||= history.truncated
          const kept = fresh.slice(this.#trim())
          if (kept.length === 0) return
          // Browsers still being sent history reach these lines in turn.
          for (const socket of this.#subscribers) {
            if (
              socket.protocol === relayBrowserConsoleProtocol &&
              !this.#historyReaders.has(socket)
            ) {
              this.#sendHistory(socket, this.#position(kept.length))
            }
          }
        })
      ),
      Effect.asVoid
    )
  }

  #notifySession(socket: WebSocket, sent: boolean): void {
    const waiter = this.#sessionWaiters.get(socket)
    if (!waiter) return
    this.#sessionWaiters.delete(socket)
    waiter(sent)
  }

  #sendSession(socket: WebSocket): void {
    this.#deliverSession(socket)
    this.#notifySession(socket, true)
  }

  #deliverSession(socket: WebSocket): void {
    const lifecycle = this.#sessionLifecycle ?? []
    const snapshotStart = Math.max(0, this.#recent.length - 200)
    if (socket.protocol === relayBrowserProtocol) {
      this.#deliver(
        socket,
        JSON.stringify({
          type: "ready",
          instanceId: this.#resourceId,
          lifecycle,
        }),
        "console",
        this.#source.readAction
      )
      for (const line of this.#recent.slice(snapshotStart)) {
        this.#deliver(
          socket,
          encodeConsoleLineFrame(line),
          "console",
          this.#source.readAction
        )
      }
      return
    }

    const reset = encodeNewestConsoleBatch(
      {
        type: "reset",
        instanceId: this.#resourceId,
        lifecycle,
        lines: this.#recent.slice(snapshotStart),
        truncated: this.#truncated || snapshotStart > 0,
      },
      RESET_FRAME_BYTES
    )
    this.#deliver(socket, reset.encoded, "console", this.#source.readAction)
    this.#deliver(
      socket,
      JSON.stringify({
        type: "ready",
        instanceId: this.#resourceId,
        lifecycle,
      }),
      "console",
      this.#source.readAction
    )
    // Any history the socket was still being sent is replaced by this.
    this.#historyReaders.delete(socket)
    this.#sendHistory(socket, this.#position(snapshotStart + reset.start))
  }

  // The position of the line at `index` in `#recent`.
  #position(index: number): number {
    return this.#appended - this.#recent.length + index
  }

  // Sends `socket` the session's lines before `position` as history, newest
  // first, a frame at a time as its outbox empties. Each frame is made only
  // once there's room for it, so a slow browser keeps no history of its own
  // waiting in the Relay. Lines never change, so the history meets the reset
  // or lines it continues from without a gap, however long the browser
  // takes; it ends early if older lines are trimmed meanwhile, the socket
  // leaves, or the session changes.
  #sendHistory(socket: WebSocket, position: number): void {
    if (position <= this.#position(0)) return
    const reader = { position }
    const session = this.#session
    this.#historyReaders.set(socket, reader)
    this.#forkBackground(
      Effect.gen({ self: this }, function* () {
        for (;;) {
          const open = yield* Effect.promise(() =>
            this.#room(socket, relayBrowserMaxFrameBytes)
          )
          const end = reader.position - this.#position(0)
          if (
            !open ||
            end <= 0 ||
            this.#closed ||
            this.#session !== session ||
            this.#historyReaders.get(socket) !== reader ||
            !this.#subscribers.has(socket)
          ) {
            return
          }
          const frame = this.#historyFrame(reader.position)
          this.#deliver(
            socket,
            frame.encoded,
            "console",
            this.#source.readAction
          )
          if (frame.start <= this.#position(0)) return
          reader.position = frame.start
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.#historyReaders.get(socket) === reader) {
              this.#historyReaders.delete(socket)
            }
            if (this.#historyReaders.size === 0) this.#clearHistoryFrames()
          })
        )
      ),
      "browser.console.history"
    )
  }

  // The history frame of the newest lines before `position` that fit in
  // one, and the position of its oldest line. Browsers sent the same history
  // together, such as when they all reconnect, share the frames: one that
  // stops short of the oldest kept line holds the same lines whatever else
  // changes in the session, so it's kept a while for the next browser.
  #historyFrame(position: number): HistoryFrame {
    const cached = this.#historyFrames.get(position)
    if (cached) return cached
    const batch = encodeConsoleHistoryFrame(
      {
        instanceId: this.#resourceId,
        lifecycle: this.#sessionLifecycle ?? [],
        lines: this.#recent,
        truncated: this.#truncated,
      },
      position - this.#position(0)
    )
    const frame = {
      encoded: batch.encoded,
      start: this.#position(batch.start),
    }
    if (batch.start > 0) {
      this.#historyFrames.set(position, frame)
      this.#historyFrameCharacters += frame.encoded.length
      for (const [key, evicted] of this.#historyFrames) {
        if (this.#historyFrameCharacters <= MAX_HISTORY_FRAME_CHARACTERS) break
        this.#historyFrames.delete(key)
        this.#historyFrameCharacters -= evicted.encoded.length
      }
    }
    return frame
  }

  #clearHistoryFrames(): void {
    this.#historyFrames.clear()
    this.#historyFrameCharacters = 0
  }
}

// The most a console's first frame holds, in bytes. A new connection sends
// about 14 KB before the browser's first acknowledgement, so a larger frame
// takes a round trip more to arrive; older lines follow it as history.
const RESET_FRAME_BYTES = 10 * 1024

// Recently encoded history frames a console keeps for browsers being sent
// the same history, in characters: up to 32 full frames.
const MAX_HISTORY_FRAME_CHARACTERS = 32 * relayBrowserMaxFrameBytes

interface HistoryFrame {
  readonly encoded: string
  // The position of its oldest line.
  readonly start: number
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

function runBrowser<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect)
}

function browserOperation<TResult>(
  run: (signal: AbortSignal) => Promise<TResult>
): Effect.Effect<TResult, Error> {
  return Effect.tryPromise({ try: run, catch: asError })
}

function timedBrowserOperation<TResult>(
  name: string,
  op: string,
  run: (signal: AbortSignal) => Promise<TResult>,
  parent?: Tracer.AnySpan
): Effect.Effect<TResult, Error> {
  return browserOperation((signal) =>
    traceRelayPromise(name, () => run(signal), { "kiln.operation": op }, parent)
  )
}

// The browser span a message continues, from its W3C `traceparent`, so the
// Relay's work joins the browser's trace and follows its sampling.
function browserTraceParent(value: unknown): Tracer.ExternalSpan | undefined {
  return value && typeof value === "object" && "traceparent" in value
    ? traceParentSpan(value.traceparent)
    : undefined
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function parseProtocols(value: string | undefined): ReadonlyArray<string> {
  return value?.split(",").map((protocol) => protocol.trim()) ?? []
}
