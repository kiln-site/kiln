import { createHash, generateKeyPairSync, sign } from "node:crypto"
import type { KeyObject } from "node:crypto"
import { createServer } from "node:http"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { WebSocket } from "ws"

import {
  relayBrowserConsoleProtocol,
  relayBrowserProofTranscript,
  type RelayBrowserCapabilityV2,
} from "@workspace/contracts"

import { attachBrowserSocket } from "./browser-socket.js"
import type { BrowserSocketServer } from "./browser-socket.js"
import type { RelayStateStore } from "./effect/state.js"
import type { RelayIdentity } from "./effect/identity.js"
import type { DockerDriver } from "./docker.js"
import type { FilesystemDriver } from "./files.js"

const origin = "https://hearth.test"
const relayId = "relay-test-fingerprint"
const openResources: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(openResources.splice(0).map((close) => close()))
})

describe("relay browser socket integration", () => {
  it("authenticates, renews with nonce rotation, and closes on a revision floor", async () => {
    const issuerKeys = generateKeyPairSync("ed25519")
    const browserKeys = generateKeyPairSync("ec", { namedCurve: "P-256" })
    const publicKeyJwk = browserKeys.publicKey.export({ format: "jwk" })
    if (
      publicKeyJwk.kty !== "EC" ||
      publicKeyJwk.crv !== "P-256" ||
      !publicKeyJwk.x ||
      !publicKeyJwk.y
    ) {
      throw new Error("Expected a P-256 browser key")
    }
    const browserJwk = {
      crv: "P-256" as const,
      kty: "EC" as const,
      x: publicKeyJwk.x,
      y: publicKeyJwk.y,
    }
    const keyThumbprint = createHash("sha256")
      .update(JSON.stringify(browserJwk))
      .digest("base64url")
    let currentAuthority = { issuerGeneration: 1, minimumRevision: 0 }
    const client = {
      actions: ["instance.console.read"],
      createdAt: Date.now(),
      id: "hearth-test",
      invitationId: "invitation-test",
      lastAddress: null,
      lastSeenAt: null,
      name: "Hearth Test",
      origins: [origin],
      publicKey: issuerKeys.publicKey
        .export({
          format: "pem",
          type: "spki",
        })
        .toString(),
      role: "custom" as const,
      sourceCidrs: [],
    }
    const state = {
      browserAuthority: () => Effect.succeed(currentAuthority),
      findClientById: (id: string) =>
        Effect.succeed(id === client.id ? client : null),
    } as unknown as RelayStateStore["Service"]
    const server = createServer((_request, response) => {
      response.writeHead(404).end()
    })
    const browserServer: BrowserSocketServer = attachBrowserSocket({
      config: {
        browserLimits: {
          fileReplayEntries: 100,
          outboxBytes: 2 * 1024 * 1024,
          outboxMessages: 256,
          pendingFileAuthentications: 16,
          pendingHandshakes: 16,
          pendingHandshakesPerIp: 16,
          sessions: 16,
          sessionsPerInstance: 16,
          sessionsPerUser: 16,
          sessionsPerUserInstance: 16,
          sublimitsEnforced: true,
        },
        proxyMode: "none",
      },
      docker: {} as DockerDriver,
      filesystem: {} as FilesystemDriver,
      identity: { fingerprint: relayId } as RelayIdentity,
      runEffect: (effect) => Effect.runPromise(effect),
      server,
      state,
      subscribeSnapshots: () => () => undefined,
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    openResources.push(async () => {
      await browserServer.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address()
    if (!address || typeof address === "string") {
      throw new Error("Expected an IP server address")
    }
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/browser`,
      relayBrowserConsoleProtocol,
      { origin }
    )
    const messages = messageCollector(socket)
    openResources.push(async () => {
      if (socket.readyState === WebSocket.OPEN) socket.terminate()
    })

    const challenge = await messages.next("auth.challenge")
    const firstCapability = capability({
      capabilityId: "capability-1",
      keyThumbprint,
      revision: 1,
    })
    socket.send(
      JSON.stringify({
        capability: encodeCapability(firstCapability, issuerKeys.privateKey),
        publicKeyJwk: browserJwk,
        signature: browserProof(
          browserKeys.privateKey,
          challenge,
          firstCapability.capabilityId
        ),
        type: "auth",
        v: 1,
      })
    )
    const ready = await messages.next("auth.ready")
    expect(ready.instanceId).toBe("instance-test")
    expect(typeof ready.renewalNonce).toBe("string")

    const renewedCapability = capability({
      capabilityId: "capability-2",
      keyThumbprint,
      revision: 1,
    })
    socket.send(
      JSON.stringify({
        capability: encodeCapability(renewedCapability, issuerKeys.privateKey),
        signature: browserProof(
          browserKeys.privateKey,
          {
            expiresAt: ready.renewalNonceExpiresAt,
            nonce: ready.renewalNonce,
            relayId,
            sessionId: ready.sessionId,
          },
          renewedCapability.capabilityId
        ),
        type: "auth.renew",
        v: 1,
      })
    )
    const renewed = await messages.next("auth.renewed")
    expect(renewed.renewalNonce).not.toBe(ready.renewalNonce)
    expect(renewed.expiresAt).toBe(renewedCapability.expiresAt)

    currentAuthority = { issuerGeneration: 1, minimumRevision: 2 }
    const closed = messages.closed()
    browserServer.reviseAuthorization(
      client.id,
      [
        {
          minimumRevision: 2,
          scope: { instanceId: "instance-test", kind: "instance" },
          subject: "user-test",
        },
      ],
      1
    )
    await expect(closed).resolves.toEqual({
      code: 4403,
      reason: "Browser authorization changed",
    })
  })
})

function capability(input: {
  capabilityId: string
  keyThumbprint: string
  revision: number
}): RelayBrowserCapabilityV2 {
  const issuedAt = Date.now()
  return {
    actions: ["instance.console.read"],
    audience: relayId,
    authorizationRevision: input.revision,
    capabilityId: input.capabilityId,
    expiresAt: issuedAt + 30_000,
    instanceId: "instance-test",
    issuedAt,
    issuer: "hearth-test",
    issuerGeneration: 1,
    keyThumbprint: input.keyThumbprint,
    loginSessionId: "login-session-test",
    operation: "console",
    origin,
    path: null,
    subject: "user-test",
    version: 2,
  }
}

function encodeCapability(
  capability: RelayBrowserCapabilityV2,
  privateKey: KeyObject
): string {
  const encoded = Buffer.from(JSON.stringify(capability)).toString("base64url")
  return `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString("base64url")}`
}

function browserProof(
  privateKey: KeyObject,
  challenge: Record<string, unknown>,
  capabilityId: string
): string {
  const transcript = relayBrowserProofTranscript(
    {
      capabilityId,
      expiresAt: numberField(challenge, "expiresAt"),
      nonce: stringField(challenge, "nonce"),
      relayId: stringField(challenge, "relayId"),
      sessionId: stringField(challenge, "sessionId"),
    },
    relayBrowserConsoleProtocol
  )
  return sign("sha256", Buffer.from(transcript), {
    dsaEncoding: "ieee-p1363",
    key: privateKey,
  }).toString("base64url")
}

function messageCollector(socket: WebSocket) {
  const queued: Array<Record<string, unknown>> = []
  const waiters: Array<{
    reject: (cause: Error) => void
    resolve: (value: Record<string, unknown>) => void
    type: string
  }> = []
  socket.on("message", (data) => {
    const value = JSON.parse(data.toString()) as Record<string, unknown>
    const waiterIndex = waiters.findIndex(
      (waiter) => waiter.type === value.type
    )
    const waiter = waiterIndex >= 0 ? waiters.splice(waiterIndex, 1)[0] : null
    if (waiter) waiter.resolve(value)
    else queued.push(value)
  })
  socket.on("error", (cause) => {
    for (const waiter of waiters.splice(0)) waiter.reject(cause)
  })
  return {
    closed: () =>
      boundedPromise<{ code: number; reason: string }>((resolve) => {
        socket.once("close", (code, reason) => {
          resolve({ code, reason: reason.toString() })
        })
      }),
    next: (type: string) => {
      const existingIndex = queued.findIndex((value) => value.type === type)
      if (existingIndex >= 0) {
        return Promise.resolve(queued.splice(existingIndex, 1)[0]!)
      }
      return boundedPromise<Record<string, unknown>>((resolve, reject) => {
        waiters.push({ reject, resolve, type })
      })
    },
  }
}

function boundedPromise<T>(
  start: (resolve: (value: T) => void, reject: (cause: Error) => void) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Browser socket test timed out")),
      2_000
    )
    timeout.unref()
    start(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (cause) => {
        clearTimeout(timeout)
        reject(cause)
      }
    )
  })
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== "string") throw new Error(`Expected ${key}`)
  return field
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key]
  if (typeof field !== "number") throw new Error(`Expected ${key}`)
  return field
}
