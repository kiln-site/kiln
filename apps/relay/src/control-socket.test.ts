import { generateKeyPairSync, randomBytes, sign, verify } from "node:crypto"
import { createServer } from "node:http"
import { once } from "node:events"
import { Effect } from "effect"
import { WebSocket } from "ws"
import { describe, expect, it } from "vite-plus/test"

import {
  relayAuthChallengeTranscript,
  relayAuthResponseTranscript,
  relayControlDeadlineMs,
  relayControlRequestTimeoutMs,
  relayControlProtocol,
} from "@workspace/contracts"
import type {
  RelayAuthChallenge,
  RelayControlRequest,
  RelayControlServerMessage,
} from "@workspace/contracts"

import {
  attachControlSocket,
  auditDetailsForRequest,
  isAuditedOperation,
  relayControlErrorMessage,
  relayControlFailureTags,
} from "./control-socket.js"
import { fingerprint } from "./effect/identity.js"
import { RelayStateStore } from "./effect/state.js"
import type { RelayAuditInput, RelayClientRecord } from "./effect/state.js"

describe("Relay control timeouts", () => {
  it("prefers relative timeouts and clamps them to the operation maximum", () => {
    const request: RelayControlRequest = {
      deadline: 1,
      id: "request",
      operation: "relay.update.apply",
      payload: {},
      timeoutMs: relayControlDeadlineMs("relay.update.apply") + 60_000,
      type: "request",
      v: 1,
    }

    expect(relayControlRequestTimeoutMs(request, 10_000_000)).toBe(
      relayControlDeadlineMs("relay.update.apply")
    )
    expect(relayControlDeadlineMs("instance.delete")).toBeGreaterThan(
      relayControlDeadlineMs("hearth.tailscale.instance.detach") + 135_000
    )
    expect(relayControlDeadlineMs("instance.action")).toBeGreaterThan(75_000)
    expect(relayControlDeadlineMs("instance.files.upload-url")).toBe(360_000)
    expect(
      relayControlRequestTimeoutMs({ ...request, timeoutMs: 0 }, 10_000_000)
    ).toBeNull()
    expect(
      relayControlRequestTimeoutMs(
        {
          deadline: 15_000,
          id: "legacy-request",
          operation: "relay.snapshot",
          payload: {},
          type: "request",
          v: 1,
        },
        10_000
      )
    ).toBe(5_000)
  })
})

describe("Relay control errors", () => {
  it("correlates application failure telemetry with the request", () => {
    expect(
      relayControlFailureTags({
        id: "3df56ba5-b2c1-45ee-bab7-386fbb9223c7",
        operation: "instance.console.write",
      })
    ).toEqual({
      "kiln.operation": "instance.console.write",
      "kiln.request_id": "3df56ba5-b2c1-45ee-bab7-386fbb9223c7",
      "kiln.transport": "control-socket",
    })
  })

  it("returns a safe final command detail when the full message is too long", () => {
    const command = `docker network create ${"hearth-feature-".repeat(16)}`
    expect(
      relayControlErrorMessage(
        new Error(
          `Command failed: ${command}\nError response from daemon: all predefined address pools have been fully subnetted\n`
        )
      )
    ).toBe(
      "Error response from daemon: all predefined address pools have been fully subnetted"
    )
  })

  it("does not expose an overlong single-line error", () => {
    expect(relayControlErrorMessage(new Error("x".repeat(241)))).toBe(
      "Relay operation failed"
    )
  })
})

describe("Relay control audit details", () => {
  it("audits database dump exports", () => {
    expect(isAuditedOperation("database.dump.export")).toBe(true)
  })

  it("attributes mutations and scopes created instances from the result", () => {
    const request: RelayControlRequest = {
      deadline: Date.now() + 5_000,
      id: "request",
      operation: "instance.create",
      payload: { name: "Survival" },
      subject: "user-123",
      timeoutMs: 5_000,
      type: "request",
      v: 1,
    }
    const instanceId = "a".repeat(40)

    expect(auditDetailsForRequest(request, { id: instanceId })).toEqual({
      instanceId,
      operation: "instance.create",
      permission: "instance.create",
      subject: "user-123",
    })
  })

  it("attributes created databases from the request", () => {
    const databaseId = "b".repeat(40)
    const request: RelayControlRequest = {
      deadline: Date.now() + 5_000,
      id: "request",
      operation: "database.create",
      payload: { id: databaseId, name: "Primary" },
      subject: "user-123",
      timeoutMs: 5_000,
      type: "request",
      v: 1,
    }

    expect(auditDetailsForRequest(request, {})).toEqual({
      databaseId,
      operation: "database.create",
      permission: "database.create",
      subject: "user-123",
    })
  })

  it("attributes CLI mutations to the owning user and credential", () => {
    const credentialId = "12345678-1234-4123-8123-123456789abc"
    const request: RelayControlRequest = {
      deadline: Date.now() + 5_000,
      id: "request",
      operation: "instance.console.write",
      payload: { command: "say deployed", instanceId: "a".repeat(40) },
      subject: `cli/${credentialId}/user-123`,
      timeoutMs: 5_000,
      type: "request",
      v: 1,
    }

    expect(auditDetailsForRequest(request, {})).toEqual({
      cliCredentialId: credentialId,
      instanceId: "a".repeat(40),
      operation: "instance.console.write",
      permission: "instance.console.write",
      source: "cli",
      subject: "user-123",
    })
  })

  it("audits Relay-side URL uploads with the dedicated action", () => {
    const request: RelayControlRequest = {
      deadline: Date.now() + 5_000,
      id: "request",
      operation: "instance.files.upload-url",
      payload: {
        instanceId: "a".repeat(40),
        path: "plugins/example.jar",
        url: "https://example.com/example.jar",
      },
      timeoutMs: 5_000,
      type: "request",
      v: 1,
    }

    expect(isAuditedOperation(request.operation)).toBe(true)
    expect(auditDetailsForRequest(request, {})).toEqual({
      instanceId: "a".repeat(40),
      operation: "instance.files.upload-url",
      permission: "instance.files.upload-url",
    })
  })
})

describe("Relay control socket", () => {
  it("authenticates a paired Hearth and executes an authorized request", async () => {
    const relayKeys = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    })
    const hearthKeys = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    })
    const client: RelayClientRecord = {
      actions: [
        "instance.console.write",
        "instance.network.write",
        "relay.read",
      ],
      createdAt: Date.now(),
      id: fingerprint(hearthKeys.publicKey),
      invitationId: "test-invitation",
      lastAddress: null,
      lastSeenAt: null,
      name: "Test Hearth",
      origins: ["https://hearth.test"],
      publicKey: hearthKeys.publicKey,
      role: "custom",
      sourceCidrs: [],
    }
    let blockClientLookup = false
    let releaseClientLookup: (() => void) | undefined
    const audits: Array<RelayAuditInput> = []
    const state = RelayStateStore.of({
      appendAudit: (input) =>
        Effect.sync(() => {
          audits.push(input)
        }),
      cancelBackupTask: () => Effect.succeed(false),
      createInvitation: () => Effect.void,
      findActiveInvitation: () => Effect.succeed(null),
      findClientById: (clientId) =>
        blockClientLookup
          ? Effect.promise(
              () =>
                new Promise<RelayClientRecord | null>((resolve) => {
                  releaseClientLookup = () =>
                    resolve(clientId === client.id ? client : null)
                })
            )
          : Effect.succeed(clientId === client.id ? client : null),
      findClientByPublicKey: () => Effect.succeed(null),
      findInvitationById: () => Effect.succeed(null),
      getMetadata: () => Effect.succeed(null),
      enqueueBackupTask: () => Effect.die("not implemented"),
      claimNextBackupTask: () => Effect.succeed(null),
      getBackupTask: () => Effect.succeed(null),
      listBackupTasks: () => Effect.succeed([]),
      updateBackupTaskProgress: () => Effect.succeed(false),
      updateBackupTaskOperationProgress: () => Effect.succeed(false),
      completeBackupTask: () => Effect.succeed(false),
      failBackupTask: () => Effect.succeed(false),
      requeueInterruptedBackupTasks: () => Effect.succeed(0),
      enqueueProvisioningJob: () => Effect.die("not implemented"),
      claimProvisioningJob: () => Effect.succeed(null),
      claimNextProvisioningJob: () => Effect.succeed(null),
      cancelProvisioningJob: () => Effect.succeed(false),
      failProvisioningJob: () => Effect.succeed(false),
      completeProvisioningJob: () => Effect.succeed(false),
      getProvisioningJob: () => Effect.succeed(null),
      listProvisioningJobs: () => Effect.succeed([]),
      updateProvisioningJobPlaceholder: () => Effect.succeed(false),
      requeueInterruptedProvisioningJobs: () => Effect.succeed(0),
      getPendingPrimaryPort: () => Effect.succeed(null),
      getRuntimeRecovery: () => Effect.succeed(null),
      listClients: () => Effect.succeed([client]),
      listAudits: () => Effect.succeed([]),
      listInstanceNames: () => Effect.succeed([]),
      listPendingPrimaryPorts: () => Effect.succeed([]),
      listReadySessions: () => Effect.succeed([]),
      listRuntimeRecoveries: () => Effect.succeed([]),
      listInstanceRoutes: () => Effect.succeed([]),
      listInvitations: () => Effect.succeed([]),
      listWebRoutes: () => Effect.succeed([]),
      pairClient: () => Effect.void,
      revokeClient: () => Effect.succeed(false),
      revokeInvitation: () => Effect.succeed(false),
      replaceInstanceRoutes: () => Effect.void,
      deleteInstanceName: () => Effect.void,
      deletePendingPrimaryPort: () => Effect.void,
      deleteReadySession: () => Effect.void,
      deleteRuntimeRecovery: () => Effect.void,
      setInstanceName: () => Effect.void,
      setMetadata: () => Effect.void,
      setPendingPrimaryPort: () => Effect.void,
      setReadySession: () => Effect.void,
      setRuntimeRecovery: () => Effect.void,
      touchClient: () => Effect.void,
      updateClient: () => Effect.succeed(false),
    })
    const server = createServer()
    let pushSnapshot: ((snapshot: unknown) => void) | undefined
    const control = attachControlSocket({
      execute: async (request, _client, signal) => {
        if (request.operation === "instance.console.write") {
          throw new Error("Survival is not running")
        }
        if (
          request.payload === "finish-at-timeout" ||
          request.payload === "wait-for-timeout"
        ) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else
              signal.addEventListener("abort", () => resolve(), { once: true })
          })
        }
        if (request.payload === "wait-for-timeout") {
          throw new Error("Request aborted")
        }
        return { ok: true }
      },
      identity: {
        fingerprint: fingerprint(relayKeys.publicKey),
        name: "Test Relay",
        privateKeyPem: relayKeys.privateKey,
        publicKeyPem: relayKeys.publicKey,
      },
      initialSnapshot: async () => ({ instances: [], node: {} }),
      subscribeSnapshots: (listener) => {
        pushSnapshot = listener
        return () => {
          pushSnapshot = undefined
        }
      },
      runEffect: (effect) => Effect.runPromise(effect),
      server,
      state,
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing port")
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/socket`,
      relayControlProtocol
    )
    const inbox = messageInbox(socket)

    try {
      const challenge = (await inbox.next()) as RelayAuthChallenge
      expect(challenge.type).toBe("auth.challenge")
      expect(
        verify(
          null,
          Buffer.from(relayAuthChallengeTranscript(challenge)),
          relayKeys.publicKey,
          Buffer.from(challenge.signature, "base64url")
        )
      ).toBe(true)
      socket.send(
        JSON.stringify({
          clientId: client.id,
          signature: sign(
            null,
            Buffer.from(relayAuthResponseTranscript(challenge, client.id)),
            hearthKeys.privateKey
          ).toString("base64url"),
          type: "auth.response",
          v: 1,
        })
      )
      expect((await inbox.next()).type).toBe("auth.ready")
      expect((await inbox.next()).type).toBe("event")

      const consoleRequestId = randomBytes(12).toString("hex")
      socket.send(
        JSON.stringify({
          deadline: Date.now() + 5_000,
          id: consoleRequestId,
          operation: "instance.console.write",
          payload: {
            command: "stop",
            instanceId: "a".repeat(40),
          },
          type: "request",
          v: 1,
        })
      )
      const consoleFailure = await inbox.next()
      expect(consoleFailure.type).toBe("error")
      if (consoleFailure.type === "error") {
        expect(consoleFailure.code).toBe("operation_failed")
        expect(consoleFailure.message).toBe("Survival is not running")
        expect(consoleFailure.replyTo).toBe(consoleRequestId)
        expect(consoleFailure.retryable).toBe(false)
      }

      const reverseResult = control.requestClients(
        "sftp.authorization.resolve",
        { username: "owner.server" },
        5_000
      )
      const reverseRequest = await inbox.next()
      expect(reverseRequest.type).toBe("request")
      if (reverseRequest.type === "request") {
        expect(reverseRequest.timeoutMs).toBe(5_000)
        socket.send(
          JSON.stringify({
            id: randomBytes(12).toString("hex"),
            payload: { allowed: true },
            replyTo: reverseRequest.id,
            type: "response",
            v: 1,
          })
        )
      }
      await expect(reverseResult).resolves.toEqual([
        { clientId: client.id, payload: { allowed: true } },
      ])

      const cancelledReverseResult = control.requestClients(
        "hearth.tailscale.instance.detach",
        { mode: "prepare" },
        10
      )
      const cancelledReverseRequest = await inbox.next()
      expect(cancelledReverseRequest.type).toBe("request")
      const reverseCancel = await inbox.next()
      expect(reverseCancel.type).toBe("cancel")
      if (
        cancelledReverseRequest.type === "request" &&
        reverseCancel.type === "cancel"
      ) {
        expect(reverseCancel.replyTo).toBe(cancelledReverseRequest.id)
        socket.send(
          JSON.stringify({
            code: "request_cancelled",
            id: randomBytes(12).toString("hex"),
            message: "DNS prepare was rolled back",
            replyTo: cancelledReverseRequest.id,
            retryable: false,
            type: "error",
            v: 1,
          })
        )
      }
      await expect(cancelledReverseResult).resolves.toEqual([])

      blockClientLookup = true
      const request = {
        deadline: Date.now() + 5_000,
        id: randomBytes(12).toString("hex"),
        operation: "relay.snapshot",
        payload: {},
        type: "request",
        v: 1,
      }
      socket.send(JSON.stringify(request))
      socket.send(JSON.stringify(request))
      const duplicate = await inbox.next()
      expect(duplicate.type).toBe("error")
      if (duplicate.type === "error") {
        expect(duplicate.code).toBe("duplicate_request")
      }
      await expect.poll(() => releaseClientLookup).toBeDefined()
      releaseClientLookup?.()
      const response = await inbox.next()
      expect(response.type).toBe("response")
      if (response.type === "response") {
        expect(response.payload).toEqual({ ok: true })
      }
      blockClientLookup = false

      socket.send(
        JSON.stringify({
          deadline: 1,
          id: randomBytes(12).toString("hex"),
          operation: "relay.snapshot",
          payload: {},
          timeoutMs: 5_000,
          type: "request",
          v: 1,
        })
      )
      expect((await inbox.next()).type).toBe("response")

      socket.send(
        JSON.stringify({
          deadline: Date.now() + 5_000,
          id: randomBytes(12).toString("hex"),
          operation: "relay.snapshot",
          payload: {},
          timeoutMs: 0,
          type: "request",
          v: 1,
        })
      )
      const invalidTimeout = await inbox.next()
      expect(invalidTimeout.type).toBe("error")
      if (invalidTimeout.type === "error") {
        expect(invalidTimeout.code).toBe("invalid_timeout")
      }

      socket.send(
        JSON.stringify({
          deadline: Date.now() + 5_000,
          id: randomBytes(12).toString("hex"),
          operation: "relay.snapshot",
          payload: "wait-for-timeout",
          timeoutMs: 10,
          type: "request",
          v: 1,
        })
      )
      const timedOut = await inbox.next()
      expect(timedOut.type).toBe("error")
      if (timedOut.type === "error") {
        expect(timedOut.code).toBe("request_cancelled")
      }

      socket.send(
        JSON.stringify({
          deadline: Date.now() + 5_000,
          id: randomBytes(12).toString("hex"),
          operation: "relay.snapshot",
          payload: "finish-at-timeout",
          timeoutMs: 10,
          type: "request",
          v: 1,
        })
      )
      const completedAtTimeout = await inbox.next()
      expect(completedAtTimeout.type).toBe("response")
      if (completedAtTimeout.type === "response") {
        expect(completedAtTimeout.payload).toEqual({ ok: true })
      }

      socket.send(
        JSON.stringify({
          deadline: Date.now() + 5_000,
          id: randomBytes(12).toString("hex"),
          operation: "relay.networking.write",
          payload: {},
          type: "request",
          v: 1,
        })
      )
      const relayNetworking = await inbox.next()
      expect(relayNetworking.type).toBe("error")
      if (relayNetworking.type === "error") {
        expect(relayNetworking.code).toBe("forbidden")
      }

      expect(audits).toHaveLength(0)

      socket.send(
        JSON.stringify({
          deadline: Date.now() + 120_000,
          id: randomBytes(12).toString("hex"),
          operation: "instance.network.routes.write",
          payload: { instanceId: "a".repeat(40), routes: [] },
          subject: "user-123",
          type: "request",
          v: 1,
        })
      )
      const routeMutation = await inbox.next()
      expect(routeMutation.type).toBe("response")
      await expect
        .poll(() => audits.at(-1)?.details)
        .toEqual({
          instanceId: "a".repeat(40),
          operation: "instance.network.routes.write",
          permission: "instance.network.write",
          subject: "user-123",
        })
      pushSnapshot?.({ instances: [{ id: "updated" }], node: {} })
      const pushed = await inbox.next()
      expect(pushed.type).toBe("event")
      if (pushed.type === "event") {
        expect(pushed.seq).toBe(2)
        expect(pushed.payload).toEqual({
          instances: [{ id: "updated" }],
          node: {},
        })
      }
    } finally {
      socket.close()
      await once(socket, "close")
      await control.close()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it("keeps independent Hearth sessions alive when one client is revoked", async () => {
    const relayKeys = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    })
    const clients = ["Hearth A", "Hearth B"].map((name) => {
      const keys = generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      })
      return {
        keys,
        record: {
          actions: ["relay.read"],
          createdAt: Date.now(),
          id: fingerprint(keys.publicKey),
          invitationId: "test-invitation",
          lastAddress: null,
          lastSeenAt: null,
          name,
          origins: ["https://hearth.test"],
          publicKey: keys.publicKey,
          role: "full_access",
          sourceCidrs: [],
        } satisfies RelayClientRecord,
      }
    })
    const state = RelayStateStore.of({
      appendAudit: () => Effect.void,
      cancelBackupTask: () => Effect.succeed(false),
      createInvitation: () => Effect.void,
      findActiveInvitation: () => Effect.succeed(null),
      findClientById: (clientId) =>
        Effect.succeed(
          clients.find(({ record }) => record.id === clientId)?.record ?? null
        ),
      findClientByPublicKey: () => Effect.succeed(null),
      findInvitationById: () => Effect.succeed(null),
      getMetadata: () => Effect.succeed(null),
      enqueueBackupTask: () => Effect.die("not implemented"),
      claimNextBackupTask: () => Effect.succeed(null),
      getBackupTask: () => Effect.succeed(null),
      listBackupTasks: () => Effect.succeed([]),
      updateBackupTaskProgress: () => Effect.succeed(false),
      updateBackupTaskOperationProgress: () => Effect.succeed(false),
      completeBackupTask: () => Effect.succeed(false),
      failBackupTask: () => Effect.succeed(false),
      requeueInterruptedBackupTasks: () => Effect.succeed(0),
      enqueueProvisioningJob: () => Effect.die("not implemented"),
      claimProvisioningJob: () => Effect.succeed(null),
      claimNextProvisioningJob: () => Effect.succeed(null),
      cancelProvisioningJob: () => Effect.succeed(false),
      failProvisioningJob: () => Effect.succeed(false),
      completeProvisioningJob: () => Effect.succeed(false),
      getProvisioningJob: () => Effect.succeed(null),
      listProvisioningJobs: () => Effect.succeed([]),
      updateProvisioningJobPlaceholder: () => Effect.succeed(false),
      requeueInterruptedProvisioningJobs: () => Effect.succeed(0),
      getPendingPrimaryPort: () => Effect.succeed(null),
      getRuntimeRecovery: () => Effect.succeed(null),
      listClients: () => Effect.succeed(clients.map(({ record }) => record)),
      listAudits: () => Effect.succeed([]),
      listInstanceNames: () => Effect.succeed([]),
      listPendingPrimaryPorts: () => Effect.succeed([]),
      listReadySessions: () => Effect.succeed([]),
      listRuntimeRecoveries: () => Effect.succeed([]),
      listInstanceRoutes: () => Effect.succeed([]),
      listInvitations: () => Effect.succeed([]),
      listWebRoutes: () => Effect.succeed([]),
      pairClient: () => Effect.void,
      revokeClient: () => Effect.succeed(false),
      revokeInvitation: () => Effect.succeed(false),
      replaceInstanceRoutes: () => Effect.void,
      deleteInstanceName: () => Effect.void,
      deletePendingPrimaryPort: () => Effect.void,
      deleteReadySession: () => Effect.void,
      deleteRuntimeRecovery: () => Effect.void,
      setInstanceName: () => Effect.void,
      setMetadata: () => Effect.void,
      setPendingPrimaryPort: () => Effect.void,
      setReadySession: () => Effect.void,
      setRuntimeRecovery: () => Effect.void,
      touchClient: () => Effect.void,
      updateClient: () => Effect.succeed(false),
    })
    const server = createServer()
    const control = attachControlSocket({
      execute: async (_request, client) => ({ clientId: client.id }),
      identity: {
        fingerprint: fingerprint(relayKeys.publicKey),
        name: "Test Relay",
        privateKeyPem: relayKeys.privateKey,
        publicKeyPem: relayKeys.publicKey,
      },
      initialSnapshot: async () => ({ instances: [], node: {} }),
      subscribeSnapshots: () => () => undefined,
      runEffect: (effect) => Effect.runPromise(effect),
      server,
      state,
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing port")

    const first = await authenticateTestSocket(
      address.port,
      clients[0].record,
      clients[0].keys.privateKey
    )
    const second = await authenticateTestSocket(
      address.port,
      clients[1].record,
      clients[1].keys.privateKey
    )

    try {
      expect(control.sessions.size).toBe(2)
      const firstClosed = once(first.socket, "close")
      control.revokeClient(clients[0].record.id)
      await firstClosed
      await expect.poll(() => control.sessions.size).toBe(1)

      second.socket.send(
        JSON.stringify({
          deadline: Date.now() + 5_000,
          id: randomBytes(12).toString("hex"),
          operation: "relay.snapshot",
          payload: {},
          type: "request",
          v: 1,
        })
      )
      const response = await second.inbox.next()
      expect(response.type).toBe("response")
      if (response.type === "response") {
        expect(response.payload).toEqual({ clientId: clients[1].record.id })
      }

      second.socket.send(
        JSON.stringify({
          deadline: Date.now() + 5_000,
          id: randomBytes(12).toString("hex"),
          operation: "instance.rename",
          payload: {
            instanceId: "a".repeat(40),
            name: "Survival",
          },
          type: "request",
          v: 1,
        })
      )
      const renamed = await second.inbox.next()
      expect(renamed.type).toBe("response")
    } finally {
      second.socket.close()
      await once(second.socket, "close")
      await control.close()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it("delivers bounded file pages and rejects oversized legacy trees without closing the socket", async () => {
    const relayKeys = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    })
    const hearthKeys = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    })
    const client: RelayClientRecord = {
      actions: ["relay.read"],
      createdAt: Date.now(),
      id: fingerprint(hearthKeys.publicKey),
      invitationId: "test-invitation",
      lastAddress: null,
      lastSeenAt: null,
      name: "Test Hearth",
      origins: ["https://hearth.test"],
      publicKey: hearthKeys.publicKey,
      role: "full_access",
      sourceCidrs: [],
    }
    const state = RelayStateStore.of({
      appendAudit: () => Effect.void,
      cancelBackupTask: () => Effect.succeed(false),
      createInvitation: () => Effect.void,
      findActiveInvitation: () => Effect.succeed(null),
      findClientById: (clientId) =>
        Effect.succeed(clientId === client.id ? client : null),
      findClientByPublicKey: () => Effect.succeed(null),
      findInvitationById: () => Effect.succeed(null),
      getMetadata: () => Effect.succeed(null),
      enqueueBackupTask: () => Effect.die("not implemented"),
      claimNextBackupTask: () => Effect.succeed(null),
      getBackupTask: () => Effect.succeed(null),
      listBackupTasks: () => Effect.succeed([]),
      updateBackupTaskProgress: () => Effect.succeed(false),
      updateBackupTaskOperationProgress: () => Effect.succeed(false),
      completeBackupTask: () => Effect.succeed(false),
      failBackupTask: () => Effect.succeed(false),
      requeueInterruptedBackupTasks: () => Effect.succeed(0),
      enqueueProvisioningJob: () => Effect.die("not implemented"),
      claimProvisioningJob: () => Effect.succeed(null),
      claimNextProvisioningJob: () => Effect.succeed(null),
      cancelProvisioningJob: () => Effect.succeed(false),
      failProvisioningJob: () => Effect.succeed(false),
      completeProvisioningJob: () => Effect.succeed(false),
      getProvisioningJob: () => Effect.succeed(null),
      listProvisioningJobs: () => Effect.succeed([]),
      updateProvisioningJobPlaceholder: () => Effect.succeed(false),
      requeueInterruptedProvisioningJobs: () => Effect.succeed(0),
      getPendingPrimaryPort: () => Effect.succeed(null),
      getRuntimeRecovery: () => Effect.succeed(null),
      listClients: () => Effect.succeed([client]),
      listAudits: () => Effect.succeed([]),
      listInstanceNames: () => Effect.succeed([]),
      listPendingPrimaryPorts: () => Effect.succeed([]),
      listReadySessions: () => Effect.succeed([]),
      listRuntimeRecoveries: () => Effect.succeed([]),
      listInstanceRoutes: () => Effect.succeed([]),
      listInvitations: () => Effect.succeed([]),
      listWebRoutes: () => Effect.succeed([]),
      pairClient: () => Effect.void,
      revokeClient: () => Effect.succeed(false),
      revokeInvitation: () => Effect.succeed(false),
      replaceInstanceRoutes: () => Effect.void,
      deleteInstanceName: () => Effect.void,
      deletePendingPrimaryPort: () => Effect.void,
      deleteReadySession: () => Effect.void,
      deleteRuntimeRecovery: () => Effect.void,
      setInstanceName: () => Effect.void,
      setMetadata: () => Effect.void,
      setPendingPrimaryPort: () => Effect.void,
      setReadySession: () => Effect.void,
      setRuntimeRecovery: () => Effect.void,
      touchClient: () => Effect.void,
      updateClient: () => Effect.succeed(false),
    })
    const server = createServer()
    const control = attachControlSocket({
      execute: async (request) =>
        request.operation === "instance.files.directory.list"
          ? directoryPageResponse(
              (request.payload as { count?: number } | null)?.count ?? 0
            )
          : treeResponse(
              (request.payload as { count?: number } | null)?.count ?? 0
            ),
      identity: {
        fingerprint: fingerprint(relayKeys.publicKey),
        name: "Test Relay",
        privateKeyPem: relayKeys.privateKey,
        publicKeyPem: relayKeys.publicKey,
      },
      initialSnapshot: async () => ({ instances: [], node: {} }),
      subscribeSnapshots: () => () => undefined,
      runEffect: (effect) => Effect.runPromise(effect),
      server,
      state,
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing port")

    const { inbox, socket } = await authenticateTestSocket(
      address.port,
      client,
      hearthKeys.privateKey
    )

    try {
      const pageRequestId = randomBytes(12).toString("hex")
      socket.send(
        JSON.stringify({
          deadline: Date.now() + 15_000,
          id: pageRequestId,
          operation: "instance.files.directory.list",
          payload: { count: 128, instanceId: "a".repeat(40), path: "" },
          type: "request",
          v: 1,
        })
      )
      const pageResponse = await inbox.next()
      expect(pageResponse.type).toBe("response")
      if (pageResponse.type === "response") {
        const payload = pageResponse.payload as { entries: Array<unknown> }
        expect(payload.entries).toHaveLength(128)
        expect(JSON.stringify(pageResponse).length).toBeLessThan(1024 * 1024)
      }

      const oversizeRequestId = randomBytes(12).toString("hex")
      socket.send(
        JSON.stringify({
          deadline: Date.now() + 15_000,
          id: oversizeRequestId,
          operation: "instance.files.list",
          payload: { count: 10_000, instanceId: "a".repeat(40) },
          type: "request",
          v: 1,
        })
      )
      const oversizeFailure = await inbox.next()
      expect(oversizeFailure.type).toBe("error")
      if (oversizeFailure.type === "error") {
        expect(oversizeFailure.code).toBe("response_too_large")
        expect(oversizeFailure.replyTo).toBe(oversizeRequestId)
        expect(oversizeFailure.message).toContain("instance.files.list")
        expect(oversizeFailure.retryable).toBe(false)
      }

      const followUpId = randomBytes(12).toString("hex")
      socket.send(
        JSON.stringify({
          deadline: Date.now() + 15_000,
          id: followUpId,
          operation: "relay.snapshot",
          payload: { count: 0 },
          type: "request",
          v: 1,
        })
      )
      const followUp = await inbox.next()
      expect(followUp.type).toBe("response")
    } finally {
      socket.close()
      await once(socket, "close")
      await control.close()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})

function treeResponse(count: number): Record<string, unknown> {
  const paths: Array<string> = []
  const sizes: Record<string, number> = {}
  const modifiedAt: Record<string, number> = {}
  for (let index = 0; index < count; index += 1) {
    const path = `world/region/folder-${index % 64}/r.${index}.mca`
    paths.push(path)
    sizes[path] = index
    modifiedAt[path] = index
  }
  return { instanceId: "instance-1", modifiedAt, paths, sizes, total: count }
}

function directoryPageResponse(count: number): Record<string, unknown> {
  return {
    cursor: null,
    directory: "",
    entries: Array.from({ length: count }, (_, index) => ({
      kind: "file",
      modifiedAt: index,
      path: `file-${index}.txt`,
      size: index,
    })),
    instanceId: "instance-1",
  }
}

async function authenticateTestSocket(
  port: number,
  client: RelayClientRecord,
  privateKey: string
) {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/v1/socket`,
    relayControlProtocol
  )
  const inbox = messageInbox(socket)
  const challenge = (await inbox.next()) as RelayAuthChallenge
  socket.send(
    JSON.stringify({
      clientId: client.id,
      signature: sign(
        null,
        Buffer.from(relayAuthResponseTranscript(challenge, client.id)),
        privateKey
      ).toString("base64url"),
      type: "auth.response",
      v: 1,
    })
  )
  expect((await inbox.next()).type).toBe("auth.ready")
  expect((await inbox.next()).type).toBe("event")
  return { inbox, socket }
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
