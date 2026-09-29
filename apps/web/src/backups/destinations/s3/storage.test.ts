import { describe, expect, it, vi } from "vite-plus/test"
import { Effect, Layer } from "effect"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"

import { Database } from "@/effect/database"
import {
  deleteBackupStorageEffect,
  listBackupStorageEffect,
  setBackupPolicyStorageEffect,
} from "@/backups/destinations/s3"
import { BackupStorageError } from "@/effect/errors"
import { deleteS3BackupPrefix } from "./client"

vi.mock("../../../../keyring.mjs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../keyring.mjs")>()
  return {
    ...actual,
    decryptWithKeyring: (encoded: string) => {
      if (encoded.includes("FAILDECRYPT")) {
        throw new Error("keyring unavailable")
      }
      return {
        needsRotation: false,
        plaintext: encoded.startsWith("enc:") ? encoded.slice(4) : encoded,
        version: 1,
      }
    },
    encryptWithKeyring: (plaintext: string) => `enc:${plaintext}`,
  }
})

vi.mock("@/lib/environment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/environment")>()
  return {
    ...actual,
    betterAuthSecrets: () => [{ version: 1, value: "x".repeat(32) }],
  }
})

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>()
  return {
    ...actual,
    deleteS3BackupPrefix: vi.fn(() => Effect.void),
  }
})

const emptyResult: ResultSetHeader = {
  affectedRows: 0,
  changedRows: 0,
  constructor: { name: "ResultSetHeader" },
  fieldCount: 0,
  info: "",
  insertId: 0,
  serverStatus: 0,
  warningStatus: 0,
}

const storageId = "11111111-1111-4111-8111-111111111111"
const repositoryPrefix =
  "team/kiln/kiln.dev/relay-one/restic/instance/instance-one/repo-one"

describe("backup storage deletion", () => {
  it("lists destinations that are still deleting", async () => {
    let listSql = ""
    await Effect.runPromise(
      listBackupStorageEffect().pipe(
        Effect.provide(
          Layer.succeed(Database)({
            execute: () => Effect.succeed(emptyResult),
            queryRows: (_operation, sql) =>
              Effect.sync(() => {
                listSql = sql
                return []
              }),
            transaction: (_operation, run) =>
              run({
                execute: () => Effect.succeed(emptyResult),
                queryRows: () => Effect.succeed([]),
              }),
          })
        )
      )
    )
    expect(listSql).toContain("FROM")
    expect(listSql).not.toContain("deleting = FALSE")
  })

  it("refuses destinations that still have cataloged backups", async () => {
    await expect(
      Effect.runPromise(
        deleteBackupStorageEffect(storageId).pipe(
          Effect.provide(
            storageDeleteDatabase({
              deleting: false,
              references: 1,
            })
          )
        )
      )
    ).rejects.toThrow("still contains cataloged backups")
    expect(vi.mocked(deleteS3BackupPrefix)).not.toHaveBeenCalled()
  })

  it("refuses destinations that still have replica artifacts", async () => {
    const queries: Array<string> = []
    await expect(
      Effect.runPromise(
        deleteBackupStorageEffect(storageId).pipe(
          Effect.provide(
            storageDeleteDatabase({
              deleting: false,
              queries,
              references: 1,
            })
          )
        )
      )
    ).rejects.toThrow("still contains cataloged backups")
    expect(
      queries.some(
        (sql) =>
          sql.includes("backup_artifact") && sql.includes("reference_count")
      )
    ).toBe(true)
    expect(vi.mocked(deleteS3BackupPrefix)).not.toHaveBeenCalled()
  })

  it("refuses destinations used by an active final server deletion", async () => {
    const queries: Array<string> = []
    await expect(
      Effect.runPromise(
        deleteBackupStorageEffect(storageId).pipe(
          Effect.provide(
            storageDeleteDatabase({
              deleting: false,
              finalDeletion: true,
              queries,
              references: 0,
            })
          )
        )
      )
    ).rejects.toThrow("being permanently deleted")
    expect(
      queries.find((sql) => sql.includes("backup_final_delete"))
    ).toContain("FOR UPDATE")
    expect(vi.mocked(deleteS3BackupPrefix)).not.toHaveBeenCalled()
  })

  it("does not mark deleting when destination credentials cannot be decrypted", async () => {
    const writes: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = []
    await expect(
      Effect.runPromise(
        deleteBackupStorageEffect(storageId).pipe(
          Effect.provide(
            storageDeleteDatabase({
              ciphertext: "enc:FAILDECRYPT",
              deleting: false,
              references: 0,
              writes,
            })
          )
        )
      )
    ).rejects.toThrow(
      "Credential operation decrypt_backup_storage_credential failed"
    )
    expect(
      writes.some((write) => write.sql.includes("SET deleting = TRUE"))
    ).toBe(false)
  })

  it("locks backup policies before storage during destination delete", async () => {
    const queries: Array<string> = []
    vi.mocked(deleteS3BackupPrefix).mockReturnValue(Effect.void)
    await Effect.runPromise(
      deleteBackupStorageEffect(storageId).pipe(
        Effect.provide(
          storageDeleteDatabase({
            deleting: true,
            queries,
            references: 0,
          })
        )
      )
    )
    const policyLock = queries.findIndex(
      (sql) => sql.includes("backup_policy") && sql.includes("FOR UPDATE")
    )
    const storageLock = queries.findIndex(
      (sql) => sql.includes("backup_storage") && sql.includes("FOR UPDATE")
    )
    expect(policyLock).toBeGreaterThanOrEqual(0)
    expect(storageLock).toBeGreaterThan(policyLock)
  })

  it("keeps deleting after a prefix purge failure", async () => {
    vi.mocked(deleteS3BackupPrefix).mockReturnValueOnce(
      Effect.fail(
        BackupStorageError.make({
          code: "s3_request_failed",
          operation: "storage.deletePrefix",
          reason: "The S3-compatible storage request failed",
        })
      )
    )
    const writes: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = []
    await expect(
      Effect.runPromise(
        deleteBackupStorageEffect(storageId).pipe(
          Effect.provide(
            storageDeleteDatabase({
              deleting: false,
              references: 0,
              writes,
            })
          )
        )
      )
    ).rejects.toThrow("S3-compatible storage request failed")
    expect(writes.some((write) => write.sql.includes("deleting = TRUE"))).toBe(
      true
    )
    expect(
      writes.some(
        (write) =>
          write.sql.includes("backup_policy") &&
          write.sql.includes("storage_id = NULL")
      )
    ).toBe(true)
    expect(writes.some((write) => write.sql.includes("last_error"))).toBe(true)
    expect(
      writes.some(
        (write) =>
          write.sql.includes("DELETE FROM") &&
          write.sql.includes("backup_storage")
      )
    ).toBe(false)
  })

  it("purges restic prefixes then removes the destination", async () => {
    vi.mocked(deleteS3BackupPrefix).mockReturnValue(Effect.void)
    const writes: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = []
    await Effect.runPromise(
      deleteBackupStorageEffect(storageId).pipe(
        Effect.provide(
          storageDeleteDatabase({
            deleting: true,
            references: 0,
            writes,
          })
        )
      )
    )
    expect(vi.mocked(deleteS3BackupPrefix)).toHaveBeenCalledWith(
      expect.objectContaining({
        accessKeyId: "AKIAEXAMPLE",
        bucket: "kiln-backups",
      }),
      repositoryPrefix
    )
    expect(
      writes.some(
        (write) =>
          write.sql.includes("DELETE FROM") &&
          write.sql.includes("backup_repository")
      )
    ).toBe(true)
    expect(
      writes.some(
        (write) =>
          write.sql.includes("DELETE FROM") &&
          write.sql.includes("backup_storage")
      )
    ).toBe(true)
  })
})

describe("backup storage policy", () => {
  it("locks the policy before rejecting a deleting destination", async () => {
    const queries: Array<string> = []
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected standalone database write"),
      queryRows: () => Effect.die("Unexpected standalone database query"),
      transaction: (_operation, run) =>
        run({
          execute: () => Effect.succeed(emptyResult),
          queryRows: <TRow extends RowDataPacket>(sql: string) =>
            Effect.sync(() => {
              queries.push(sql)
              return (sql.includes("backup_storage")
                ? [{ deleting: 1, enabled: 1 }]
                : []) as unknown as ReadonlyArray<TRow>
            }),
        }),
    })

    await expect(
      Effect.runPromise(
        setBackupPolicyStorageEffect({
          relayId: "relay-one",
          storageId,
          targetId: "instance-one",
          targetKind: "instance",
        }).pipe(Effect.provide(databaseLayer))
      )
    ).rejects.toThrow("unavailable")
    expect(queries[0]).toContain("backup_policy")
    expect(queries[0]).toContain("FOR UPDATE")
    expect(queries[1]).toContain("backup_storage")
    expect(queries[1]).toContain("FOR UPDATE")
  })
})

function storageDeleteDatabase(input: {
  ciphertext?: string
  deleting: boolean
  finalDeletion?: boolean
  queries?: Array<string>
  references: number
  writes?: Array<{ sql: string; values?: ReadonlyArray<unknown> }>
}) {
  const writes = input.writes ?? []
  const queries = input.queries ?? []
  return Layer.succeed(Database)({
    execute: (_operation, sql, values) =>
      Effect.sync(() => {
        writes.push({ sql, values })
        return emptyResult
      }),
    queryRows: <TRow extends RowDataPacket>(operation: string) =>
      Effect.sync(() => {
        if (operation === "backup_storage_delete_repositories") {
          return [
            { id: "repo-one", object_prefix: repositoryPrefix },
          ] as unknown as ReadonlyArray<TRow>
        }
        throw new Error(`Unexpected query ${operation}`)
      }),
    transaction: (_operation, run) =>
      run({
        execute: (sql, values) =>
          Effect.sync(() => {
            writes.push({ sql, values })
            return emptyResult
          }),
        queryRows: <TRow extends RowDataPacket>(sql: string) =>
          Effect.sync(() => {
            queries.push(sql)
            if (sql.includes("backup_final_delete")) {
              return (input.finalDeletion
                ? [{ backup_id: "final-backup" }]
                : []) as unknown as ReadonlyArray<TRow>
            }
            if (sql.includes("reference_count")) {
              return [
                { reference_count: input.references },
              ] as unknown as ReadonlyArray<TRow>
            }
            if (sql.includes("backup_policy")) {
              return [] as unknown as ReadonlyArray<TRow>
            }
            return [
              storageCredentialRow(input.deleting, input.ciphertext),
            ] as unknown as ReadonlyArray<TRow>
          }),
      }),
  })
}

function storageIdentityRow(deleting: boolean) {
  return {
    bucket: "kiln-backups",
    deleting: deleting ? 1 : 0,
    endpoint: "https://s3.example.com",
    force_path_style: 1,
    id: storageId,
    object_prefix: "team",
    owner_user_id: null,
    region: "us-east-1",
  }
}

function storageCredentialRow(deleting: boolean, ciphertext?: string) {
  return {
    ...storageIdentityRow(deleting),
    access_key_id_ciphertext: ciphertext ?? "enc:AKIAEXAMPLE",
    allow_private_network: 1,
    created_at: Date.parse("2026-01-01T00:00:00.000Z"),
    enabled: 1,
    last_error: null,
    last_verified_at: null,
    name: "minio",
    secret_access_key_ciphertext: ciphertext ?? "enc:s3-secret",
  }
}
