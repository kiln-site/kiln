import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vite-plus/test"
import {
  cliBrickReferenceSchema,
  cliBackupDownloadResponseSchema,
  cliCreateBackupRequestSchema,
  cliPowerResponseSchema,
  cliRemoteFileUploadRequestSchema,
  cliServerInfoResponseSchema,
  relayInstanceSchema,
} from "@workspace/contracts"

vi.hoisted(() => {
  process.env.DB_HOST ??= "127.0.0.1"
  process.env.DB_NAME ??= "test"
  process.env.DB_PASSWORD ??= "test"
  process.env.DB_USERNAME ??= "test"
})

import {
  canCreateCliServer,
  cliActivityResponse,
  cliDatabaseSupportsLogicalBackups,
  cliPowerResponse,
  cliSftpConnectionResponse,
  cliSftpUnavailableMessage,
  cliConsoleRelayFailure,
  collectAvailableCliRelaySnapshotsEffect,
  relayRemoteUploadInput,
  safeCliBrickSource,
} from "@/effect/cli-api"
import { CliAccessError, RelayUnavailableError } from "@/effect/errors"

describe("CLI console failures", () => {
  it("keeps the Relay cause and correlation ID concise", () => {
    const requestId = "3df56ba5-b2c1-45ee-bab7-386fbb9223c7"
    const error = cliConsoleRelayFailure(
      RelayUnavailableError.make({
        code: "operation_failed",
        message: "Survival is not running",
        requestId,
        retryable: false,
      })
    )

    assert.strictEqual(error.code, "relay_operation_failed")
    assert.strictEqual(
      error.message,
      "Relay could not send the console command."
    )
    assert.strictEqual(error.detail, "Survival is not running")
    assert.strictEqual(error.requestId, requestId)
    assert.isFalse(error.retryable)
  })
})

describe("CLI server listing", () => {
  it.effect(
    "returns healthy Relay snapshots when another Relay is unavailable",
    () =>
      Effect.gen(function* () {
        const snapshots = yield* collectAvailableCliRelaySnapshotsEffect([
          {
            relayId: "healthy-relay",
            snapshot: Effect.succeed({ id: "healthy-relay" }),
          },
          {
            relayId: "unhealthy-relay",
            snapshot: Effect.fail(
              CliAccessError.make({
                code: "relay_unavailable",
                message: "Relay did not respond.",
                retryable: true,
              })
            ),
          },
        ])

        assert.deepEqual(snapshots, [{ id: "healthy-relay" }])
      })
  )
})

describe("CLI server creation", () => {
  const user = {
    email: "creator@example.com",
    emailVerified: true,
    id: "creator",
    isDevelopmentBypass: false,
    name: "Creator",
    role: "relay_creator" as const,
    twoFactorEnabled: false,
  }

  it("limits Relay creators to Relays they paired", () => {
    assert.isTrue(canCreateCliServer(user, { createdBy: user.id }))
    assert.isFalse(canCreateCliServer(user, { createdBy: "another-user" }))
    assert.isTrue(
      canCreateCliServer(
        { ...user, id: "admin", role: "admin" },
        { createdBy: "another-user" }
      )
    )
  })
})

describe("CLI SFTP connection", () => {
  it("omits Relay-only SFTP fields from the CLI response", () => {
    const response = cliSftpConnectionResponse(
      {
        developmentAuthentication: false,
        host: "relay.example.com",
        hostKeyFingerprint: "SHA256:relay-fingerprint",
        port: 2022,
        publication: "published",
      },
      "bedf06fe944ceb0a573a14da5a38703068a00e5a",
      "operator@example.com"
    )

    assert.deepEqual(response, {
      host: "relay.example.com",
      hostKeyFingerprint: "SHA256:relay-fingerprint",
      port: 2022,
      root: "/bedf06fe944ceb0a573a14da5a38703068a00e5a",
      username: "operator@example.com",
    })
  })

  it("explains a proven missing Docker publication concisely", () => {
    assert.strictEqual(
      cliSftpUnavailableMessage({
        developmentAuthentication: false,
        host: "relay.example.com",
        hostKeyFingerprint: "SHA256:relay-fingerprint",
        port: 2022,
        publication: "not_published",
      }),
      "Relay SFTP port 2022/tcp is not published by Docker. Publish the port and retry."
    )
  })

  it("keeps a loopback-only publication connectable for a local CLI", () => {
    assert.isNull(
      cliSftpUnavailableMessage({
        developmentAuthentication: false,
        host: "127.0.0.1",
        hostKeyFingerprint: "SHA256:relay-fingerprint",
        port: 32_022,
        publication: "loopback_only",
      })
    )
    const response = cliSftpConnectionResponse(
      {
        developmentAuthentication: false,
        host: "127.0.0.1",
        hostKeyFingerprint: "SHA256:relay-fingerprint",
        port: 32_022,
        publication: "loopback_only",
      },
      "bedf06fe944ceb0a573a14da5a38703068a00e5a",
      "operator@example.com"
    )
    assert.deepEqual(response, {
      host: "127.0.0.1",
      hostKeyFingerprint: "SHA256:relay-fingerprint",
      port: 32_022,
      root: "/bedf06fe944ceb0a573a14da5a38703068a00e5a",
      username: "operator@example.com",
    })
  })

  it("keeps standalone and rootless Relay SFTP usable when publication is unknown", () => {
    assert.isNull(
      cliSftpUnavailableMessage({
        developmentAuthentication: false,
        host: "relay.example.com",
        hostKeyFingerprint: "SHA256:relay-fingerprint",
        port: 2022,
        publication: "unknown",
      })
    )
  })
})

describe("CLI response and URL boundaries", () => {
  it("serializes power actions through the shared CLI response contract", () => {
    const relayInstance = relayInstanceSchema.parse({
      connectAddress: "play.example.com:25565",
      containerId: "container-id",
      desiredState: "running",
      directory: "/srv/kiln/instances/survival",
      game: "Minecraft",
      id: "a".repeat(40),
      implementation: "paper",
      javaVersion: "21",
      name: "Survival",
      observedState: "starting",
      service: "kiln-survival",
      shortId: "a".repeat(8),
      status: "starting",
      version: "1.21.11",
    })
    const webResponse = cliPowerResponse("start", relayInstance, "r".repeat(43))
    const serializedResponse: unknown = JSON.parse(JSON.stringify(webResponse))
    const cliResponse = cliPowerResponseSchema.parse(serializedResponse)

    assert.deepEqual(cliResponse, {
      action: "start",
      instance: {
        desiredState: "running",
        id: "a".repeat(40),
        name: "Survival",
        observedState: "starting",
      },
      relayId: "r".repeat(43),
    })
  })

  it("only offers databases with logical backup support", () => {
    assert.isTrue(cliDatabaseSupportsLogicalBackups({ engine: "postgres" }))
    assert.isFalse(cliDatabaseSupportsLogicalBackups({ engine: "redis" }))
    assert.isFalse(cliDatabaseSupportsLogicalBackups({ engine: "valkey" }))
  })

  it("removes Hearth-only fields before returning activity", () => {
    const response = cliActivityResponse(
      [
        {
          actor: { email: null, id: "system", name: "Kiln system" },
          id: `${"r".repeat(43)}:audit-one`,
          label: "Created a server",
          occurredAt: 1,
          permission: "instance.create",
          rawEvent: "control.mutation",
          relay: { id: "r".repeat(43), name: "Relay" },
          server: null,
          source: "cli",
          type: "server",
        },
      ],
      1
    )

    assert.notProperty(response.entries[0] ?? {}, "rawEvent")
  })

  it("removes Hearth routing fields from Relay upload payloads", () => {
    const input = relayRemoteUploadInput({
      instanceId: "a".repeat(40),
      path: "plugins/example.jar",
      relayId: "r".repeat(43),
      url: "https://example.com/example.jar",
    })

    assert.deepEqual(input, {
      instanceId: "a".repeat(40),
      path: "plugins/example.jar",
      url: "https://example.com/example.jar",
    })
  })

  it("rejects insecure URLs and paths that escape the server root", () => {
    const target = {
      instanceId: "a".repeat(40),
      relayId: "r".repeat(43),
    }
    assert.isFalse(
      cliRemoteFileUploadRequestSchema.safeParse({
        ...target,
        path: "plugins/example.jar",
        url: "http://example.com/example.jar",
      }).success
    )
    assert.isFalse(
      cliRemoteFileUploadRequestSchema.safeParse({
        ...target,
        path: "../example.jar",
        url: "https://example.com/example.jar",
      }).success
    )
    assert.isFalse(
      cliRemoteFileUploadRequestSchema.safeParse({
        ...target,
        path: "plugins/example.jar",
        url: "https://user:password@example.com/example.jar",
      }).success
    )
    assert.isFalse(
      cliBrickReferenceSchema.safeParse(
        "https://user:password@example.com/paper.yml"
      ).success
    )
  })

  it("keeps backup targets typed and signed downloads HTTPS-only", () => {
    assert.isTrue(
      cliCreateBackupRequestSchema.safeParse({
        name: "Platform backup",
        relayId: "r".repeat(43),
        targetKind: "platform",
      }).success
    )
    assert.isFalse(
      cliCreateBackupRequestSchema.safeParse({
        name: "Server backup",
        relayId: "r".repeat(43),
        targetKind: "instance",
      }).success
    )
    assert.isFalse(
      cliBackupDownloadResponseSchema.safeParse({
        expiresAt: "2026-08-10T00:00:00.000Z",
        filename: "backup.zip",
        status: "ready",
        url: "http://relay.example.com/backup.zip",
      }).success
    )
  })

  it("keeps server variables and internal runtime fields out of metadata", () => {
    const response = {
      relay: { id: "r".repeat(43), name: "Relay" },
      server: {
        brickId: "paper",
        brickSource: "https://example.com/paper.yml",
        connectAddress: "play.example.com",
        desiredState: "running",
        diskLimitBytes: 1024,
        game: "Minecraft",
        id: "a".repeat(40),
        implementation: "paper",
        javaVersion: "21",
        memoryLimitBytes: 1024,
        name: "Survival",
        observedState: "running",
        stateReason: {
          code: "automatic_recovery",
          exitCode: 137,
          phase: "restarting",
          reason: "process_exit",
        },
        publicAddress: "play.example.com:25565",
        lifecycle: [],
        resources: null,
        shortId: "a".repeat(8),
        version: "1.21.11",
      },
    }
    const serialized = cliServerInfoResponseSchema.parse(response)
    assert.deepStrictEqual(serialized.server.stateReason, {
      code: "automatic_recovery",
      exitCode: 137,
      phase: "restarting",
      reason: "process_exit",
    })
    assert.isFalse(
      cliServerInfoResponseSchema.safeParse({
        ...response,
        server: {
          ...response.server,
          directory: "/data/private",
          variables: { secret: "value" },
        },
      }).success
    )
  })

  it("removes credentials and query secrets from Brick metadata", () => {
    assert.strictEqual(
      safeCliBrickSource(
        "https://user:password@example.com/paper.yml?token=secret#fragment"
      ),
      "https://example.com/paper.yml"
    )
  })
})
