import {
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Duplex } from "node:stream"
import { Effect, ManagedRuntime } from "effect"
import { WebSocket } from "ws"
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test"

import {
  relayAuthChallengeTranscript,
  relayAuthResponseTranscript,
  relayControlMaxFrameBytes,
  relayControlProtocol,
  relayHearthContainerTranscript,
  relaySnapshotDeltaFeature,
  relaySnapshotNodeResourcesFeature,
} from "@workspace/contracts"
import type {
  RelayAuthChallenge,
  RelayControlOperation,
  RelayControlRequest,
  RelayControlServerMessage,
} from "@workspace/contracts"

import { attachControlSocket } from "./control-socket.js"
import type {
  ControlSocketOptions,
  HearthContainerClaim,
} from "./control-socket.js"
import { RelayNotFoundError } from "./effect/errors.js"
import { fingerprint } from "./effect/identity.js"
import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"
import { adoptInstallationId, loadInstallationId } from "./installation.js"
import type { RelayClientRole } from "./effect/state.js"
import type { RelayAction } from "./permissions.js"
import type { RelayConfig } from "./config.js"
import { sendRawRequest } from "./test/raw-http.js"
import { OperationLanes } from "./operation-lanes.js"
import {
  controlRequestLocks,
  type InstanceResolver,
} from "./operation-plans.js"
import { DatabaseSync } from "node:sqlite"
import { exclusive } from "./operation-lanes.js"

type InstallationConfig = Pick<
  RelayConfig,
  "installationId" | "installationIdConfigured"
>

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

  it("saves the installation ID a full-access Hearth authenticates with", async () => {
    const installationId = "0b7e5f0e-6d0f-4a4f-9a51-0f1f6c1d2a3b"
    const relay = await startRelay({
      installation: { installationId: null, installationIdConfigured: false },
    })
    await relay.connect(await relay.pair(), { installationId })
    await relay.connect(await relay.pair({ role: "read_only" }), {
      installationId: "read-only-hearth",
    })
    await Promise.all(relay.adoptions)

    // The next start loads it.
    const restarted = {
      provenHearth: null,
      installationId: null,
      installationIdConfigured: false,
    }
    await relay.loadInstallationId(restarted)
    expect(restarted.installationId).toBe(installationId)
  })

  it("passes on the container only a full-access Hearth claims, to check against its session", async () => {
    const claims: Array<HearthContainerClaim> = []
    const relay = await startRelay({
      identifyHearth: (claim) => claims.push(claim),
    })
    const hearthContainer = { id: "a".repeat(64), secret: "1:hearth-secret" }
    await relay.connect(await relay.pair({ role: "read_only" }), {
      hearthContainer,
      installationId: "kiln",
    })
    expect(claims).toEqual([])

    await relay.connect(await relay.pair(), {
      hearthContainer,
      installationId: "kiln",
    })

    expect(claims).toHaveLength(1)
    const [claim] = claims
    expect(claim).toMatchObject({
      containerId: hearthContainer.id,
      installationId: "kiln",
    })
    // The Relay checks the proof against what this session signed.
    expect(claim?.proof).toBe(
      createHmac("sha256", hearthContainer.secret)
        .update(claim?.transcript ?? "")
        .digest("base64url")
    )
  })

  it("adopts Hearth's installation ID before the session accepts requests", async () => {
    // The longest ID Hearth accepts from KILN_INSTALLATION_ID.
    const hearthInstallationId = `Kiln.Production_${"a".repeat(104)}`
    const installation: InstallationConfig = {
      installationId: null,
      installationIdConfigured: false,
    }
    // The first snapshot never arrives, so the session stays between
    // readiness and its snapshot.
    const relay = await startRelay({
      initialSnapshot: () => new Promise(() => undefined),
      installation,
    })
    const hearth = await relay.pair()
    const { inbox, socket } = await relay.open()

    const challenge = (await inbox.next()) as RelayAuthChallenge
    socket.send(
      JSON.stringify({
        ...authResponse(challenge, hearth),
        installationId: hearthInstallationId,
      })
    )

    expect((await inbox.next()).type).toBe("auth.ready")
    expect(installation.installationId).toBe(hearthInstallationId)
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

  it("rejects operations outside the client's grant", async () => {
    const relay = await startRelay()
    const hearth = await relay.pair({
      actions: ["relay.read"],
      role: "custom",
    })
    const { inbox, socket } = await relay.connect(hearth)

    const id = sendRequest(socket, "relay.networking.write", {})

    expect(await inbox.next()).toMatchObject({
      code: "forbidden",
      replyTo: id,
      type: "error",
    })
  })

  it.each([
    "relay.terminal.attach",
    "relay.terminal.write",
    "relay.terminal.claim",
    "relay.terminal.restart",
  ] as const)(
    "refuses host shell operation %s for read-only clients",
    async (operation) => {
      const relay = await startRelay()
      const hearth = await relay.pair({ role: "read_only" })
      const { inbox, socket } = await relay.connect(hearth)
      const id = sendRequest(socket, operation, {})
      expect(await inbox.next()).toMatchObject({
        code: "forbidden",
        replyTo: id,
        type: "error",
      })
    }
  )

  it.each(["relay.restart", "relay.host.restart"] as const)(
    "refuses %s for read-only clients",
    async (operation) => {
      const relay = await startRelay()
      const hearth = await relay.pair({ role: "read_only" })
      const { inbox, socket } = await relay.connect(hearth)
      const id = sendRequest(socket, operation, {})
      expect(await inbox.next()).toMatchObject({
        code: "forbidden",
        replyTo: id,
        type: "error",
      })
    }
  )

  it("keeps an app's files behind app file actions, apart from servers'", async () => {
    const relay = await startRelay()
    const appFiles = `app:${"a".repeat(40)}`
    const serverId = "b".repeat(40)
    const serverReader = await relay.pair({
      actions: ["instance.files.list", "instance.files.read"],
      role: "custom",
    })
    const appReader = await relay.pair({
      actions: ["app.files.read"],
      role: "custom",
    })

    const asServerReader = await relay.connect(serverReader)
    const forApp = sendRequest(asServerReader.socket, "instance.files.read", {
      instanceId: appFiles,
      path: "config.yml",
    })
    expect(await asServerReader.inbox.next()).toMatchObject({
      code: "forbidden",
      replyTo: forApp,
      type: "error",
    })

    const asAppReader = await relay.connect(appReader)
    const ownFiles = sendRequest(asAppReader.socket, "instance.files.read", {
      instanceId: appFiles,
      path: "config.yml",
    })
    expect(await asAppReader.inbox.next()).toMatchObject({
      payload: { ok: true },
      replyTo: ownFiles,
      type: "response",
    })
    const write = sendRequest(asAppReader.socket, "instance.files.write", {
      content: "",
      instanceId: appFiles,
      path: "config.yml",
    })
    expect(await asAppReader.inbox.next()).toMatchObject({
      code: "forbidden",
      replyTo: write,
      type: "error",
    })
    const put = sendRequest(asAppReader.socket, "instance.files.put", {
      contentBase64: "",
      instanceId: appFiles,
      path: "config/new.yml",
    })
    expect(await asAppReader.inbox.next()).toMatchObject({
      code: "forbidden",
      replyTo: put,
      type: "error",
    })
    const forServer = sendRequest(asAppReader.socket, "instance.files.read", {
      instanceId: serverId,
      path: "server.properties",
    })
    expect(await asAppReader.inbox.next()).toMatchObject({
      code: "forbidden",
      replyTo: forServer,
      type: "error",
    })
  })

  it("refuses Relay state to a client granted ordinary database access", async () => {
    const relay = await startRelay()
    const connection = await relay.connect(
      await relay.pair({
        role: "custom",
        actions: ["database.read"],
      })
    )
    const denied = sendRequest(connection.socket, "relay.database.read", {
      request: { action: "overview" },
    })
    expect(await connection.inbox.next()).toMatchObject({
      code: "forbidden",
      replyTo: denied,
      type: "error",
    })
    const reader = await relay.connect(
      await relay.pair({ role: "custom", actions: ["relay.database.read"] })
    )
    const accepted = sendRequest(reader.socket, "relay.database.read", {
      request: { action: "overview" },
    })
    expect(await reader.inbox.next()).toMatchObject({
      payload: { ok: true },
      replyTo: accepted,
      type: "response",
    })
  })

  it("tells a Relay reader its free disk, and only a file reader a root's size", async () => {
    const relay = await startRelay()
    const reader = await relay.connect(
      await relay.pair({ actions: ["relay.read"], role: "custom" })
    )

    const free = sendRequest(reader.socket, "transfer.space", {})
    expect(await reader.inbox.next()).toMatchObject({
      payload: { ok: true },
      replyTo: free,
      type: "response",
    })
    const root = sendRequest(reader.socket, "transfer.space", {
      rootId: "b".repeat(40),
    })
    expect(await reader.inbox.next()).toMatchObject({
      code: "forbidden",
      replyTo: root,
      type: "error",
    })
  })

  it("keeps host files behind their own grants", async () => {
    const relay = await startRelay()
    const hostId = "H".repeat(43)
    for (const actions of [
      ["instance.files.list", "instance.files.read", "instance.files.write"],
      ["app.files.read", "app.files.write"],
    ] as const) {
      const hearth = await relay.pair({ role: "custom", actions })
      const connection = await relay.connect(hearth)
      const id = sendRequest(connection.socket, "instance.files.read", {
        instanceId: hostId,
        path: "etc/os-release",
      })
      expect(await connection.inbox.next()).toMatchObject({
        code: "forbidden",
        replyTo: id,
        type: "error",
      })
    }
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

  // Hearth sends its trace context with each request. A Relay serves the
  // request whatever it carries; trace context never decides whether it runs.
  it.each([
    [
      "a sampled trace",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    ],
    [
      "an unsampled trace",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
    ],
    ["a malformed trace", "00-not-a-trace"],
    ["an oversized trace", "0".repeat(4_096)],
  ])("serves a request carrying %s", async (_, traceparent) => {
    const relay = await startRelay()
    const { inbox, socket } = await relay.connect(await relay.pair())

    const id = sendRequest(socket, "relay.snapshot", {}, { traceparent })

    expect(await inbox.next()).toMatchObject({
      payload: { ok: true },
      replyTo: id,
      type: "response",
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

  it("runs one game server's changes in the order they arrived, and others' at once", async () => {
    const firstServer = "a".repeat(40)
    const secondServer = "b".repeat(40)
    const releases = new Map<string, () => void>()
    const started: Array<string> = []
    const relay = await startRelay({
      execute: async (request) => {
        const { action, instanceId } = request.payload as Record<string, string>
        const label = `${instanceId!.slice(0, 1)}:${action}`
        started.push(label)
        await new Promise<void>((resolve) => releases.set(label, resolve))
        return { label }
      },
    })
    const { inbox, socket } = await relay.connect(await relay.pair())

    const stop = sendRequest(socket, "instance.action", {
      action: "stop",
      instanceId: firstServer,
    })
    const start = sendRequest(socket, "instance.action", {
      action: "start",
      instanceId: firstServer,
    })
    sendRequest(socket, "instance.action", {
      action: "restart",
      instanceId: secondServer,
    })
    await vi.waitFor(() => expect(started).toEqual(["a:stop", "b:restart"]))

    releases.get("a:stop")!()
    expect(await inbox.next()).toMatchObject({ replyTo: stop })
    await vi.waitFor(() =>
      expect(started).toEqual(["a:stop", "b:restart", "a:start"])
    )
    releases.get("a:start")!()
    expect(await inbox.next()).toMatchObject({ replyTo: start })
    releases.get("b:restart")!()
  })

  it("orders a change made by a server's short ID with one made by its full ID", async () => {
    const instanceId = "c".repeat(40)
    const release = deferred<void>()
    const lookedUp = deferred<string>()
    const started: Array<string> = []
    const relay = await startRelay({
      execute: async (request) => {
        const { action } = request.payload as Record<string, string>
        started.push(action!)
        if (action === "stop") await release.promise
        return { ok: true }
      },
      // Finding the container a short ID names takes a moment.
      resolveInstance: (reference) =>
        reference === instanceId ? reference : lookedUp.promise,
    })
    const { inbox, socket } = await relay.connect(await relay.pair())

    const stop = sendRequest(socket, "instance.action", {
      action: "stop",
      instanceId: "cccccccc",
    })
    const start = sendRequest(socket, "instance.action", {
      action: "start",
      instanceId,
    })
    // Neither runs while the short ID is looked up.
    await vi.waitFor(() => expect(relay.lanes.pending.waiting).toBe(2))
    expect(started).toEqual([])

    lookedUp.resolve(instanceId)
    await vi.waitFor(() => expect(started).toEqual(["stop"]))
    expect(relay.lanes.pending.waiting).toBe(1)

    release.resolve()
    expect(await inbox.next()).toMatchObject({ replyTo: stop })
    expect(await inbox.next()).toMatchObject({ replyTo: start })
    expect(started).toEqual(["stop", "start"])
  })

  it("never runs a change still waiting its turn when Hearth disconnects", async () => {
    const instanceId = "a".repeat(40)
    const release = deferred<void>()
    const started: Array<string> = []
    const relay = await startRelay({
      execute: async (request) => {
        const { action } = request.payload as Record<string, string>
        started.push(action!)
        if (action === "stop") await release.promise
        return { ok: true }
      },
    })
    const { socket } = await relay.connect(await relay.pair())

    sendRequest(socket, "instance.action", { action: "stop", instanceId })
    sendRequest(socket, "instance.action", { action: "start", instanceId })
    await vi.waitFor(() => expect(started).toEqual(["stop"]))
    socket.close()
    await vi.waitFor(() => expect(relay.control.sessions.size).toBe(0))
    release.resolve()

    // A later Hearth's request for the same server runs, and the start
    // queued by the one that left never does.
    const next = await relay.connect(await relay.pair())
    const restart = sendRequest(next.socket, "instance.action", {
      action: "restart",
      instanceId,
    })
    expect(await next.inbox.next()).toMatchObject({ replyTo: restart })
    expect(started).toEqual(["stop", "restart"])
  })

  describe("operation IDs", () => {
    const features = [relaySnapshotDeltaFeature]
    const instanceId = "d".repeat(40)

    it("tells a reconnected Hearth how a change went after its reply was lost", async () => {
      const release = deferred<void>()
      const relay = await startRelay({
        execute: async () => {
          await release.promise
          return { stopped: true }
        },
      })
      const hearth = await relay.pair()
      const first = await relay.connect(hearth, { features })
      const operationId = randomUUID()
      sendRequest(
        first.socket,
        "instance.action",
        { action: "stop", instanceId },
        { operationId }
      )
      await vi.waitFor(async () =>
        expect(await lookup(relay, hearth, operationId)).toEqual({
          status: "running",
        })
      )
      first.socket.close()
      await vi.waitFor(() => expect(relay.control.sessions.size).toBe(0))

      // The change keeps running without its Hearth, and its outcome is kept.
      release.resolve()
      await vi.waitFor(async () =>
        expect(await lookup(relay, hearth, operationId)).toEqual({
          result: { stopped: true },
          status: "succeeded",
        })
      )
    })

    it("doesn't run a change again when its ID is sent twice", async () => {
      let runs = 0
      const relay = await startRelay({
        execute: async () => {
          runs += 1
          return { runs }
        },
      })
      const { inbox, socket } = await relay.connect(await relay.pair(), {
        features,
      })
      const operationId = randomUUID()
      const payload = { action: "restart", instanceId }

      sendRequest(socket, "instance.action", payload, { operationId })
      expect(await inbox.next()).toMatchObject({ payload: { runs: 1 } })
      sendRequest(socket, "instance.action", payload, { operationId })
      expect(await inbox.next()).toMatchObject({ payload: { runs: 1 } })
      expect(runs).toBe(1)

      // The same ID for a different change is refused, not run.
      const conflict = sendRequest(
        socket,
        "instance.action",
        { action: "kill", instanceId },
        { operationId }
      )
      expect(await inbox.next()).toMatchObject({
        code: "operation_conflict",
        replyTo: conflict,
        type: "error",
      })
      expect(runs).toBe(1)
    })

    it("keeps a failed change's error for lookups", async () => {
      const relay = await startRelay({
        execute: async () => {
          throw new Error("Server is not stopped")
        },
      })
      const hearth = await relay.pair()
      const { inbox, socket } = await relay.connect(hearth, { features })
      const operationId = randomUUID()
      sendRequest(
        socket,
        "instance.action",
        { action: "start", instanceId },
        { operationId }
      )
      expect(await inbox.next()).toMatchObject({ type: "error" })
      expect(await lookup(relay, hearth, operationId)).toMatchObject({
        code: "operation_failed",
        message: "Server is not stopped",
        status: "failed",
      })
    })

    it("reports a change it never received as unknown, and one a restart cut off as interrupted", async () => {
      const relay = await startRelay()
      const hearth = await relay.pair()
      expect(await lookup(relay, hearth, randomUUID())).toEqual({
        status: "unknown",
      })

      const operationId = randomUUID()
      await relay.run(
        relay.state.startOperation({
          clientId: hearth.id,
          operation: "instance.action",
          operationId,
          payloadSha256: "x",
          startedAt: Date.now(),
        })
      )
      await relay.run(relay.state.interruptRunningOperations(Date.now()))
      expect(await lookup(relay, hearth, operationId)).toEqual({
        status: "interrupted",
      })
    })

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

    it("keeps how a journaled change went when a request reuses its ID for something else", async () => {
      let runs = 0
      const relay = await startRelay({
        execute: async () => {
          runs += 1
          return {}
        },
      })
      const hearth = await relay.pair()
      const { inbox, socket } = await relay.connect(hearth, { features })
      // A change from before a restart, so only the journal knows it.
      const operationId = randomUUID()
      await relay.run(
        relay.state.startOperation({
          clientId: hearth.id,
          operation: "instance.action",
          operationId,
          payloadSha256: "an-earlier-change",
          startedAt: Date.now(),
        })
      )
      await relay.run(
        relay.state.finishOperation({
          clientId: hearth.id,
          errorCode: null,
          errorMessage: null,
          finishedAt: Date.now(),
          operationId,
          retryable: false,
          status: "succeeded",
        })
      )

      sendRequest(
        socket,
        "instance.action",
        { action: "kill", instanceId },
        { operationId }
      )
      expect(await inbox.next()).toMatchObject({ code: "operation_conflict" })
      expect(runs).toBe(0)
      expect(await lookup(relay, hearth, operationId)).toEqual({
        status: "succeeded",
      })
    })

    it("runs a change once when its repeat claims the ID first", async () => {
      const slowLookup = deferred<void>()
      const clientLookups: Array<Promise<void>> = []
      let runs = 0
      const relay = await startRelay({
        clientLookups,
        execute: async () => {
          runs += 1
          return { runs }
        },
      })
      const hearth = await relay.pair()
      const first = await relay.connect(hearth, { features })
      const second = await relay.connect(hearth, { features })
      const operationId = randomUUID()
      const payload = { action: "restart", instanceId }

      // The first is first in line but slower to be checked, so its repeat
      // claims the ID and then waits its turn behind it.
      clientLookups.push(slowLookup.promise)
      sendRequest(first.socket, "instance.action", payload, { operationId })
      await vi.waitFor(() => expect(clientLookups).toHaveLength(0))
      sendRequest(second.socket, "instance.action", payload, { operationId })
      await vi.waitFor(async () =>
        expect(await lookup(relay, hearth, operationId)).toEqual({
          status: "running",
        })
      )
      slowLookup.resolve()

      expect(await first.inbox.next()).toMatchObject({ payload: { runs: 1 } })
      expect(await second.inbox.next()).toMatchObject({ payload: { runs: 1 } })
      expect(runs).toBe(1)
    })

    it("refuses each of two requests that reuse a journaled change's ID at once", async () => {
      const journalRead = deferred<void>()
      const relay = await startRelay({
        execute: async () => ({}),
        journalReads: journalRead.promise,
      })
      const hearth = await relay.pair()
      const { inbox, socket } = await relay.connect(hearth, { features })
      const operationId = randomUUID()
      await relay.run(
        relay.state.startOperation({
          clientId: hearth.id,
          operation: "instance.action",
          operationId,
          payloadSha256: "an-earlier-change",
          startedAt: Date.now(),
        })
      )
      await relay.run(
        relay.state.finishOperation({
          clientId: hearth.id,
          errorCode: null,
          errorMessage: null,
          finishedAt: Date.now(),
          operationId,
          retryable: false,
          status: "succeeded",
        })
      )

      // The second arrives while the Relay still reads the first's journal.
      const payload = { action: "kill", instanceId }
      sendRequest(socket, "instance.action", payload, { operationId })
      sendRequest(socket, "instance.action", payload, { operationId })
      await vi.waitFor(async () =>
        expect(await lookup(relay, hearth, operationId)).toEqual({
          status: "running",
        })
      )
      journalRead.resolve()
      expect(await inbox.next()).toMatchObject({ code: "operation_conflict" })
      expect(await inbox.next()).toMatchObject({ code: "operation_conflict" })
    })

    it("journals how a change went before the Relay finishes closing", async () => {
      const relay = await startRelay({
        execute: async () => ({ stopped: true }),
      })
      const hearth = await relay.pair()
      const { inbox, socket } = await relay.connect(hearth, { features })
      const operationId = randomUUID()
      sendRequest(
        socket,
        "instance.action",
        { action: "stop", instanceId },
        { operationId }
      )
      expect(await inbox.next()).toMatchObject({ payload: { stopped: true } })
      // Shutting down right after the reply, as an update does.
      await relay.control.close()

      const database = new DatabaseSync(relay.databaseFile)
      try {
        expect(
          database
            .prepare(
              "SELECT status FROM relay_operations WHERE operation_id = ?"
            )
            .get(operationId)
        ).toEqual({ status: "succeeded" })
      } finally {
        database.close()
      }
    })

    it("runs a change sent from two sessions at once only once", async () => {
      const release = deferred<void>()
      let runs = 0
      const relay = await startRelay({
        execute: async () => {
          runs += 1
          await release.promise
          return { renamed: true }
        },
      })
      const hearth = await relay.pair()
      const first = await relay.connect(hearth, { features })
      const second = await relay.connect(hearth, { features })
      const operationId = randomUUID()
      const payload = { name: "Lobby" }
      sendRequest(first.socket, "relay.rename", payload, { operationId })
      await vi.waitFor(() => expect(runs).toBe(1))
      sendRequest(second.socket, "relay.rename", payload, { operationId })
      // A different change under the same ID is refused, even while it runs.
      const conflict = sendRequest(
        second.socket,
        "relay.rename",
        { name: "Other" },
        { operationId }
      )
      expect(await second.inbox.next()).toMatchObject({
        code: "operation_conflict",
        replyTo: conflict,
      })

      release.resolve()
      expect(await first.inbox.next()).toMatchObject({
        payload: { renamed: true },
      })
      expect(await second.inbox.next()).toMatchObject({
        payload: { renamed: true },
      })
      expect(runs).toBe(1)
      expect(await lookup(relay, hearth, operationId)).toMatchObject({
        status: "succeeded",
      })
    })

    it("records a change withdrawn before it ran, after it already acted", async () => {
      const appId = "f".repeat(40)
      let aborted = 0
      const relay = await startRelay({
        beforeRun: () => {
          aborted += 1
        },
      })
      const hearth = await relay.pair()
      const { socket } = await relay.connect(hearth, { features })
      // Something already holds the App, so the delete waits.
      const holding = relay.lanes.admit({
        label: "deployment",
        locks: [exclusive(`app:${appId}`)],
      })
      const operationId = randomUUID()
      sendRequest(
        socket,
        "app.delete",
        { appId, deleteData: false },
        { operationId }
      )
      await vi.waitFor(() => expect(aborted).toBe(1))
      socket.close()
      await vi.waitFor(() => expect(relay.control.sessions.size).toBe(0))
      holding.cancel()

      // It didn't run, but the Relay knows it took it.
      await vi.waitFor(async () =>
        expect(await lookup(relay, hearth, operationId)).toMatchObject({
          code: "operation_withdrawn",
          status: "failed",
        })
      )
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

  it("refuses changes while paused, but still answers reads and resumes", async () => {
    const ran: Array<string> = []
    const relay = await startRelay({
      execute: async (request) => {
        ran.push(request.operation)
        return { ok: true }
      },
    })
    const { inbox, socket } = await relay.connect(await relay.pair())
    relay.lanes.setPaused(true)

    const start = sendRequest(socket, "instance.action", {
      action: "start",
      instanceId: "a".repeat(40),
    })
    expect(await inbox.next()).toMatchObject({
      code: "relay_paused",
      replyTo: start,
      type: "error",
    })
    // Changes that take no lane are refused too.
    const rename = sendRequest(socket, "relay.rename", { name: "Paused" })
    expect(await inbox.next()).toMatchObject({
      code: "relay_paused",
      replyTo: rename,
    })
    // So is terminal input, which can change anything.
    const input = sendRequest(socket, "database.terminal.write", {})
    expect(await inbox.next()).toMatchObject({
      code: "relay_paused",
      replyTo: input,
    })
    const read = sendRequest(socket, "relay.system.inspect", {})
    expect(await inbox.next()).toMatchObject({
      replyTo: read,
      type: "response",
    })
    const resume = sendRequest(socket, "relay.pause.write", { paused: false })
    expect(await inbox.next()).toMatchObject({
      replyTo: resume,
      type: "response",
    })
    expect(ran).toEqual(["relay.system.inspect", "relay.pause.write"])
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

    // A change already running answers with how it went, so Hearth learns
    // whether it ran.
    expect(await inbox.next()).toMatchObject({
      code: "request_cancelled",
      replyTo: cancelledId,
      type: "error",
    })
    const followUpId = sendRequest(socket, "relay.snapshot", {})
    expect(await inbox.next()).toMatchObject({
      replyTo: followUpId,
      type: "response",
    })
  })

  it("frees the place of a request Hearth cancels before it starts", async () => {
    const release = deferred<void>()
    onTestFinished(() => release.resolve())
    const running = new Map<string, () => void>()
    const relay = await startRelay({
      execute: async (request) => {
        const started = running.get(request.id)
        if (started) {
          started()
          await release.promise
        }
        return { ok: true }
      },
    })
    const { inbox, socket } = await relay.connect(await relay.pair())

    // A Relay that stalled reads Hearth's backlog in one go: each request,
    // then the cancel Hearth sent when it gave up on it. Enough of them to
    // fill every place, some with timeouts the Relay refuses.
    const transport = (socket as unknown as { _socket: Socket })._socket
    transport.cork()
    for (let index = 0; index < 32; index++) {
      const id = sendRequest(
        socket,
        "relay.snapshot",
        {},
        index % 2 ? { timeoutMs: 0 } : {}
      )
      socket.send(
        JSON.stringify({
          id: randomBytes(12).toString("hex"),
          replyTo: id,
          type: "cancel",
          v: 1,
        })
      )
    }
    transport.uncork()

    // The cancelled requests give up their places as they unwind, so every
    // place takes a request again. Until they have, the Relay may still say
    // it's full, but nothing else.
    const held: Array<string> = []
    let reply = inbox.next()
    for (let attempt = 0; held.length < 32 && attempt < 64; attempt++) {
      const id = randomBytes(12).toString("hex")
      const started = new Promise<"started">((resolve) =>
        running.set(id, () => resolve("started"))
      )
      sendRequest(socket, "relay.snapshot", {}, { id })
      const outcome = await Promise.race([started, reply])
      if (outcome === "started") {
        held.push(id)
        continue
      }
      expect(outcome).toMatchObject({
        code: "too_many_requests",
        replyTo: id,
        type: "error",
      })
      reply = inbox.next()
    }
    expect(held).toHaveLength(32)

    const overflowId = sendRequest(socket, "relay.snapshot", {})
    expect(await reply).toMatchObject({
      code: "too_many_requests",
      replyTo: overflowId,
      type: "error",
    })
    release.resolve()
    const answered = new Set<string>()
    for (const _ of held) {
      const response = await inbox.next()
      expect(response).toMatchObject({ type: "response" })
      if ("replyTo" in response && response.replyTo) {
        answered.add(response.replyTo)
      }
    }
    expect([...answered].sort()).toEqual([...held].sort())
  })

  it("counts work Hearth stopped waiting for until it settles", async () => {
    const started = deferred<void>()
    const finish = deferred<void>()
    onTestFinished(() => finish.resolve())
    const relay = await startRelay({
      // Like a file read, it doesn't stop when its request is cancelled.
      execute: async () => {
        started.resolve()
        await finish.promise
        return { ok: true }
      },
    })
    const { socket } = await relay.connect(await relay.pair())

    const id = sendRequest(socket, "relay.snapshot", {})
    await started.promise
    expect(relay.control.capacity()).toMatchObject({
      inFlight: 1,
      orphanedWork: 0,
    })

    socket.send(
      JSON.stringify({
        id: randomBytes(12).toString("hex"),
        replyTo: id,
        type: "cancel",
        v: 1,
      })
    )
    // The cancel frees the request's place, but its work runs on.
    await vi.waitFor(() =>
      expect(relay.control.capacity()).toMatchObject({
        inFlight: 0,
        orphanedWork: 1,
      })
    )

    finish.resolve()
    await vi.waitFor(() =>
      expect(relay.control.capacity()).toMatchObject({ orphanedWork: 0 })
    )
  })

  it("counts a change still running after its Hearth disconnects", async () => {
    const started = deferred<void>()
    const finish = deferred<void>()
    onTestFinished(() => finish.resolve())
    const relay = await startRelay({
      execute: async () => {
        started.resolve()
        await finish.promise
        return { ok: true }
      },
    })
    const hearth = await relay.pair()
    const { socket } = await relay.connect(hearth)

    const operationId = randomUUID()
    sendRequest(
      socket,
      "instance.action",
      { action: "stop", instanceId: "d".repeat(40) },
      { operationId }
    )
    await started.promise
    socket.close()
    await vi.waitFor(() => expect(relay.control.sessions.size).toBe(0))
    // A change finishes once started, with no session left to wait for it.
    expect(relay.control.capacity()).toMatchObject({
      inFlight: 0,
      orphanedWork: 1,
    })

    finish.resolve()
    await vi.waitFor(async () =>
      expect(await lookup(relay, hearth, operationId)).toMatchObject({
        status: "succeeded",
      })
    )
    await vi.waitFor(() =>
      expect(relay.control.capacity()).toMatchObject({ orphanedWork: 0 })
    )
  })

  it("counts a change that starts after its Hearth disconnected", async () => {
    const journalRead = deferred<void>()
    const started = deferred<void>()
    const finish = deferred<void>()
    onTestFinished(() => {
      journalRead.resolve()
      finish.resolve()
    })
    const relay = await startRelay({
      journalReads: journalRead.promise,
      execute: async () => {
        started.resolve()
        await finish.promise
        return { ok: true }
      },
    })
    const hearth = await relay.pair()
    const { socket } = await relay.connect(hearth)

    const operationId = randomUUID()
    sendRequest(socket, "relay.rename", { name: "review" }, { operationId })
    await vi.waitFor(async () =>
      expect(await lookup(relay, hearth, operationId)).toEqual({
        status: "running",
      })
    )
    socket.close()
    await vi.waitFor(() => expect(relay.control.sessions.size).toBe(0))

    // Its journal read held it back; it starts with its session gone.
    journalRead.resolve()
    await started.promise
    expect(relay.control.capacity()).toMatchObject({
      inFlight: 0,
      orphanedWork: 1,
    })

    finish.resolve()
    await vi.waitFor(async () =>
      expect(await lookup(relay, hearth, operationId)).toMatchObject({
        status: "succeeded",
      })
    )
    await vi.waitFor(() =>
      expect(relay.control.capacity()).toMatchObject({ orphanedWork: 0 })
    )
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

  it("answers not_found for something a request named that isn't here", async () => {
    const relay = await startRelay({
      execute: async () => {
        throw RelayNotFoundError.make({
          message: "Container hearth isn't on this Relay's Docker host",
        })
      },
    })
    const { inbox, socket } = await relay.connect(await relay.pair())

    const id = sendRequest(socket, "relay.system.inspect", {
      container: "hearth",
    })
    expect(await inbox.next()).toMatchObject({
      code: "not_found",
      message: "Container hearth isn't on this Relay's Docker host",
      replyTo: id,
      type: "error",
    })
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

  it("sends node resource samples only to Hearths that advertise support", async () => {
    const relay = await startRelay()
    const resourceClient = await relay.connect(await relay.pair(), {
      features: [relaySnapshotDeltaFeature, relaySnapshotNodeResourcesFeature],
    })
    // Older Hearths forward every node delta to browsers.
    const controlClient = await relay.connect(await relay.pair(), {
      features: [relaySnapshotDeltaFeature],
    })

    const sampled = {
      instances: [],
      node: { relayMemory: { container: null, process: { rssBytes: 1 } } },
    }
    relay.pushSnapshot(sampled)
    relay.pushSnapshot({ ...sampled, instances: [{ id: "added" }] })

    expect(await resourceClient.inbox.next()).toMatchObject({
      event: "relay.snapshot.delta",
      payload: { instances: [], node: sampled.node },
      seq: 2,
    })
    expect(await resourceClient.inbox.next()).toMatchObject({
      event: "relay.snapshot.delta",
      payload: { instances: [{ id: "added" }] },
      seq: 3,
    })
    const controlDelta = await controlClient.inbox.next()
    expect(controlDelta).toMatchObject({
      event: "relay.snapshot.delta",
      payload: { instances: [{ id: "added" }] },
      seq: 2,
    })
    expect(controlDelta).not.toHaveProperty("payload.node")
  })
})

const initialSnapshot = { instances: [], node: {} }

interface TestHearth {
  readonly id: string
  readonly privateKey: string
}

async function startRelay(
  options: {
    readonly execute?: ControlSocketOptions["execute"]
    readonly initialSnapshot?: ControlSocketOptions["initialSnapshot"]
    readonly installation?: InstallationConfig
    readonly identifyHearth?: ControlSocketOptions["identifyHearth"]
    readonly resolveInstance?: InstanceResolver
    readonly beforeRun?: ControlSocketOptions["beforeRun"]
    /** Holds reads of the operation journal until it settles, as a slow disk would. */
    readonly journalReads?: Promise<void>
    /** Each request's client lookup waits for the next of these, if any. */
    readonly clientLookups?: Array<Promise<void>>
  } = {}
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
  const adoptions: Array<Promise<void>> = []
  const installation = options.installation
  const lanes = new OperationLanes()
  const control = attachControlSocket({
    ...(installation
      ? {
          adoptInstallationId: (installationId: string) => {
            const adopted = runtime.runPromise(
              adoptInstallationId(installation, state, installationId)
            )
            adoptions.push(adopted)
            return adopted
          },
        }
      : {}),
    ...(options.beforeRun ? { beforeRun: options.beforeRun } : {}),
    ...(options.identifyHearth
      ? { identifyHearth: options.identifyHearth }
      : {}),
    execute: options.execute ?? (async () => ({ ok: true })),
    lanes,
    requestLocks: (request) =>
      controlRequestLocks(
        request.operation,
        request.payload as Record<string, unknown>,
        options.resolveInstance ?? ((reference) => reference)
      ),
    identity: {
      fingerprint: fingerprint(relayKeys.public),
      name: "Test Relay",
      privateKeyPem: relayKeys.private,
      publicKeyPem: relayKeys.public,
    },
    initialSnapshot: options.initialSnapshot ?? (async () => initialSnapshot),
    runEffect: (effect) => runtime.runPromise(effect),
    server,
    state: {
      ...state,
      findClientById: (clientId) => {
        const lookup = options.clientLookups?.shift()
        return lookup
          ? Effect.promise(() => lookup).pipe(
              Effect.andThen(state.findClientById(clientId))
            )
          : state.findClientById(clientId)
      },
      getOperation: (clientId, operationId) =>
        options.journalReads
          ? Effect.promise(() => options.journalReads!).pipe(
              Effect.andThen(state.getOperation(clientId, operationId))
            )
          : state.getOperation(clientId, operationId),
    },
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
    adoptions,
    audits: () => runtime.runPromise(state.listAudits({ limit: 100 })),
    connect: async (
      hearth: TestHearth,
      connectOptions: {
        readonly features?: ReadonlyArray<string>
        // The container it runs in, proven with this secret as Hearth does.
        readonly hearthContainer?: { id: string; secret: string }
        readonly installationId?: string
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
          ...(connectOptions.installationId
            ? { installationId: connectOptions.installationId }
            : {}),
          ...(connectOptions.hearthContainer
            ? {
                hearthContainer: {
                  id: connectOptions.hearthContainer.id,
                  proof: createHmac(
                    "sha256",
                    connectOptions.hearthContainer.secret
                  )
                    .update(
                      relayHearthContainerTranscript(
                        challenge,
                        hearth.id,
                        connectOptions.hearthContainer.id
                      )
                    )
                    .digest("base64url"),
                },
              }
            : {}),
        })
      )
      expect((await connection.inbox.next()).type).toBe("auth.ready")
      expect((await connection.inbox.next()).type).toBe("event")
      return connection
    },
    control,
    databaseFile: join(directory, "relay.sqlite"),
    lanes,
    loadInstallationId: (
      config: InstallationConfig & Pick<RelayConfig, "provenHearth">
    ) => runtime.runPromise(loadInstallationId(config, state)),
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
    readonly deadline?: number
    readonly id?: string
    readonly operationId?: string
    readonly subject?: string
    readonly timeoutMs?: number
    readonly traceparent?: string
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
