import { generateKeyPairSync, randomBytes, sign, verify } from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedRuntime } from "effect"
import type { Effect } from "effect"
import { WebSocket } from "ws"
import { describe, expect, it, onTestFinished } from "vite-plus/test"

import {
  relayAuthChallengeTranscript,
  relayAuthResponseTranscript,
  relayControlMaxFrameBytes,
  relayControlProtocol,
  relaySnapshotDeltaFeature,
} from "@workspace/contracts"
import type {
  RelayAuthChallenge,
  RelayControlOperation,
  RelayControlRequest,
  RelayControlServerMessage,
} from "@workspace/contracts"

import { attachControlSocket } from "./control-socket.js"
import type { ControlSocketOptions } from "./control-socket.js"
import { fingerprint } from "./effect/identity.js"
import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"
import type { RelayClientRole } from "./effect/state.js"
import type { RelayAction } from "./permissions.js"

describe("Relay control socket", () => {
  it("authenticates a paired Hearth with signed challenges and serves its requests", async () => {
    const relay = await startRelay()
    const hearth = await relay.pair({ role: "read_only" })
    const { inbox, socket } = await relay.open()

    const challenge = (await inbox.next()) as RelayAuthChallenge
    expect(challenge.type).toBe("auth.challenge")
    expect(
      verify(
        null,
        Buffer.from(relayAuthChallengeTranscript(challenge)),
        relay.publicKey,
        Buffer.from(challenge.signature, "base64url")
      )
    ).toBe(true)
    socket.send(JSON.stringify(authResponse(challenge, hearth)))
    expect(await inbox.next()).toMatchObject({
      clientId: hearth.id,
      role: "read_only",
      type: "auth.ready",
    })
    expect(await inbox.next()).toMatchObject({
      event: "relay.snapshot",
      payload: initialSnapshot,
      type: "event",
    })

    const id = sendRequest(socket, "relay.snapshot", {})
    expect(await inbox.next()).toMatchObject({
      payload: { ok: true },
      replyTo: id,
      type: "response",
    })
  })

  it("rejects an identity proof signed by a different key", async () => {
    const relay = await startRelay()
    const hearth = await relay.pair()
    const { inbox, socket } = await relay.open()
    const closed = once(socket, "close")

    const challenge = (await inbox.next()) as RelayAuthChallenge
    socket.send(
      JSON.stringify(
        authResponse(challenge, { ...hearth, privateKey: hearthKeys().private })
      )
    )

    const [code] = await closed
    expect(code).toBe(4401)
  })

  it("rejects operations outside the client's grant", async () => {
    const relay = await startRelay()
    const hearth = await relay.pair({ actions: ["relay.read"], role: "custom" })
    const { inbox, socket } = await relay.connect(hearth)

    const id = sendRequest(socket, "relay.networking.write", {})

    expect(await inbox.next()).toMatchObject({
      code: "forbidden",
      replyTo: id,
      type: "error",
    })
  })

  it("rejects a request whose id is already in flight", async () => {
    const release = deferred<void>()
    const relay = await startRelay({
      execute: async () => {
        await release.promise
        return { ok: true }
      },
    })
    const { inbox, socket } = await relay.connect(await relay.pair())

    const id = sendRequest(socket, "relay.snapshot", {})
    sendRequest(socket, "relay.snapshot", {}, { id })

    expect(await inbox.next()).toMatchObject({
      code: "duplicate_request",
      replyTo: id,
      type: "error",
    })
    release.resolve()
    expect(await inbox.next()).toMatchObject({
      payload: { ok: true },
      replyTo: id,
      type: "response",
    })
  })

  it("aborts an in-flight operation when Hearth cancels it", async () => {
    const started = deferred<void>()
    const aborted = deferred<void>()
    const relay = await startRelay({
      execute: async (request, _client, signal) => {
        if (request.operation !== "instance.console.write") return { ok: true }
        started.resolve()
        await abortedSignal(signal)
        aborted.resolve()
        throw new Error("Request aborted")
      },
    })
    const { inbox, socket } = await relay.connect(await relay.pair())

    const cancelledId = sendRequest(socket, "instance.console.write", {
      command: "stop",
      instanceId: "a".repeat(40),
    })
    await started.promise
    socket.send(
      JSON.stringify({
        id: randomBytes(12).toString("hex"),
        replyTo: cancelledId,
        type: "cancel",
        v: 1,
      })
    )
    await aborted.promise

    // The cancelled request never answers; the next frame belongs to a later request.
    const followUpId = sendRequest(socket, "relay.snapshot", {})
    expect(await inbox.next()).toMatchObject({
      replyTo: followUpId,
      type: "response",
    })
  })

  it("enforces the relative request timeout", async () => {
    const relay = await startRelay({
      execute: async (request, _client, signal) => {
        if (request.payload !== "wait-for-timeout") return { ok: true }
        await abortedSignal(signal)
        throw new Error("Request aborted")
      },
    })
    const { inbox, socket } = await relay.connect(await relay.pair())

    const invalidId = sendRequest(
      socket,
      "relay.snapshot",
      {},
      { timeoutMs: 0 }
    )
    expect(await inbox.next()).toMatchObject({
      code: "invalid_timeout",
      replyTo: invalidId,
      type: "error",
    })

    // timeoutMs wins over the absolute deadline, so Hearth clock skew cannot expire requests.
    const skewedId = sendRequest(
      socket,
      "relay.snapshot",
      {},
      { deadline: 1, timeoutMs: 5_000 }
    )
    expect(await inbox.next()).toMatchObject({
      replyTo: skewedId,
      type: "response",
    })

    const expiredId = sendRequest(
      socket,
      "relay.snapshot",
      "wait-for-timeout",
      {
        timeoutMs: 10,
      }
    )
    expect(await inbox.next()).toMatchObject({
      code: "request_cancelled",
      replyTo: expiredId,
      type: "error",
    })
  })

  it("audits mutations with the acting user, CLI credential, and affected resource", async () => {
    const instanceId = "a".repeat(40)
    const relay = await startRelay({
      execute: async (request) =>
        request.operation === "instance.create" ? { id: instanceId } : {},
    })
    const hearth = await relay.pair()
    const { inbox, socket } = await relay.connect(hearth)
    const credentialId = "12345678-1234-4123-8123-123456789abc"

    const readId = sendRequest(
      socket,
      "database.list",
      {},
      { subject: "user-1" }
    )
    expect(await inbox.next()).toMatchObject({ replyTo: readId })
    const createId = sendRequest(
      socket,
      "instance.create",
      { name: "Survival" },
      { subject: "user-1" }
    )
    expect(await inbox.next()).toMatchObject({ replyTo: createId })
    const consoleId = sendRequest(
      socket,
      "instance.console.write",
      { command: "say deployed", instanceId },
      { subject: `cli/${credentialId}/user-1` }
    )
    expect(await inbox.next()).toMatchObject({ replyTo: consoleId })

    await expect
      .poll(async () => (await relay.audits()).length)
      .toBeGreaterThanOrEqual(2)
    const audits = await relay.audits()
    expect(audits).toHaveLength(2)
    expect(audits.find((audit) => audit.requestId === createId)).toMatchObject({
      clientId: hearth.id,
      details: {
        instanceId,
        operation: "instance.create",
        permission: "instance.create",
        subject: "user-1",
      },
      event: "control.mutation",
    })
    expect(audits.find((audit) => audit.requestId === consoleId)).toMatchObject(
      {
        clientId: hearth.id,
        details: {
          cliCredentialId: credentialId,
          instanceId,
          operation: "instance.console.write",
          permission: "instance.console.write",
          source: "cli",
          subject: "user-1",
        },
        event: "control.mutation",
      }
    )
  })

  it("reports operation failures without leaking overlong command output", async () => {
    const command = `docker network create ${"hearth-feature-".repeat(16)}`
    const failures: Record<string, string> = {
      multiLine: `Command failed: ${command}\nError response from daemon: all predefined address pools have been fully subnetted\n`,
      short: "Survival is not running",
      singleLine: "x".repeat(241),
    }
    const relay = await startRelay({
      execute: async (request) => {
        throw new Error(failures[request.payload as string])
      },
    })
    const { inbox, socket } = await relay.connect(await relay.pair())

    for (const [payload, message] of [
      ["short", "Survival is not running"],
      [
        "multiLine",
        "Error response from daemon: all predefined address pools have been fully subnetted",
      ],
      ["singleLine", "Relay operation failed"],
    ]) {
      const id = sendRequest(socket, "relay.snapshot", payload)
      expect(await inbox.next()).toMatchObject({
        code: "operation_failed",
        message,
        replyTo: id,
        retryable: false,
        type: "error",
      })
    }
  })

  it("rejects an oversized response without closing the socket", async () => {
    const relay = await startRelay({
      execute: async (request) =>
        request.operation === "instance.files.list"
          ? { paths: ["x".repeat(relayControlMaxFrameBytes)] }
          : { ok: true },
    })
    const { inbox, socket } = await relay.connect(await relay.pair())

    const oversizedId = sendRequest(socket, "instance.files.list", {
      instanceId: "a".repeat(40),
    })
    expect(await inbox.next()).toMatchObject({
      code: "response_too_large",
      replyTo: oversizedId,
      retryable: false,
      type: "error",
    })

    const followUpId = sendRequest(socket, "relay.snapshot", {})
    expect(await inbox.next()).toMatchObject({
      payload: { ok: true },
      replyTo: followUpId,
      type: "response",
    })
  })

  it("keeps other Hearth sessions alive when one client is revoked", async () => {
    const relay = await startRelay({
      execute: async (_request, client) => ({ clientId: client.id }),
    })
    const revoked = await relay.pair()
    const kept = await relay.pair()
    const first = await relay.connect(revoked)
    const second = await relay.connect(kept)
    const firstClosed = once(first.socket, "close")

    await relay.run(relay.state.revokeClient(revoked.id, Date.now()))
    relay.control.revokeClient(revoked.id)

    const [code] = await firstClosed
    expect(code).toBe(4403)
    const id = sendRequest(second.socket, "relay.snapshot", {})
    expect(await second.inbox.next()).toMatchObject({
      payload: { clientId: kept.id },
      replyTo: id,
      type: "response",
    })
  })

  it("closes a session on its next request once the client is revoked in state", async () => {
    const relay = await startRelay()
    const hearth = await relay.pair()
    const { socket } = await relay.connect(hearth)
    const closed = once(socket, "close")

    await relay.run(relay.state.revokeClient(hearth.id, Date.now()))
    sendRequest(socket, "relay.snapshot", {})

    const [code] = await closed
    expect(code).toBe(4403)
  })

  it("returns Hearth's answers to reverse requests", async () => {
    const relay = await startRelay()
    const hearth = await relay.pair()
    const { inbox, socket } = await relay.connect(hearth)

    const result = relay.control.requestClients(
      "sftp.authorization.resolve",
      { username: "owner.server" },
      5_000
    )
    const request = await nextReverseRequest(inbox)
    expect(request).toMatchObject({
      operation: "sftp.authorization.resolve",
      payload: { username: "owner.server" },
      type: "request",
    })
    socket.send(
      JSON.stringify({
        id: randomBytes(12).toString("hex"),
        payload: { allowed: true },
        replyTo: request.id,
        type: "response",
        v: 1,
      })
    )

    await expect(result).resolves.toEqual([
      { clientId: hearth.id, payload: { allowed: true } },
    ])
  })

  it("cancels a reverse request that outlives its timeout", async () => {
    const relay = await startRelay()
    const { inbox, socket } = await relay.connect(await relay.pair())

    const result = relay.control.requestClients(
      "hearth.tailscale.instance.detach",
      { mode: "prepare" },
      10
    )
    const request = await nextReverseRequest(inbox)
    expect(await inbox.next()).toMatchObject({
      replyTo: request.id,
      type: "cancel",
    })
    socket.send(
      JSON.stringify({
        code: "request_cancelled",
        id: randomBytes(12).toString("hex"),
        message: "DNS prepare was rolled back",
        replyTo: request.id,
        retryable: false,
        type: "error",
        v: 1,
      })
    )

    await expect(result).resolves.toEqual([])
  })

  it("pushes snapshot deltas only to clients that advertise support", async () => {
    const relay = await startRelay()
    const deltaClient = await relay.connect(await relay.pair(), {
      features: [relaySnapshotDeltaFeature],
    })
    const legacyClient = await relay.connect(await relay.pair(), {
      features: [],
    })

    const next = { instances: [{ id: "updated" }], node: {} }
    relay.pushSnapshot(next)

    expect(await deltaClient.inbox.next()).toMatchObject({
      event: "relay.snapshot.delta",
      payload: { deletedInstanceIds: [], instances: [{ id: "updated" }] },
      seq: 2,
      type: "event",
    })
    expect(await legacyClient.inbox.next()).toMatchObject({
      event: "relay.snapshot",
      payload: next,
      seq: 2,
      type: "event",
    })
  })
})

const initialSnapshot = { instances: [], node: {} }

interface TestHearth {
  readonly id: string
  readonly privateKey: string
}

async function startRelay(
  options: { readonly execute?: ControlSocketOptions["execute"] } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), "kiln-relay-control-"))
  const runtime = ManagedRuntime.make(
    makeRelayStateLayer(join(directory, "relay.sqlite"))
  )
  const state = await runtime.runPromise(RelayStateStore)
  const relayKeys = hearthKeys()
  const listeners = new Set<(snapshot: unknown) => void>()
  const sockets = new Set<WebSocket>()
  const server = createServer()
  const control = attachControlSocket({
    execute: options.execute ?? (async () => ({ ok: true })),
    identity: {
      fingerprint: fingerprint(relayKeys.public),
      name: "Test Relay",
      privateKeyPem: relayKeys.private,
      publicKeyPem: relayKeys.public,
    },
    initialSnapshot: async () => initialSnapshot,
    runEffect: (effect) => runtime.runPromise(effect),
    server,
    state,
    subscribeSnapshots: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing port")

  onTestFinished(async () => {
    for (const socket of sockets) socket.terminate()
    await control.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await runtime.dispose()
    rmSync(directory, { force: true, recursive: true })
  })

  const open = async () => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/socket`,
      relayControlProtocol
    )
    sockets.add(socket)
    return { inbox: messageInbox(socket), socket }
  }

  return {
    audits: () => runtime.runPromise(state.listAudits({ limit: 100 })),
    connect: async (
      hearth: TestHearth,
      connectOptions: { readonly features?: ReadonlyArray<string> } = {}
    ) => {
      const connection = await open()
      const challenge = (await connection.inbox.next()) as RelayAuthChallenge
      connection.socket.send(
        JSON.stringify(
          authResponse(
            challenge,
            hearth,
            connectOptions.features ?? [relaySnapshotDeltaFeature]
          )
        )
      )
      expect((await connection.inbox.next()).type).toBe("auth.ready")
      expect((await connection.inbox.next()).type).toBe("event")
      return connection
    },
    control,
    open,
    pair: async (
      grant: {
        readonly actions?: ReadonlyArray<RelayAction>
        readonly role?: RelayClientRole
      } = {}
    ): Promise<TestHearth> => {
      const keys = hearthKeys()
      const id = fingerprint(keys.public)
      const invitationId = randomBytes(8).toString("hex")
      const now = Date.now()
      const role = grant.role ?? "full_access"
      const actions = grant.actions ?? ["*"]
      await runtime.runPromise(
        state.createInvitation({
          actions,
          createdAt: now,
          expiresAt: now + 60_000,
          id: invitationId,
          role,
          tokenHash: invitationId,
        })
      )
      await runtime.runPromise(
        state.pairClient({
          actions,
          id,
          invitationId,
          name: "Test Hearth",
          origins: ["https://hearth.test"],
          pairedAt: now,
          publicKey: keys.public,
          role,
          sourceCidrs: [],
        })
      )
      return { id, privateKey: keys.private }
    },
    publicKey: relayKeys.public,
    pushSnapshot: (snapshot: unknown) => {
      for (const listener of listeners) listener(snapshot)
    },
    run: <A, E>(effect: Effect.Effect<A, E, RelayStateStore>) =>
      runtime.runPromise(effect),
    state,
  }
}

function hearthKeys() {
  const keys = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  })
  return { private: keys.privateKey, public: keys.publicKey }
}

function authResponse(
  challenge: RelayAuthChallenge,
  hearth: TestHearth,
  features: ReadonlyArray<string> = [relaySnapshotDeltaFeature]
) {
  return {
    clientId: hearth.id,
    features,
    signature: sign(
      null,
      Buffer.from(relayAuthResponseTranscript(challenge, hearth.id)),
      hearth.privateKey
    ).toString("base64url"),
    type: "auth.response",
    v: 1,
  }
}

function sendRequest(
  socket: WebSocket,
  operation: RelayControlOperation,
  payload: unknown,
  overrides: {
    readonly deadline?: number
    readonly id?: string
    readonly subject?: string
    readonly timeoutMs?: number
  } = {}
): string {
  const id = overrides.id ?? randomBytes(12).toString("hex")
  socket.send(
    JSON.stringify({
      deadline: Date.now() + 15_000,
      operation,
      payload,
      type: "request",
      v: 1,
      ...overrides,
      id,
    })
  )
  return id
}

async function nextReverseRequest(
  inbox: ReturnType<typeof messageInbox>
): Promise<RelayControlRequest> {
  const message = await inbox.next()
  if (message.type !== "request") {
    throw new Error(`Expected a reverse request, received ${message.type}`)
  }
  return message
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function abortedSignal(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

function messageInbox(socket: WebSocket) {
  const messages: Array<RelayControlServerMessage> = []
  const waiters: Array<(message: RelayControlServerMessage) => void> = []
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as RelayControlServerMessage
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else messages.push(message)
  })
  return {
    next: () =>
      new Promise<RelayControlServerMessage>((resolve, reject) => {
        const message = messages.shift()
        if (message) {
          resolve(message)
          return
        }
        const timer = setTimeout(
          () => reject(new Error("WebSocket timed out")),
          2_000
        )
        waiters.push((value) => {
          clearTimeout(timer)
          resolve(value)
        })
      }),
  }
}
