import { generateKeyPairSync, sign } from "node:crypto"
import { WebSocket } from "ws"

import {
  relayBrowserConsoleProtocol,
  relayBrowserProofTranscript,
  relayBrowserConsoleProtocols,
  relayBrowserMaxFrameBytes,
  relayBrowserProtocol,
  relayConsoleStreamEventSchema,
} from "@workspace/contracts"
import type { RelayConsoleStreamEvent } from "@workspace/contracts"
import { Effect, Result, Stream } from "effect"

import type {
  AuthenticatedRealtimeIdentity,
  AuthenticatedUser,
} from "@/lib/auth-session"
import { kilnPublicUrl } from "@/lib/environment"
import { forkPromise } from "@/effect/promise"
import { relayControlEndpoint } from "@/lib/relay-connection"
import {
  prepareConsoleCapabilityForIdentity,
  prepareConsoleCapabilityForUser,
} from "@/server/relay-capability-service"

const MAX_INBOX_BYTES = 2 * 1024 * 1024
const MAX_INBOX_MESSAGES = 256
const AUTHENTICATION_TIMEOUT_MS = 10_000

export async function* openHearthRelayConsoleStream(input: {
  credentialId?: string
  instanceId: string
  relayId: string
  signal: AbortSignal
  identity?: AuthenticatedRealtimeIdentity
  user?: AuthenticatedUser
}): AsyncGenerator<RelayConsoleStreamEvent> {
  if (input.signal.aborted) throw new Error("Console proxy was cancelled")
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const publicKeyJwk = keys.publicKey.export({ format: "jwk" })
  const browserKey = {
    crv: "P-256" as const,
    kty: "EC" as const,
    x: requiredCoordinate(publicKeyJwk.x),
    y: requiredCoordinate(publicKeyJwk.y),
  }
  if (!input.identity && (!input.user || !input.credentialId)) {
    throw new Error("Authentication required")
  }
  const prepared = input.identity
    ? await prepareConsoleCapabilityForIdentity({
        identity: input.identity,
        instanceId: input.instanceId,
        publicKeyJwk: browserKey,
        relayId: input.relayId,
      })
    : await prepareConsoleCapabilityForUser({
        credentialId: input.credentialId!,
        instanceId: input.instanceId,
        publicKeyJwk: browserKey,
        relayId: input.relayId,
        user: input.user!,
      })
  const { capability, relay, relayCaCertificatePem } = prepared
  const control = relayControlEndpoint(relay)
  const protocol = control.useTls ? "wss" : "ws"
  const socket = new WebSocket(
    `${protocol}://${formatHost(control.hostname)}:${control.port}/v1/browser`,
    [...relayBrowserConsoleProtocols],
    {
      ca: control.useTls ? (relayCaCertificatePem ?? undefined) : undefined,
      handshakeTimeout: 5_000,
      maxPayload: relayBrowserMaxFrameBytes,
      origin: kilnPublicUrl().origin,
      perMessageDeflate: false,
      rejectUnauthorized: control.useTls,
    }
  )
  const inbox = createSocketInbox(socket, input.signal)
  let activeCapability = capability
  let renewalTimer: ReturnType<typeof setTimeout> | null = null

  const scheduleRenewal = (message: Record<string, unknown>) => {
    if (activeCapability.version !== 2) return
    const nonce = message.renewalNonce
    const nonceExpiresAt = message.renewalNonceExpiresAt
    const sessionId = message.sessionId
    if (
      typeof nonce !== "string" ||
      typeof nonceExpiresAt !== "number" ||
      typeof sessionId !== "string"
    ) {
      throw new Error("Relay omitted its console renewal challenge")
    }
    if (renewalTimer) clearTimeout(renewalTimer)
    renewalTimer = setTimeout(
      () => {
        renewalTimer = null
        forkPromise(
          async () => {
            const renewed = input.identity
              ? await prepareConsoleCapabilityForIdentity({
                  identity: input.identity,
                  instanceId: input.instanceId,
                  publicKeyJwk: browserKey,
                  relayId: input.relayId,
                })
              : await prepareConsoleCapabilityForUser({
                  credentialId: input.credentialId!,
                  instanceId: input.instanceId,
                  publicKeyJwk: browserKey,
                  relayId: input.relayId,
                  user: input.user!,
                })
            if (renewed.capability.version !== 2) {
              throw new Error("Relay console renewal downgraded capability v2")
            }
            const proof = sign(
              "sha256",
              Buffer.from(
                relayBrowserProofTranscript(
                  {
                    capabilityId: capabilityId(renewed.capability.capability),
                    expiresAt: nonceExpiresAt,
                    nonce,
                    relayId: input.relayId,
                    sessionId,
                  },
                  socket.protocol === relayBrowserConsoleProtocol
                    ? relayBrowserConsoleProtocol
                    : relayBrowserProtocol
                )
              ),
              { dsaEncoding: "ieee-p1363", key: keys.privateKey }
            )
            if (socket.readyState !== WebSocket.OPEN) return
            socket.send(
              JSON.stringify({
                capability: renewed.capability.capability,
                signature: proof.toString("base64url"),
                type: "auth.renew",
                v: 1,
              })
            )
            activeCapability = renewed.capability
          },
          () => {
            closeSocket(socket, 4403, "Console authorization renewal failed")
          }
        )
      },
      Math.max(
        1_000,
        Math.min(activeCapability.expiresAt, nonceExpiresAt) -
          Date.now() -
          10_000
      )
    )
    renewalTimer.unref()
  }

  yield* managedAsyncIterable(
    (async function* () {
      const challenge = await nextAuthenticationMessage(inbox, "challenge")
      if (
        challenge.type !== "auth.challenge" ||
        challenge.relayId !== input.relayId ||
        typeof challenge.sessionId !== "string" ||
        typeof challenge.nonce !== "string" ||
        typeof challenge.expiresAt !== "number" ||
        challenge.expiresAt <= Date.now()
      ) {
        throw new Error("Relay returned an invalid console challenge")
      }
      const proof = sign(
        "sha256",
        Buffer.from(
          relayBrowserProofTranscript(
            {
              capabilityId: capabilityId(activeCapability.capability),
              expiresAt: challenge.expiresAt,
              nonce: challenge.nonce,
              relayId: input.relayId,
              sessionId: challenge.sessionId,
            },
            socket.protocol === relayBrowserConsoleProtocol
              ? relayBrowserConsoleProtocol
              : relayBrowserProtocol
          )
        ),
        { dsaEncoding: "ieee-p1363", key: keys.privateKey }
      )
      socket.send(
        JSON.stringify({
          capability: activeCapability.capability,
          publicKeyJwk: browserKey,
          signature: proof.toString("base64url"),
          type: "auth",
          v: 1,
        })
      )
      const ready = await nextAuthenticationMessage(inbox, "confirmation")
      if (
        ready.type !== "auth.ready" ||
        ready.instanceId !== input.instanceId
      ) {
        throw new Error("Relay rejected the Hearth console proxy")
      }
      if (activeCapability.version === 2) scheduleRenewal(ready)
      socket.send(
        JSON.stringify({
          instanceId: input.instanceId,
          type: "console.subscribe",
          v: 1,
        })
      )

      for (;;) {
        // The socket is one ordered stream; concurrent reads could reorder lines.
        // oxlint-disable-next-line react-doctor/async-await-in-loop
        const message = await inbox.next()
        if (message.type === "auth.renewed") {
          scheduleRenewal({ ...message, sessionId: challenge.sessionId })
          continue
        }
        yield relayConsoleStreamEventSchema.parse(message)
      }
    })(),
    () => {
      if (renewalTimer) clearTimeout(renewalTimer)
      inbox.close()
      closeSocket(socket, 1000, "Hearth console proxy closed")
    }
  )
}

async function nextAuthenticationMessage(
  inbox: { next: () => Promise<Record<string, unknown>> },
  stage: string
): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        Promise.race([
          inbox.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error(`Relay authentication ${stage} timed out`)),
              AUTHENTICATION_TIMEOUT_MS
            )
            timer.unref()
          }),
        ]),
      catch: asError,
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (timer) clearTimeout(timer)
        })
      )
    )
  )
}

function createSocketInbox(socket: WebSocket, signal: AbortSignal) {
  const messages: Array<{
    bytes: number
    value: Record<string, unknown>
  }> = []
  const waiters: Array<{
    reject: (cause: Error) => void
    resolve: (value: Record<string, unknown>) => void
  }> = []
  let queuedBytes = 0
  let terminalError: Error | null = null
  const fail = (cause: Error) => {
    terminalError ??= cause
    messages.splice(0)
    queuedBytes = 0
    for (const waiter of waiters.splice(0)) waiter.reject(cause)
  }
  const failAndClose = (cause: Error, code: number, reason: string) => {
    fail(cause)
    if (socket.readyState === WebSocket.OPEN) socket.close(code, reason)
  }
  const receive = (data: Buffer, binary: boolean) => {
    if (terminalError) return
    if (binary) {
      failAndClose(
        new Error("Relay returned an unsupported binary console frame"),
        1003,
        "Binary console frames are unsupported"
      )
      return
    }
    const decoded = Result.try({
      try: () => JSON.parse(data.toString()) as unknown,
      catch: asError,
    })
    Result.match(decoded, {
      onFailure: (cause) => {
        failAndClose(cause, 1007, "Invalid console message")
      },
      onSuccess: (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          failAndClose(
            new Error("Relay returned an invalid console message"),
            1007,
            "Invalid console message"
          )
          return
        }
        const message = Object.fromEntries(Object.entries(value))
        const waiter = waiters.shift()
        if (waiter) waiter.resolve(message)
        else {
          if (
            messages.length >= MAX_INBOX_MESSAGES ||
            queuedBytes + data.byteLength > MAX_INBOX_BYTES
          ) {
            failAndClose(
              new Error("Relay console proxy exceeded its backpressure limit"),
              1013,
              "Console proxy backpressure exceeded"
            )
            return
          }
          messages.push({ bytes: data.byteLength, value: message })
          queuedBytes += data.byteLength
        }
      },
    })
  }
  const failed = (cause: Error) => fail(cause)
  const closed = (code: number, reason: Buffer) =>
    fail(
      new Error(
        reason.length
          ? reason.toString()
          : `Relay console connection closed (${code})`
      )
    )
  const abort = () => {
    fail(new Error("Console proxy was cancelled"))
    closeSocket(socket, 1000, "Console proxy cancelled")
  }
  socket.on("message", receive)
  socket.once("error", failed)
  socket.once("close", closed)
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  return {
    close: () => {
      signal.removeEventListener("abort", abort)
      socket.off("message", receive)
      socket.off("error", failed)
      socket.off("close", closed)
      fail(new Error("Console proxy inbox closed"))
    },
    next: () => {
      const queued = messages.shift()
      if (queued) {
        queuedBytes -= queued.bytes
        return Promise.resolve(queued.value)
      }
      if (terminalError) return Promise.reject(terminalError)
      return new Promise<Record<string, unknown>>((resolve, reject) =>
        waiters.push({ reject, resolve })
      )
    },
  }
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(code, reason)
    return
  }
  if (socket.readyState === WebSocket.CONNECTING) {
    // ws reports an aborted handshake through "error"; retain a listener even
    // after the inbox detaches so cancellation cannot become an uncaught error.
    socket.once("error", () => undefined)
    socket.terminate()
  }
}

function capabilityId(capability: string): string {
  const encoded = capability.split(".", 1)[0]
  if (!encoded) throw new Error("Hearth created an invalid Relay capability")
  const value = Result.getOrThrowWith(
    Result.try({
      try: () =>
        JSON.parse(Buffer.from(encoded, "base64url").toString()) as unknown,
      catch: asError,
    }),
    () => new Error("Hearth created an invalid Relay capability")
  )
  if (!value || typeof value !== "object" || !("capabilityId" in value)) {
    throw new Error("Hearth created an invalid Relay capability")
  }
  const id = Object.fromEntries(Object.entries(value)).capabilityId
  if (typeof id !== "string") {
    throw new Error("Hearth created an invalid Relay capability")
  }
  return id
}

async function* managedAsyncIterable<T>(
  source: AsyncIterable<T>,
  close: () => void
): AsyncGenerator<T> {
  yield* Stream.toAsyncIterable(
    Stream.fromAsyncIterable(source, asError).pipe(
      Stream.ensuring(Effect.sync(close))
    )
  )
}

function requiredCoordinate(value: string | undefined): string {
  if (!value) throw new Error("Hearth could not create a console proxy key")
  return value
}

function formatHost(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname
}

function asError(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new Error("Relay console proxy failed")
}
