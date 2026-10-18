import { generateKeyPairSync, randomBytes, sign, verify } from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Duplex } from "node:stream"
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
  relaySnapshotNodeResourcesFeature,
} from "@workspace/contracts"
import type {
  RelayAuthChallenge,
  RelayControlOperation,
  RelayControlRequest,
  RelayControlServerMessage,
} from "@workspace/contracts"

import { attachControlSocket } from "./control-socket.js"
import type { ControlSocketOptions } from "./control-socket.js"
import { RelayNotFoundError } from "./effect/errors.js"
import { fingerprint } from "./effect/identity.js"
import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"
import { adoptInstallationId, loadInstallationId } from "./installation.js"
import type { RelayClientRole } from "./effect/state.js"
import type { RelayAction } from "./permissions.js"
import type { RelayConfig } from "./config.js"
import { sendRawRequest } from "./test/raw-http.js"

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
    const restarted = { installationId: null, installationIdConfigured: false }
    await relay.loadInstallationId(restarted)
    expect(restarted.installationId).toBe(installationId)
  })

  it("adopts Hearth's installation ID before the session accepts requests", async () => {
    // The longest ID Hearth accepts from KILN_INSTALLATION_ID.
    const hearthInstallationId = `Kiln.Production_${"a".repeat(104)}`
    const installation = {
      installationId: "previous-installation",
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
    execute: options.execute ?? (async () => ({ ok: true })),
    identity: {
      fingerprint: fingerprint(relayKeys.public),
      name: "Test Relay",
      privateKeyPem: relayKeys.private,
      publicKeyPem: relayKeys.public,
    },
    initialSnapshot: options.initialSnapshot ?? (async () => initialSnapshot),
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
    adoptions,
    audits: () => runtime.runPromise(state.listAudits({ limit: 100 })),
    connect: async (
      hearth: TestHearth,
      connectOptions: {
        readonly features?: ReadonlyArray<string>
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
        })
      )
      expect((await connection.inbox.next()).type).toBe("auth.ready")
      expect((await connection.inbox.next()).type).toBe("event")
      return connection
    },
    control,
    loadInstallationId: (config: InstallationConfig) =>
      runtime.runPromise(loadInstallationId(config, state)),
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

function sendRequest(
  socket: WebSocket,
  operation: RelayControlOperation,
  payload: unknown,
  overrides: {
    readonly deadline?: number
    readonly id?: string
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
