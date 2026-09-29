import { describe, expect, it, vi } from "vite-plus/test"
import { Effect, Layer } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import { Database } from "@/effect/database"
import { prepareBackupTaskEffect } from "@/lib/backup-task-prepare"

vi.mock("../../keyring.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../keyring.mjs")>()
  return {
    ...actual,
    decryptWithKeyring: (encoded: string) => ({
      needsRotation: false,
      plaintext: encoded.startsWith("enc:") ? encoded.slice(4) : encoded,
      version: 1,
    }),
    encryptWithKeyring: (plaintext: string) => `enc:${plaintext}`,
  }
})

vi.mock("@/lib/environment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/environment")>()
  return {
    ...actual,
    betterAuthSecrets: () => [{ version: 1, value: "x".repeat(32) }],
    kilnInstallationId: () => "kiln.dev",
  }
})

const backupId = "11111111-1111-4111-8111-111111111111"
const storageId = "22222222-2222-4222-8222-222222222222"
const artifactId = "33333333-3333-4333-8333-333333333333"
const taskId = "44444444-4444-4444-8444-444444444444"
const createTaskId = "55555555-5555-4555-8555-555555555555"
const storedPrefix =
  "team/kiln/kiln.dev/relay-one/restic/instance/instance-one/repo-one"

describe("restic backup dispatch", () => {
  it("attaches the stored repository prefix and destination keys", async () => {
    const prepared = await Effect.runPromise(
      prepareBackupTaskEffect({
        artifactKind: "restic_snapshot",
        artifacts: [{ artifactId, objectKey: null, storageId }],
        backupId,
        exclude: [],
        kind: "create",
        maxBytes: null,
        mode: "incremental",
        reason: "manual",
        target: { id: "instance-one", kind: "instance" },
        taskId,
      }).pipe(Effect.provide(resticDispatchDatabase()))
    )

    expect(prepared.kind).toBe("create")
    if (prepared.kind !== "create" || prepared.destination.kind !== "restic") {
      throw new Error("expected restic create dispatch")
    }
    expect(prepared.destination.repository).toEqual({
      accessKeyId: "AKIAEXAMPLE",
      allowPrivateNetwork: true,
      bucket: "kiln-backups",
      endpoint: "https://s3.example.com",
      forcePathStyle: true,
      kind: "s3",
      region: "us-east-1",
      repositoryPrefix: storedPrefix,
      secretAccessKey: "s3-secret",
    })
    expect(prepared.destination.repositoryPassword).toBe("repo-password")
  })

  it("keeps tag-based restic deletes on the restic path", async () => {
    const prepared = await Effect.runPromise(
      prepareBackupTaskEffect({
        artifacts: [{ artifactId, objectKey: null, storageId }],
        backupId,
        createTaskId,
        kind: "delete",
        target: { id: "instance-one", kind: "instance" },
        taskId,
      }).pipe(Effect.provide(resticDispatchDatabase()))
    )

    expect(prepared.kind).toBe("delete")
    if (prepared.kind !== "delete" || prepared.destination.kind !== "restic") {
      throw new Error("expected restic delete dispatch")
    }
    expect(prepared.destination.createTaskId).toBe(createTaskId)
    expect(
      "snapshotId" in prepared.destination
        ? prepared.destination.snapshotId
        : undefined
    ).toBeUndefined()
    expect(prepared.destination.repository).toMatchObject({
      kind: "s3",
      repositoryPrefix: storedPrefix,
    })
  })

  it("refuses incremental create dispatch to a disabled destination", async () => {
    await expect(
      Effect.runPromise(
        prepareBackupTaskEffect({
          artifactKind: "restic_snapshot",
          artifacts: [{ artifactId, objectKey: null, storageId }],
          backupId,
          exclude: [],
          kind: "create",
          maxBytes: null,
          mode: "incremental",
          reason: "manual",
          target: { id: "instance-one", kind: "instance" },
          taskId,
        }).pipe(
          Effect.provide(resticDispatchDatabase({ enabled: false }))
        )
      )
    ).rejects.toThrow("backup destination is unavailable")
  })
})

function resticDispatchDatabase(
  overrides: { enabled?: boolean } = {}
) {
  return Layer.succeed(Database)({
    execute: () => Effect.die("Unexpected database write"),
    queryRows: <TRow extends RowDataPacket>(operation: string) =>
      Effect.sync(() => {
        if (operation === "backup_repository_password") {
          return [
            {
              object_prefix: storedPrefix,
              password_ciphertext: "enc:repo-password",
              storage_id: storageId,
            },
          ] as unknown as ReadonlyArray<TRow>
        }
        if (operation === "backup_storage_credential") {
          return [
            storageCredentialRow(overrides.enabled ?? true),
          ] as unknown as ReadonlyArray<TRow>
        }
        throw new Error(`Unexpected query ${operation}`)
      }),
    transaction: () => Effect.die("Unexpected transaction"),
  })
}

function storageCredentialRow(enabled = true) {
  return {
    access_key_id_ciphertext: "enc:AKIAEXAMPLE",
    allow_private_network: 1,
    bucket: "kiln-backups",
    created_at: Date.parse("2026-01-01T00:00:00.000Z"),
    deleting: 0,
    enabled: enabled ? 1 : 0,
    endpoint: "https://s3.example.com",
    force_path_style: 1,
    id: storageId,
    last_error: null,
    last_verified_at: null,
    name: "minio",
    object_prefix: "team",
    owner_user_id: null,
    region: "us-east-1",
    secret_access_key_ciphertext: "enc:s3-secret",
  }
}
