import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Duplex } from "node:stream"
import { Deferred, Effect, Exit, Fiber, ManagedRuntime } from "effect"
import { WebSocket, WebSocketServer } from "ws"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vite-plus/test"

import {
  relayAuthChallengeTranscript,
  relayAuthResponseTranscript,
  relayControlProtocol,
  relayCreateDatabaseSchema,
  relayDatabaseActionSchema,
  relaySnapshotDeltaFeature,
} from "@workspace/contracts"
import type {
  RelayAuthChallenge,
  RelayControlOperation,
  RelayControlServerMessage,
} from "@workspace/contracts"

vi.mock("./command.js", () => import("./test/docker.js"))

import { attachControlSocket } from "./control-socket.js"
import {
  relayDialUrl,
  startControlDials,
  type ControlDials,
} from "./control-dial.js"
import type { ControlSocketOptions } from "./control-socket.js"
import { fingerprint } from "./effect/identity.js"
import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"
import type { RelayClientRole } from "./effect/state.js"
import type { RelayAction } from "./permissions.js"
import { sendRawRequest } from "./test/raw-http.js"
import { OperationLanes } from "./operation-lanes.js"
import {
  controlRequestLocks,
  databaseLifecycleLocks,
} from "./operation-plans.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness, TEST_NAMESPACE } from "./test/relay.js"
import { DatabaseSync } from "node:sqlite"

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

  it("ignores upgrade targets that URL parsing rejects instead of crashing", async () => {
    const relay = await startRelay()
    const address = relay.server.address() as AddressInfo
    const upgraded = once(relay.server, "upgrade")

    const malformed = sendRawRequest(address.port, "//%", { upgrade: true })
    // Listeners run in registration order; the control socket's has returned.
    const [, upgradedSocket] = (await upgraded) as [unknown, Duplex]
    // Production answers these with 400 from index.ts; this harness has no
    // such listener, so release the parked socket.
    upgradedSocket.destroy()
    malformed.destroy()
    const { inbox } = await relay.open()
    expect((await inbox.next()).type).toBe("auth.challenge")
  })

  it("rejects an identity proof signed by a different key", async () => {
    const relay = await startRelay()
    const hearth = await relay.pair()
    const { inbox, socket } = await relay.open()
    const closed = once(socket, "close")

    const challenge = (await inbox.next()) as RelayAuthChallenge
    socket.send(
      JSON.stringify(
        authResponse(challenge, {
          ...hearth,
          privateKey: hearthKeys().private,
        })
      )
    )

    const [code] = await closed
    expect(code).toBe(4401)
  })

  it("takes its name from a full-access Hearth, never a read-only one", async () => {
    const adopted: Array<string> = []
    const relay = await startRelay({
      adoptRelayName: async (name) => {
        adopted.push(name)
      },
    })
    for (const role of ["read_only", "full_access"] as const) {
      const hearth = await relay.pair({ role })
      const { inbox, socket } = await relay.open()
      const challenge = (await inbox.next()) as RelayAuthChallenge
      socket.send(
        JSON.stringify({
          ...authResponse(challenge, hearth),
          relayName: `Named by ${role}`,
        })
      )
      expect(await inbox.next()).toMatchObject({ type: "auth.ready" })
    }
    expect(adopted).toEqual(["Named by full_access"])
  })

  it("refuses the host shell to a read-only client", async () => {
    const relay = await startRelay()
    const hearth = await relay.pair({ role: "read_only" })
    const { inbox, socket } = await relay.connect(hearth)
    const id = sendRequest(socket, "relay.terminal.attach", {})
    expect(await inbox.next()).toMatchObject({
      code: "forbidden",
      replyTo: id,
      type: "error",
    })
  })

  it("keeps host files behind their own grants", async () => {
    const relay = await startRelay()
    const hostId = "relay:0123456789ab"
    // The file actions that cover every game server's and App's files stop
    // short of the host's.
    const instances = await relay.connect(
      await relay.pair({
        role: "custom",
        actions: [
          "instance.files.list",
          "instance.files.read",
          "instance.files.write",
        ],
      })
    )
    const refused = sendRequest(instances.socket, "instance.files.read", {
      instanceId: hostId,
      path: "etc/os-release",
    })
    expect(await instances.inbox.next()).toMatchObject({
      code: "forbidden",
      replyTo: refused,
      type: "error",
    })
    const reader = await relay.connect(
      await relay.pair({ role: "custom", actions: ["relay.files.read"] })
    )
    const read = sendRequest(reader.socket, "instance.files.read", {
      instanceId: hostId,
      path: "etc/os-release",
    })
    expect(await reader.inbox.next()).toMatchObject({
      payload: { ok: true },
      replyTo: read,
      type: "response",
    })
    const write = sendRequest(reader.socket, "instance.files.write", {
      instanceId: hostId,
      path: "etc/os-release",
      content: "changed",
    })
    expect(await reader.inbox.next()).toMatchObject({
      code: "forbidden",
      replyTo: write,
      type: "error",
    })
  })

  it("takes a game server's file actions for an App's files, and never the host's", async () => {
    const relay = await startRelay()
    const appRoot = "app:0123456789ab"
    const host = await relay.connect(
      await relay.pair({
        role: "custom",
        actions: ["relay.files.read", "relay.files.write"],
      })
    )
    const refused = sendRequest(host.socket, "instance.files.read", {
      instanceId: appRoot,
      path: "compose.yaml",
    })
    expect(await host.inbox.next()).toMatchObject({
      code: "forbidden",
      replyTo: refused,
      type: "error",
    })

    const reader = await relay.connect(
      await relay.pair({ role: "custom", actions: ["instance.files.read"] })
    )
    const read = sendRequest(reader.socket, "instance.files.read", {
      instanceId: appRoot,
      path: "compose.yaml",
    })
    expect(await reader.inbox.next()).toMatchObject({
      payload: { ok: true },
      replyTo: read,
      type: "response",
    })
    // Each change takes its own action, as on a game server.
    const write = sendRequest(reader.socket, "instance.files.write", {
      instanceId: appRoot,
      path: "compose.yaml",
      content: "changed",
    })
    expect(await reader.inbox.next()).toMatchObject({
      code: "forbidden",
      replyTo: write,
      type: "error",
    })
  })

  it("checks a certificate with what changing its route takes", async () => {
    const relay = await startRelay({
      execute: async () => ({ asked: false, pending: null }),
    })
    const hearth = await relay.pair({ role: "custom", actions: ["app.manage"] })
    const { inbox, socket } = await relay.connect(hearth)
    const app = sendRequest(socket, "relay.certificates.check", {
      hostname: "shop.example.com",
      owner: { id: "a".repeat(12), kind: "app" },
    })
    expect(await inbox.next()).toMatchObject({
      replyTo: app,
      type: "response",
    })
    const server = sendRequest(socket, "relay.certificates.check", {
      hostname: "play.example.com",
      owner: { id: "a".repeat(12), kind: "server" },
    })
    expect(await inbox.next()).toMatchObject({
      code: "forbidden",
      replyTo: server,
      type: "error",
    })
  })

  it("takes a database's network permission to create an App connected to it", async () => {
    const relay = await startRelay({
      execute: async () => ({ prepared: true }),
    })
    const hearth = await relay.pair({ role: "custom", actions: ["app.create"] })
    const { inbox, socket } = await relay.connect(hearth)
    const app = {
      id: "a".repeat(12),
      idempotencyKey: randomUUID(),
      name: "Blog",
    }
    const alone = sendRequest(socket, "app.provision.prepare", {
      ...app,
      databaseIds: [],
    })
    expect(await inbox.next()).toMatchObject({
      replyTo: alone,
      type: "response",
    })
    const connected = sendRequest(socket, "app.provision.prepare", {
      ...app,
      databaseIds: ["d".repeat(12)],
    })
    expect(await inbox.next()).toMatchObject({
      code: "forbidden",
      replyTo: connected,
      type: "error",
    })
  })

  describe("operation IDs", () => {
    const features = [relaySnapshotDeltaFeature]
    const instanceId = "d".repeat(12)

    it("keeps no reply in its journal, only how the change went", async () => {
      const relay = await startRelay({
        execute: async () => ({ token: "kiln_pair_secret_token" }),
      })
      const hearth = await relay.pair()
      const { inbox, socket } = await relay.connect(hearth, { features })
      const operationId = randomUUID()
      sendRequest(socket, "relay.pairing.create", {}, { operationId })
      expect(await inbox.next()).toMatchObject({
        payload: { token: "kiln_pair_secret_token" },
      })
      // The reply stays in memory for this Hearth to look up.
      expect(await lookup(relay, hearth, operationId)).toEqual({
        result: { token: "kiln_pair_secret_token" },
        status: "succeeded",
      })
      const database = new DatabaseSync(relay.databaseFile)
      try {
        const rows = database.prepare("SELECT * FROM relay_operations").all()
        expect(rows).toHaveLength(1)
        expect(JSON.stringify(rows)).not.toContain("kiln_pair_secret_token")
      } finally {
        database.close()
      }
    })

    it("keeps one Hearth's operations from another", async () => {
      const relay = await startRelay({ execute: async () => ({ ok: true }) })
      const owner = await relay.pair()
      const other = await relay.pair()
      const { inbox, socket } = await relay.connect(owner, { features })
      const operationId = randomUUID()
      sendRequest(
        socket,
        "instance.action",
        { action: "start", instanceId },
        { operationId }
      )
      await inbox.next()
      expect(await lookup(relay, other, operationId)).toEqual({
        status: "unknown",
      })
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

  describe("a request that waited its turn", () => {
    const databaseId = "d".repeat(12)

    it("changes nothing for a client revoked, or stripped of the action, while it waited", async () => {
      const { container, hold, relay } = await relayWithDatabase()
      const grant = { actions: ["database.power"], role: "custom" } as const
      const revoked = await relay.pair(grant)
      const demoted = await relay.pair(grant)
      const revokedConnection = await relay.connect(revoked)
      const demotedConnection = await relay.connect(demoted)

      const release = hold()
      const revokedStop = await waitingStop(relay, revokedConnection, revoked)
      const demotedStop = await waitingStop(relay, demotedConnection, demoted)
      // As `kiln-relay hearth revoke` and a changed grant leave them: the
      // sessions stay open.
      await relay.run(relay.state.revokeClient(revoked.id, Date.now()))
      await relay.run(
        relay.state.updateClient({
          actions: ["database.read"],
          clientId: demoted.id,
          name: "Test Hearth",
          role: "custom",
          sourceCidrs: [],
        })
      )
      await release()

      expect(await revokedConnection.inbox.next()).toMatchObject({
        code: "forbidden",
        replyTo: revokedStop,
        type: "error",
      })
      expect(await demotedConnection.inbox.next()).toMatchObject({
        code: "forbidden",
        replyTo: demotedStop,
        type: "error",
      })
      expect(container.state.running).toBe(true)
    })

    it("runs for a client still allowed to send it", async () => {
      const { container, hold, relay } = await relayWithDatabase()
      const hearth = await relay.pair({
        actions: ["database.power"],
        role: "custom",
      })
      const connection = await relay.connect(hearth)

      const release = hold()
      const stop = await waitingStop(relay, connection, hearth)
      await release()

      expect(await connection.inbox.next()).toMatchObject({
        replyTo: stop,
        type: "response",
      })
      expect(container.state.running).toBe(false)
    })

    // A Relay with a running database whose power requests run as on a real
    // one, and a way to hold the database's lifecycle so they wait.
    async function relayWithDatabase() {
      const harness = await relayHarness()
      await harness.databases.create(
        relayCreateDatabaseSchema.parse({
          databaseName: "kiln_app",
          engine: "postgres",
          id: databaseId,
          name: "Main database",
          password: "correct-horse-battery-staple-1",
          username: "kiln_user",
        })
      )
      const container = fakeDocker.container(
        `${TEST_NAMESPACE}-kiln-db-${databaseId}-database`
      )!
      const relay = await startRelay({
        execute: async (request) => {
          const input = relayDatabaseActionSchema.parse(request.payload)
          return harness.power.requested(
            "database",
            input.databaseId,
            input.action
          )
        },
        lanes: harness.lanes,
      })
      const hold = () => {
        const released = Deferred.makeUnsafe<void>()
        const holding = Effect.runFork(
          harness.lanes.run(
            { label: "test.hold", locks: databaseLifecycleLocks(databaseId) },
            Deferred.await(released)
          )
        )
        return async () => {
          Deferred.doneUnsafe(released, Exit.void)
          await Effect.runPromise(Fiber.join(holding))
        }
      }
      return { container, hold, relay }
    }

    // Sends a stop and waits until it's past its client check, journaled
    // as accepted, and waiting its turn.
    async function waitingStop(
      relay: Awaited<ReturnType<typeof startRelay>>,
      connection: { readonly socket: WebSocket },
      hearth: TestHearth
    ) {
      const operationId = randomUUID()
      const id = sendRequest(
        connection.socket,
        "database.action",
        { action: "stop", databaseId },
        { operationId }
      )
      await until(
        async () =>
          (await relay.run(
            relay.state.getOperation(hearth.id, operationId)
          )) !== null
      )
      return id
    }
  })
})

const initialSnapshot = { instances: [], node: {} }

describe("Relay dialing Hearth", () => {
  // Fake only timeouts: the Relay's waits between dials run on virtual time,
  // while sockets and Effect's scheduler keep running.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("dials the Hearth a session asked it to, with a challenge only that Hearth's client can answer", async () => {
    const relay = await startRelay({ dials: true })
    const hearth = await relay.pair()
    const stranger = await relay.pair()
    const fakeHearth = await startFakeHearth()

    // A session Hearth opened says where to dial it.
    await relay.connect(hearth, { dial: fakeHearth.url })

    const first = await fakeHearth.nextDial()
    expect(first.challenge.dial).toEqual({
      clientId: hearth.id,
      hearthNonce: first.nonce,
      hearthOrigin: new URL(fakeHearth.url).origin,
    })
    // The binding is part of what the Relay signed.
    expect(
      verify(
        null,
        Buffer.from(relayAuthChallengeTranscript(first.challenge)),
        relay.publicKey,
        Buffer.from(first.challenge.signature, "base64url")
      )
    ).toBe(true)
    expect(
      verify(
        null,
        Buffer.from(
          relayAuthChallengeTranscript({
            ...first.challenge,
            dial: { ...first.challenge.dial!, hearthNonce: "replayed" },
          })
        ),
        relay.publicKey,
        Buffer.from(first.challenge.signature, "base64url")
      )
    ).toBe(false)

    // Another of the Relay's Hearth clients can't take a dialed session.
    const refused = once(first.socket, "close")
    first.socket.send(JSON.stringify(authResponse(first.challenge, stranger)))
    expect((await refused)[0]).toBe(4401)

    // The Relay dials again, and the Hearth it dialed for gets a session.
    const second = await fakeHearth.nextDial()
    second.socket.send(JSON.stringify(authResponse(second.challenge, hearth)))
    expect(await second.inbox.next()).toMatchObject({
      clientId: hearth.id,
      type: "auth.ready",
    })
    expect((await second.inbox.next()).type).toBe("event")
    const id = sendRequest(second.socket, "relay.snapshot", {})
    expect(await second.inbox.next()).toMatchObject({
      payload: { ok: true },
      replyTo: id,
      type: "response",
    })
  })

  it("dials only Hearth's control path over HTTP(S)", () => {
    expect(relayDialUrl("https://kiln.example/api/relays/control")?.href).toBe(
      "wss://kiln.example/api/relays/control"
    )
    for (const url of [
      "https://kiln.example/elsewhere",
      "https://user:secret@kiln.example/api/relays/control",
      "file:///api/relays/control",
      "https://kiln.example/api/relays/control?redirect=1",
    ]) {
      expect(relayDialUrl(url)).toBeNull()
    }
  })
})

interface TestHearth {
  readonly id: string
  readonly privateKey: string
}

// A Hearth Relays dial: it says hello with a nonce, then hands over each
// connection with the challenge that came back.
async function startFakeHearth() {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  const arrivals: Array<{
    readonly challenge: RelayAuthChallenge
    readonly inbox: ReturnType<typeof messageInbox>
    readonly nonce: string
    readonly socket: WebSocket
  }> = []
  wss.on("connection", (socket) => {
    const nonce = randomBytes(32).toString("base64url")
    socket.send(JSON.stringify({ nonce, type: "dial.hello", v: 1 }))
    socket.once("message", (data) => {
      arrivals.push({
        challenge: JSON.parse(data.toString()) as RelayAuthChallenge,
        inbox: messageInbox(socket),
        nonce,
        socket,
      })
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo
  onTestFinished(async () => {
    for (const client of wss.clients) client.terminate()
    wss.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  // Lets virtual time pass in steps, with real I/O between them, until a
  // dial arrives or `ms` have passed.
  const passUntilDial = async (ms: number) => {
    for (let passed = 0; arrivals.length === 0 && passed < ms;) {
      await vi.advanceTimersByTimeAsync(250)
      passed += 250
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  return {
    // Whether a dial arrived while only real I/O ran, with no virtual time
    // passing at all.
    dialedAtOnce: async () => {
      for (let turn = 0; arrivals.length === 0 && turn < 5_000; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      return arrivals.length > 0
    },
    dialsWithin: async (ms: number) => {
      await passUntilDial(ms)
      return arrivals.length
    },
    nextDial: async () => {
      await passUntilDial(5 * 60_000)
      const arrival = arrivals.shift()
      if (!arrival) throw new Error("No dial arrived")
      return arrival
    },
    url: `http://127.0.0.1:${port}/api/relays/control`,
  }
}

async function startRelay(
  options: {
    readonly adoptRelayName?: ControlSocketOptions["adoptRelayName"]
    readonly execute?: ControlSocketOptions["execute"]
    /** Dials the Hearths that ask it to, as the Relay does. */
    readonly dials?: boolean
    readonly lanes?: OperationLanes
  } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), "kiln-relay-control-"))
  const runtime = ManagedRuntime.make(
    makeRelayStateLayer(join(directory, "relay.sqlite"))
  )
  const state = await runtime.runPromise(RelayStateStore)
  const journalId = await runtime.runPromise(state.operationJournalId())
  const relayKeys = hearthKeys()
  const sockets = new Set<WebSocket>()
  const server = createServer()
  const lanes = options.lanes ?? new OperationLanes()
  let dials: ControlDials | null = null
  const control = attachControlSocket({
    adoptRelayName: options.adoptRelayName,
    execute: options.execute ?? (async () => ({ ok: true })),
    lanes,
    requestLocks: (request) =>
      controlRequestLocks(
        request.operation,
        request.payload as Record<string, unknown>,
        (reference) => reference,
        () => []
      ),
    identity: {
      fingerprint: fingerprint(relayKeys.public),
      id: "0123456789ab",
      name: "Test Relay",
      privateKeyPem: relayKeys.private,
      publicKeyPem: relayKeys.public,
    },
    initialSnapshot: async () => initialSnapshot,
    journalId,
    runEffect: (effect) => runtime.runPromise(effect),
    saveDial: (clientId, url) => dials?.save(clientId, url),
    server,
    state,
    subscribeSnapshots: () => () => undefined,
  })
  if (options.dials) {
    dials = startControlDials({ adopt: control.adoptDialed, state })
  }
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing port")

  onTestFinished(async () => {
    for (const socket of sockets) socket.terminate()
    await dials?.close()
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
    connect: async (
      hearth: TestHearth,
      connectOptions: {
        // Where this Hearth asks the Relay to dial it.
        readonly dial?: string
        readonly features?: ReadonlyArray<string>
      } = {}
    ) => {
      const connection = await open()
      const challenge = (await connection.inbox.next()) as RelayAuthChallenge
      connection.socket.send(
        JSON.stringify({
          ...authResponse(
            challenge,
            hearth,
            connectOptions.features ?? [relaySnapshotDeltaFeature]
          ),
          ...(connectOptions.dial
            ? { dial: { url: connectOptions.dial } }
            : {}),
        })
      )
      expect((await connection.inbox.next()).type).toBe("auth.ready")
      expect((await connection.inbox.next()).type).toBe("event")
      return connection
    },
    databaseFile: join(directory, "relay.sqlite"),
    open,
    server,
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

async function lookup(
  relay: Awaited<ReturnType<typeof startRelay>>,
  hearth: TestHearth,
  operationId: string
) {
  const { inbox, socket } = await relay.connect(hearth, {
    features: [relaySnapshotDeltaFeature],
  })
  try {
    const id = sendRequest(socket, "operation.get", { operationId })
    const reply = await inbox.next()
    expect(reply).toMatchObject({ replyTo: id, type: "response" })
    return (reply as { payload: unknown }).payload
  } finally {
    socket.close()
  }
}

function sendRequest(
  socket: WebSocket,
  operation: RelayControlOperation,
  payload: unknown,
  overrides: {
    readonly operationId?: string
  } = {}
): string {
  const id = randomBytes(12).toString("hex")
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

// Lets real I/O run, without letting any time pass, until `condition` holds.
async function until(condition: () => boolean | Promise<boolean>) {
  for (let turn = 0; turn < 10_000; turn += 1) {
    if (await condition()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error("The condition never held")
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
