import { describe, expect, it, vi } from "vite-plus/test"
import { Effect, Layer } from "effect"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"
import type { RelayBackupTask } from "@workspace/contracts"

import { Database } from "@/effect/database"
import { BackupLimitError, BackupStorageError } from "@/effect/errors"
import {
  backupReservation,
  canReuseBackupExport,
  clampBackupExportTtlMs,
  effectiveBackupLimit,
  getBackupPolicyEffect,
  purgeInstanceBackupRepositoriesEffect,
  renameBackupEffect,
  reserveBackupCopyEffect,
  reserveInstanceBackupEffect,
  reconcileBackupTaskEffect,
  shouldApplyRelayBackupTaskSnapshot,
  updateBackupExcludesEffect,
  updateBackupLimitsEffect,
} from "@/effect/backups"
import { deleteS3BackupPrefix } from "@/backups/destinations/s3"

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

vi.mock("@/backups/destinations/s3", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/backups/destinations/s3")>()
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

describe("backup limits", () => {
  it("uses the stricter user or platform limit", () => {
    expect(effectiveBackupLimit(null, null)).toBeNull()
    expect(effectiveBackupLimit(10, null)).toBe(10)
    expect(effectiveBackupLimit(null, 8)).toBe(8)
    expect(effectiveBackupLimit(10, 8)).toBe(8)
  })

  it("clamps incremental export TTLs to the signed-URL bounds", () => {
    expect(clampBackupExportTtlMs(1_000)).toBe(60_000)
    expect(clampBackupExportTtlMs(15 * 60_000)).toBe(15 * 60_000)
    expect(clampBackupExportTtlMs(30 * 24 * 60 * 60 * 1_000)).toBe(
      7 * 24 * 60 * 60 * 1_000
    )
  })

  it("reuses an unexpired export while polling even if remaining is under the requested TTL", () => {
    expect(
      canReuseBackupExport({
        remainingMs: 15 * 60 * 60 * 1_000 - 1_500,
        requestedTtlMs: 15 * 60 * 60 * 1_000,
        requireFullTtl: false,
      })
    ).toBe(true)
    expect(
      canReuseBackupExport({
        remainingMs: 15 * 60 * 60 * 1_000 - 1_500,
        requestedTtlMs: 15 * 60 * 60 * 1_000,
        requireFullTtl: true,
      })
    ).toBe(true)
    expect(
      canReuseBackupExport({
        remainingMs: 60_000,
        requestedTtlMs: 15 * 60 * 60 * 1_000,
        requireFullTtl: true,
      })
    ).toBe(true)
    expect(
      canReuseBackupExport({
        remainingMs: 59_000,
        requestedTtlMs: 15 * 60 * 60 * 1_000,
        requireFullTtl: true,
      })
    ).toBe(false)
    expect(
      canReuseBackupExport({
        remainingMs: 0,
        requestedTtlMs: 60_000,
        requireFullTtl: false,
      })
    ).toBe(false)
  })

  it("reserves remaining bytes and rejects exhausted limits", () => {
    expect(
      backupReservation({
        quantityLimit: 5,
        quantityUsed: 2,
        requestedMaxBytes: 800,
        sizeLimit: 1_000,
        sizeUsed: 400,
      })
    ).toEqual({ maxBytes: 600 })
    expect(() =>
      backupReservation({
        quantityLimit: 2,
        quantityUsed: 2,
        requestedMaxBytes: null,
        sizeLimit: null,
        sizeUsed: 0,
      })
    ).toThrow(BackupLimitError)
    expect(() =>
      backupReservation({
        quantityLimit: null,
        quantityUsed: 0,
        requestedMaxBytes: null,
        sizeLimit: 1_000,
        sizeUsed: 1_000,
      })
    ).toThrow(BackupLimitError)
  })

  it("keeps deleting backups in quantity and size usage", async () => {
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
              const rows = sql.includes("backup_policy")
                ? [
                    {
                      admin_quantity_limit: null,
                      admin_size_limit_bytes: null,
                      exclude_patterns: [],
                      quantity_limit: 2,
                      size_limit_bytes: 2_048,
                      storage_id: null,
                    },
                  ]
                : [{ quantity_used: 1, size_used: 1_024 }]
              return rows as unknown as ReadonlyArray<TRow>
            }),
        }),
    })

    await Effect.runPromise(
      reserveInstanceBackupEffect({
        backupId: "backup-one",
        createdBy: "user-one",
        mode: "full",
        name: "Backup one",
        relayId: "relay-one",
        requestedMaxBytes: null,
        targetId: "instance-one",
        taskId: "task-one",
      }).pipe(Effect.provide(databaseLayer))
    )

    const usageQuery = queries.find((sql) => sql.includes("SELECT COUNT(*)"))
    expect(usageQuery).toContain(
      "backup.status IN ('queued', 'running', 'available', 'deleting')"
    )
    expect(usageQuery).toContain("backup.status IN ('available', 'deleting')")
  })

  it("bypasses user limits for final-deletion backups but keeps admin caps", async () => {
    let reservedBytes: unknown
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected standalone database write"),
      queryRows: () => Effect.die("Unexpected standalone database query"),
      transaction: (_operation, run) =>
        run({
          execute: (sql, values) =>
            Effect.sync(() => {
              if (sql.includes("INSERT INTO") && sql.includes("backup_task")) {
                reservedBytes = values?.[2]
              }
              return emptyResult
            }),
          queryRows: <TRow extends RowDataPacket>(sql: string) =>
            Effect.sync(() => {
              const rows = sql.includes("backup_policy")
                ? [
                    {
                      admin_quantity_limit: 2,
                      admin_size_limit_bytes: 2_048,
                      exclude_patterns: [],
                      quantity_limit: 0,
                      size_limit_bytes: 0,
                      storage_id: null,
                    },
                  ]
                : sql.includes("task.task_kind = 'restore'")
                  ? []
                  : [{ quantity_used: 1, size_used: 1_024 }]
              return rows as unknown as ReadonlyArray<TRow>
            }),
        }),
    })

    const reservation = await Effect.runPromise(
      reserveInstanceBackupEffect({
        backupId: "final-backup",
        createdBy: "user-one",
        name: "Final backup",
        reason: "final_delete",
        relayId: "relay-one",
        requestedMaxBytes: null,
        targetId: "instance-one",
        taskId: "final-task",
      }).pipe(Effect.provide(databaseLayer))
    )

    expect(reservation.maxBytes).toBe(1_024)
    expect(reservedBytes).toBe(1_024)
  })

  it("rejects incremental backups that target more than one destination", async () => {
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected standalone database write"),
      queryRows: () => Effect.die("Unexpected standalone database query"),
      transaction: (_operation, run) =>
        run({
          execute: () => Effect.succeed(emptyResult),
          queryRows: <TRow extends RowDataPacket>(sql: string) =>
            Effect.sync(() => {
              const rows = sql.includes("backup_policy")
                ? [
                    {
                      admin_quantity_limit: null,
                      admin_size_limit_bytes: null,
                      exclude_patterns: [],
                      quantity_limit: 2,
                      size_limit_bytes: 2_048,
                      storage_id: null,
                    },
                  ]
                : []
              return rows as unknown as ReadonlyArray<TRow>
            }),
        }),
    })

    await expect(
      Effect.runPromise(
        reserveInstanceBackupEffect({
          backupId: "backup-one",
          createdBy: "user-one",
          mode: "incremental",
          name: "Backup one",
          relayId: "relay-one",
          requestedMaxBytes: null,
          storageIds: [null, "11111111-1111-4111-8111-111111111111"],
          targetId: "instance-one",
          taskId: "task-one",
        }).pipe(Effect.provide(databaseLayer))
      )
    ).rejects.toThrow("exactly one destination")
  })

  it("rejects incremental S3 destinations with unsafe bucket, region, or prefix", async () => {
    await expect(
      Effect.runPromise(
        reserveInstanceBackupEffect({
          backupId: "backup-one",
          createdBy: "user-one",
          mode: "incremental",
          name: "Backup one",
          relayId: "relay-one",
          requestedMaxBytes: null,
          storageIds: ["11111111-1111-4111-8111-111111111111"],
          targetId: "instance-one",
          taskId: "task-one",
        }).pipe(
          Effect.provide(
            incrementalStorageLayer({
              bucket: "Not_A_Bucket",
              object_prefix: "team",
              region: "us-east-1",
            })
          )
        )
      )
    ).rejects.toThrow(
      "Bucket names must be 3 to 63 characters, start and end with a letter or number"
    )
    await expect(
      Effect.runPromise(
        reserveInstanceBackupEffect({
          backupId: "backup-two",
          createdBy: "user-one",
          mode: "incremental",
          name: "Backup two",
          relayId: "relay-one",
          requestedMaxBytes: null,
          storageIds: ["11111111-1111-4111-8111-111111111111"],
          targetId: "instance-one",
          taskId: "task-two",
        }).pipe(
          Effect.provide(
            incrementalStorageLayer({
              bucket: "kiln-backups",
              object_prefix: "team",
              region: "US_EAST_1",
            })
          )
        )
      )
    ).rejects.toThrow(
      "S3 regions must contain only lowercase letters, digits, and hyphens"
    )
    await expect(
      Effect.runPromise(
        reserveInstanceBackupEffect({
          backupId: "backup-three",
          createdBy: "user-one",
          mode: "incremental",
          name: "Backup three",
          relayId: "relay-one",
          requestedMaxBytes: null,
          storageIds: ["11111111-1111-4111-8111-111111111111"],
          targetId: "instance-one",
          taskId: "task-three",
        }).pipe(
          Effect.provide(
            incrementalStorageLayer({
              bucket: "kiln-backups",
              object_prefix: "team/foo bar",
              region: "us-east-1",
            })
          )
        )
      )
    ).rejects.toThrow(
      "The object prefix can contain only letters, numbers, periods, underscores, slashes, and hyphens"
    )
  })

  it("reserves a single incremental S3 destination with a stored restic prefix", async () => {
    const queries: Array<string> = []
    const writes: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = []
    const storageId = "11111111-1111-4111-8111-111111111111"
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected standalone database write"),
      queryRows: () => Effect.die("Unexpected standalone database query"),
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
              if (sql.includes("backup_policy")) {
                return [
                  {
                    admin_quantity_limit: null,
                    admin_size_limit_bytes: null,
                    exclude_patterns: [],
                    quantity_limit: 2,
                    size_limit_bytes: 2_048,
                    storage_id: storageId,
                  },
                ] as unknown as ReadonlyArray<TRow>
              }
              if (sql.includes("backup_storage")) {
                return [
                  {
                    bucket: "Kiln-Backups",
                    deleting: 0,
                    enabled: 1,
                    endpoint: "https://s3.example.com",
                    id: storageId,
                    object_prefix: "team",
                    owner_user_id: null,
                    region: "us-east-1",
                  },
                ] as unknown as ReadonlyArray<TRow>
              }
              if (sql.includes("backup_repository"))
                return [] as unknown as ReadonlyArray<TRow>
              return [
                { quantity_used: 0, size_used: 0 },
              ] as unknown as ReadonlyArray<TRow>
            }),
        }),
    })

    await Effect.runPromise(
      reserveInstanceBackupEffect({
        backupId: "backup-one",
        createdBy: "user-one",
        mode: "incremental",
        name: "Backup one",
        relayId: "relay-one",
        requestedMaxBytes: null,
        storageIds: [storageId],
        targetId: "instance-one",
        taskId: "task-one",
      }).pipe(Effect.provide(databaseLayer))
    )

    const storageLock = queries.find((sql) => sql.includes("backup_storage"))
    expect(storageLock).toContain("FOR UPDATE")
    expect(storageLock).toContain("ORDER BY id")
    const repositoryInsert = writes.find((write) =>
      write.sql.includes("backup_repository")
    )
    expect(repositoryInsert?.values?.[4]).toBe(storageId)
    expect(repositoryInsert?.values?.[5]).toBe(storageId)
    expect(repositoryInsert?.values?.[6]).toBe(
      `team/kiln/kiln.dev/relay-one/restic/instance/instance-one/${repositoryInsert?.values?.[0]}`
    )
    const backupInsert = writes.find(
      (write) =>
        write.sql.includes("INSERT INTO") && write.sql.includes("backup_mode")
    )
    expect(backupInsert?.values?.[5]).toBe("restic_snapshot")
    expect(backupInsert?.values?.[6]).toBe("incremental")
    expect(backupInsert?.values?.[9]).toBeNull()
    const artifactInsert = writes.find((write) =>
      write.sql.includes("backup_artifact")
    )
    expect(artifactInsert?.values?.[2]).toBe("restic")
    expect(artifactInsert?.values?.[3]).toBe(storageId)
    expect(artifactInsert?.values?.[4]).toBeNull()
  })

  it("keeps pre-restore safety backups as full archives", async () => {
    let backupMode: unknown
    let artifactKind: unknown
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected standalone database write"),
      queryRows: () => Effect.die("Unexpected standalone database query"),
      transaction: (_operation, run) =>
        run({
          execute: (sql, values) =>
            Effect.sync(() => {
              if (sql.includes("INSERT INTO") && sql.includes("backup_mode")) {
                artifactKind = values?.[5]
                backupMode = values?.[6]
              }
              return emptyResult
            }),
          queryRows: <TRow extends RowDataPacket>(sql: string) =>
            Effect.sync(() => {
              const rows = sql.includes("backup_policy")
                ? [
                    {
                      admin_quantity_limit: null,
                      admin_size_limit_bytes: null,
                      exclude_patterns: [],
                      quantity_limit: 2,
                      size_limit_bytes: 2_048,
                      storage_id: null,
                    },
                  ]
                : [{ quantity_used: 0, size_used: 0 }]
              return rows as unknown as ReadonlyArray<TRow>
            }),
        }),
    })

    await Effect.runPromise(
      reserveInstanceBackupEffect({
        backupId: "safety-backup",
        createdBy: "user-one",
        mode: "incremental",
        name: "Before restore",
        reason: "pre_restore",
        relayId: "relay-one",
        requestedMaxBytes: null,
        targetId: "instance-one",
        taskId: "safety-task",
      }).pipe(Effect.provide(databaseLayer))
    )

    expect(backupMode).toBe("full")
    expect(artifactKind).toBe("archive")
  })

  it("rejects new backup reservations while final deletion is active", async () => {
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
              if (sql.includes("backup_policy")) {
                return [
                  {
                    admin_quantity_limit: null,
                    admin_size_limit_bytes: null,
                    exclude_patterns: [],
                    quantity_limit: null,
                    size_limit_bytes: null,
                    storage_id: null,
                  },
                ] as unknown as ReadonlyArray<TRow>
              }
              if (sql.includes("backup_final_delete")) {
                return [
                  { backup_id: "final-backup" },
                ] as unknown as ReadonlyArray<TRow>
              }
              return [] as unknown as ReadonlyArray<TRow>
            }),
        }),
    })

    await expect(
      Effect.runPromise(
        reserveInstanceBackupEffect({
          backupId: "backup-one",
          createdBy: "user-one",
          mode: "incremental",
          name: "Backup one",
          relayId: "relay-one",
          requestedMaxBytes: null,
          targetId: "instance-one",
          taskId: "task-one",
        }).pipe(Effect.provide(databaseLayer))
      )
    ).rejects.toThrow("being permanently deleted")
    expect(
      queries.find((sql) => sql.includes("backup_final_delete"))
    ).toContain("FOR UPDATE")
  })
})

describe("backup policies", () => {
  it("reads and updates policies for every backup target kind", async () => {
    const writes: Array<ReadonlyArray<unknown> | undefined> = []
    let queryValues: ReadonlyArray<unknown> | undefined
    const databaseLayer = Layer.succeed(Database)({
      execute: (_operation, _sql, values) =>
        Effect.sync(() => {
          writes.push(values)
          return emptyResult
        }),
      queryRows: <TRow extends RowDataPacket>(
        _operation: string,
        _sql: string,
        values?: ReadonlyArray<unknown>
      ) =>
        Effect.sync(() => {
          queryValues = values
          return [
            {
              admin_quantity_limit: 12,
              admin_size_limit_bytes: 4_096,
              exclude_patterns: ["cache/**"],
              quantity_limit: 6,
              size_limit_bytes: 2_048,
              storage_id: null,
            },
          ] as unknown as ReadonlyArray<TRow>
        }),
      transaction: () => Effect.die("Unexpected database transaction"),
    })

    const policy = await Effect.runPromise(
      getBackupPolicyEffect("relay-one", "database", "database-one").pipe(
        Effect.provide(databaseLayer)
      )
    )
    await Effect.runPromise(
      updateBackupLimitsEffect({
        admin: false,
        quantityLimit: 6,
        relayId: "relay-one",
        sizeLimitBytes: 2_048,
        targetId: "database-one",
        targetKind: "database",
      }).pipe(Effect.provide(databaseLayer))
    )
    await Effect.runPromise(
      updateBackupExcludesEffect({
        exclude: ["cache/**"],
        relayId: "relay-one",
        targetId: "kiln.dev",
        targetKind: "platform",
      }).pipe(Effect.provide(databaseLayer))
    )

    expect(policy).toEqual({
      adminQuantityLimit: 12,
      adminSizeLimitBytes: 4_096,
      exclude: ["cache/**"],
      quantityLimit: 6,
      sizeLimitBytes: 2_048,
      storageId: null,
    })
    expect(queryValues).toEqual(["relay-one", "database", "database-one"])
    expect(writes).toEqual([
      ["relay-one", "database", "database-one", 6, 2_048],
      ["relay-one", "platform", "kiln.dev", '["cache/**"]'],
    ])
  })
})

describe("final deletion repository purge", () => {
  it("purges remote data before deleting the incremental catalog", async () => {
    vi.mocked(deleteS3BackupPrefix).mockClear()
    vi.mocked(deleteS3BackupPrefix).mockReturnValue(Effect.void)
    const writes: Array<string> = []
    await Effect.runPromise(
      purgeInstanceBackupRepositoriesEffect("relay-one", "instance-one").pipe(
        Effect.provide(
          finalDeletionPurgeDatabase({
            transactionWrites: writes,
          })
        )
      )
    )

    expect(vi.mocked(deleteS3BackupPrefix)).toHaveBeenCalledOnce()
    expect(writes[0]).toContain("SET status = 'deleted'")
    expect(writes[1]).toContain("artifact.status = 'deleted'")
    expect(writes[2]).toContain("SET repository_id = NULL")
    expect(writes[3]).toContain("DELETE FROM")
    expect(writes[3]).toContain("backup_repository")
  })

  it("retains the incremental catalog when remote purge fails", async () => {
    vi.mocked(deleteS3BackupPrefix).mockClear()
    vi.mocked(deleteS3BackupPrefix).mockReturnValueOnce(
      Effect.fail(
        BackupStorageError.make({
          code: "s3_request_failed",
          operation: "storage.deletePrefix",
          reason: "purge failed",
        })
      )
    )
    const writes: Array<string> = []

    await expect(
      Effect.runPromise(
        purgeInstanceBackupRepositoriesEffect("relay-one", "instance-one").pipe(
          Effect.provide(
            finalDeletionPurgeDatabase({
              transactionWrites: writes,
            })
          )
        )
      )
    ).rejects.toThrow("purge failed")
    expect(writes).toEqual([])
  })
})

describe("backup reconciliation", () => {
  it("adopts Relay-owned scheduled backups into the backup catalog", async () => {
    const writes: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = []
    let knownTaskQueries = 0
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected standalone database write"),
      queryRows: () => Effect.die("Unexpected standalone database query"),
      transaction: (_operation, run) =>
        run({
          execute: (sql, values) =>
            Effect.sync(() => {
              writes.push({ sql, values })
              return emptyResult
            }),
          queryRows: <TRow extends RowDataPacket>(sql: string) => {
            if (sql.includes("backup.status AS backup_status")) {
              knownTaskQueries += 1
              return Effect.succeed(
                (knownTaskQueries === 1
                  ? []
                  : [
                      {
                        backup_status: "queued",
                        bytes_completed: 0,
                        id: "task-one",
                        relay_updated_at_ms: null,
                        status: "queued",
                      },
                    ]) as unknown as ReadonlyArray<TRow>
              )
            }
            if (sql.includes("status = 'available' LIMIT 1")) {
              return Effect.succeed([
                { id: "00000000-0000-4000-8000-000000000001" },
              ] as unknown as ReadonlyArray<TRow>)
            }
            return Effect.die(`Unexpected transaction query: ${sql}`)
          },
        }),
    })
    const task = {
      backupId: "10000000-0000-4000-8000-000000000001",
      bytesCompleted: 256,
      bytesTotal: 256,
      createdAt: Date.UTC(2026, 7, 21, 10, 29, 15),
      currentArtifactId: null,
      currentPath: null,
      error: null,
      finishedAt: Date.UTC(2026, 7, 21, 10, 29, 20),
      input: {
        artifactKind: "archive",
        backupId: "10000000-0000-4000-8000-000000000001",
        catalog: {
          name: "scheduled-2026.08.21-10.29.15Z",
          storageId: null,
        },
        destination: {
          artifactId: "00000000-0000-4000-8000-000000000001",
          kind: "local",
        },
        exclude: [],
        kind: "create",
        maxBytes: null,
        mode: "full",
        reason: "scheduled",
        target: { id: "instance-one", kind: "instance" },
        taskId: "task-one",
      },
      inputRefreshRequired: false,
      kind: "create",
      phase: null,
      result: {
        bytes: 256,
        checksumSha256: "a".repeat(64),
        filename: "backup-one.zip",
        warnings: [],
      },
      startedAt: Date.UTC(2026, 7, 21, 10, 29, 15),
      status: "succeeded",
      taskId: "task-one",
      updatedAt: Date.UTC(2026, 7, 21, 10, 29, 20),
    } satisfies RelayBackupTask

    const changed = await Effect.runPromise(
      reconcileBackupTaskEffect(task, "relay-a").pipe(
        Effect.provide(databaseLayer)
      )
    )

    expect(changed).toBe(true)

    const catalogWrite = writes.find(
      ({ sql }) =>
        sql.includes("INSERT IGNORE INTO") &&
        sql.includes("backup_mode, reason, status, name")
    )
    expect(catalogWrite?.values).toEqual([
      task.backupId,
      "relay-a",
      "instance",
      "instance-one",
      null,
      "archive",
      "full",
      "scheduled-2026.08.21-10.29.15Z",
      null,
      null,
      task.createdAt,
    ])
    expect(
      writes.some(
        ({ sql }) =>
          sql.includes("INSERT IGNORE INTO") && sql.includes("destination_key")
      )
    ).toBe(true)
    expect(
      writes.some(
        ({ sql }) =>
          sql.includes("INSERT IGNORE INTO") &&
          sql.includes("reserved_bytes, requested_by")
      )
    ).toBe(true)
  })

  it("does not resurrect a deleted backup from its historical create task", async () => {
    const writes: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = []
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected standalone database write"),
      queryRows: () => Effect.die("Unexpected standalone database query"),
      transaction: (_operation, run) =>
        run({
          execute: (sql, values) =>
            Effect.sync(() => {
              writes.push({ sql, values })
              return emptyResult
            }),
          queryRows: <TRow extends RowDataPacket>() =>
            Effect.succeed([
              {
                backup_status: "deleted",
                bytes_completed: 0,
                id: "task-one",
                relay_updated_at_ms: null,
                status: "queued",
              },
            ] as unknown as ReadonlyArray<TRow>),
        }),
    })
    const task = {
      backupId: "backup-one",
      bytesCompleted: 256,
      bytesTotal: 256,
      createdAt: 50,
      currentArtifactId: null,
      currentPath: null,
      error: null,
      finishedAt: 200,
      input: {
        artifactKind: "archive",
        backupId: "backup-one",
        destination: {
          artifactId: "00000000-0000-4000-8000-000000000001",
          kind: "local",
        },
        exclude: [],
        kind: "create",
        maxBytes: null,
        mode: "full",
        reason: "manual",
        replicas: [],
        target: { id: "instance-one", kind: "instance" },
        taskId: "task-one",
      },
      inputRefreshRequired: false,
      kind: "create",
      phase: null,
      result: {
        bytes: 256,
        checksumSha256: "a".repeat(64),
        filename: "backup-one.zip",
        warnings: [],
      },
      startedAt: 100,
      status: "succeeded",
      taskId: "task-one",
      updatedAt: 200,
    } satisfies RelayBackupTask

    await Effect.runPromise(
      reconcileBackupTaskEffect(task).pipe(Effect.provide(databaseLayer))
    )

    expect(writes).toHaveLength(1)
    expect(writes[0]?.sql).toContain("backup_task")
  })

  it("keeps artifacts available when their deletion fails", async () => {
    const writes: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = []
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected standalone database write"),
      queryRows: () => Effect.die("Unexpected standalone database query"),
      transaction: (_operation, run) =>
        run({
          execute: (sql, values) =>
            Effect.sync(() => {
              writes.push({ sql, values })
              return emptyResult
            }),
          queryRows: <TRow extends RowDataPacket>(sql: string) =>
            Effect.succeed(
              (sql.includes("FOR UPDATE")
                ? [
                    {
                      bytes_completed: 0,
                      id: "task-one",
                      relay_updated_at_ms: 100,
                      status: "running",
                    },
                  ]
                : [{ id: "artifact-failed" }]) as unknown as ReadonlyArray<TRow>
            ),
        }),
    })
    const task = {
      backupId: "backup-one",
      bytesCompleted: 0,
      bytesTotal: null,
      createdAt: 50,
      currentArtifactId: null,
      currentPath: null,
      error: null,
      finishedAt: 200,
      input: {
        backupId: "backup-one",
        destination: {
          artifactId: "00000000-0000-4000-8000-000000000001",
          kind: "local",
        },
        kind: "delete",
        target: { id: "instance-one", kind: "instance" },
        taskId: "task-one",
      },
      inputRefreshRequired: false,
      kind: "delete",
      phase: null,
      result: {
        artifacts: [
          {
            artifactId: "00000000-0000-4000-8000-000000000001",
            error: "Temporary S3 delete failure",
            status: "failed",
          },
          {
            artifactId: "00000000-0000-4000-8000-000000000002",
            error: null,
            status: "deleted",
          },
        ],
        warnings: [],
      },
      startedAt: 100,
      status: "succeeded",
      taskId: "task-one",
      updatedAt: 200,
    } satisfies RelayBackupTask

    await Effect.runPromise(
      reconcileBackupTaskEffect(task).pipe(Effect.provide(databaseLayer))
    )

    const artifactWrites = writes.filter(
      ({ sql }) => sql.includes("backup_artifact") && sql.includes("error = ?")
    )
    expect(artifactWrites.map(({ values }) => values?.slice(0, 3))).toEqual([
      ["available", "Temporary S3 delete failure", "available"],
      ["deleted", null, "deleted"],
    ])
    const backupWrite = writes.find(
      ({ sql }) =>
        !sql.includes("backup_artifact") && sql.includes("deleted_at = CASE")
    )
    expect(backupWrite?.values?.slice(0, 2)).toEqual(["available", "available"])
  })

  it("reconciles delete progress one artifact at a time", async () => {
    const writes: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = []
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected standalone database write"),
      queryRows: () => Effect.die("Unexpected standalone database query"),
      transaction: (_operation, run) =>
        run({
          execute: (sql, values) =>
            Effect.sync(() => {
              writes.push({ sql, values })
              return emptyResult
            }),
          queryRows: <TRow extends RowDataPacket>() =>
            Effect.succeed([
              {
                backup_status: "deleting",
                bytes_completed: 0,
                id: "task-one",
                relay_updated_at_ms: 100,
                status: "running",
              },
            ] as unknown as ReadonlyArray<TRow>),
        }),
    })
    const deletedArtifactId = "33000000-0000-4000-8000-000000000001"
    const currentArtifactId = "33000000-0000-4000-8000-000000000002"
    const task = {
      backupId: "backup-one",
      bytesCompleted: 0,
      bytesTotal: null,
      createdAt: 50,
      currentArtifactId,
      currentPath: null,
      error: null,
      finishedAt: null,
      input: {
        backupId: "backup-one",
        destination: { artifactId: deletedArtifactId, kind: "local" },
        kind: "delete",
        replicas: [
          {
            allowPrivateNetwork: false,
            artifactId: currentArtifactId,
            deleteUrl: "https://example.com/backups/test.zip",
            headers: {},
            kind: "s3",
            objectKey: "backups/test.zip",
          },
        ],
        target: { id: "instance-one", kind: "instance" },
        taskId: "task-one",
      },
      inputRefreshRequired: false,
      kind: "delete",
      phase: null,
      result: {
        artifacts: [
          { artifactId: deletedArtifactId, error: null, status: "deleted" },
        ],
        warnings: [],
      },
      startedAt: 100,
      status: "running",
      taskId: "task-one",
      updatedAt: 200,
    } satisfies RelayBackupTask

    await Effect.runPromise(
      reconcileBackupTaskEffect(task).pipe(Effect.provide(databaseLayer))
    )

    const artifactWrites = writes.filter(({ sql }) =>
      sql.includes("backup_artifact")
    )
    expect(artifactWrites).toHaveLength(3)
    expect(artifactWrites[1]?.values).toEqual([currentArtifactId, "backup-one"])
    expect(artifactWrites[2]?.values).toEqual([
      "deleted",
      null,
      "deleted",
      200,
      deletedArtifactId,
      "backup-one",
    ])
  })

  it("rejects stale Relay snapshots after a task has completed", () => {
    const completed = {
      bytesCompleted: 256,
      relayUpdatedAt: 300,
      status: "succeeded" as const,
    }

    expect(
      shouldApplyRelayBackupTaskSnapshot(completed, {
        bytesCompleted: 128,
        status: "running",
        updatedAt: 200,
      })
    ).toBe(false)
    expect(
      shouldApplyRelayBackupTaskSnapshot(completed, {
        bytesCompleted: 0,
        status: "queued",
        updatedAt: 100,
      })
    ).toBe(false)
    expect(
      shouldApplyRelayBackupTaskSnapshot(
        { ...completed, relayUpdatedAt: null },
        { bytesCompleted: 128, status: "running", updatedAt: 400 }
      )
    ).toBe(false)
  })

  it("allows newer snapshots and same-millisecond forward progress", () => {
    expect(
      shouldApplyRelayBackupTaskSnapshot(
        { bytesCompleted: 64, relayUpdatedAt: 100, status: "running" },
        { bytesCompleted: 128, status: "running", updatedAt: 200 }
      )
    ).toBe(true)
    expect(
      shouldApplyRelayBackupTaskSnapshot(
        { bytesCompleted: 0, relayUpdatedAt: 100, status: "running" },
        { bytesCompleted: 256, status: "succeeded", updatedAt: 100 }
      )
    ).toBe(true)
    expect(
      shouldApplyRelayBackupTaskSnapshot(
        { bytesCompleted: 256, relayUpdatedAt: 100, status: "succeeded" },
        { bytesCompleted: 128, status: "running", updatedAt: 100 }
      )
    ).toBe(false)
    expect(
      shouldApplyRelayBackupTaskSnapshot(
        { bytesCompleted: 64, relayUpdatedAt: 100, status: "running" },
        { bytesCompleted: 128, status: "running", updatedAt: 100 }
      )
    ).toBe(true)
    expect(
      shouldApplyRelayBackupTaskSnapshot(
        { bytesCompleted: 128, relayUpdatedAt: 100, status: "running" },
        { bytesCompleted: 128, status: "running", updatedAt: 100 }
      )
    ).toBe(false)
  })
})

function finalDeletionPurgeDatabase(input: {
  transactionWrites: Array<string>
}) {
  return Layer.succeed(Database)({
    execute: () => Effect.die("Unexpected standalone database write"),
    queryRows: <TRow extends RowDataPacket>(operation: string) =>
      Effect.sync(() => {
        if (operation === "backup_instance_repositories") {
          return [
            {
              id: "repository-one",
              object_prefix: "team/restic/instance-one/repository-one",
              storage_id: "storage-one",
            },
          ] as unknown as ReadonlyArray<TRow>
        }
        if (operation === "backup_storage_credential") {
          return [
            {
              access_key_id_ciphertext: "enc:AKIAEXAMPLE",
              allow_private_network: 1,
              bucket: "kiln-backups",
              created_at_ms: Date.parse("2026-01-01T00:00:00.000Z"),
              deleting: 0,
              enabled: 1,
              endpoint: "https://s3.example.com",
              force_path_style: 1,
              id: "storage-one",
              last_error: null,
              last_verified_at_ms: null,
              name: "s3",
              object_prefix: "team",
              owner_user_id: null,
              region: "us-east-1",
              secret_access_key_ciphertext: "enc:s3-secret",
            },
          ] as unknown as ReadonlyArray<TRow>
        }
        throw new Error(`Unexpected query ${operation}`)
      }),
    transaction: (_operation, run) =>
      run({
        execute: (sql) =>
          Effect.sync(() => {
            input.transactionWrites.push(sql)
            return emptyResult
          }),
        queryRows: () => Effect.die("Unexpected transaction query"),
      }),
  })
}

describe("backup rename", () => {
  it("updates the backup name", async () => {
    const executed: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = []
    const databaseLayer = Layer.succeed(Database)({
      execute: (_operation, sql, values) =>
        Effect.sync(() => {
          executed.push({ sql, values })
          return { ...emptyResult, affectedRows: 1 }
        }),
      queryRows: () => Effect.die("Unexpected query"),
      transaction: () => Effect.die("Unexpected transaction"),
    })

    const renamed = await Effect.runPromise(
      renameBackupEffect({
        backupId: "11111111-1111-1111-1111-111111111111",
        name: "Weekly world",
      }).pipe(Effect.provide(databaseLayer))
    )

    expect(renamed).toBe(true)
    expect(executed).toHaveLength(1)
    expect(executed[0]?.sql).toContain("SET name = ?")
    expect(executed[0]?.values).toEqual([
      "Weekly world",
      "11111111-1111-1111-1111-111111111111",
    ])
  })
})

describe("backup copy reservation", () => {
  const input = {
    artifactKind: "archive" as const,
    backupId: "11111111-1111-4111-8111-111111111111",
    filename: "backup.zip",
    relayId: "relay-one",
    requestedBy: "user-one",
    sourceArtifactId: "22222222-2222-4222-8222-222222222222",
    storageId: "33333333-3333-4333-8333-333333333333",
    targetId: "instance-one",
    targetKind: "instance" as const,
  }

  it("rejects a destination owned by another user", async () => {
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected standalone database write"),
      queryRows: () => Effect.die("Unexpected standalone database query"),
      transaction: (_operation, run) =>
        run({
          execute: () => Effect.die("Unexpected transaction write"),
          queryRows: <TRow extends RowDataPacket>(sql: string) =>
            Effect.succeed(
              (sql.includes("backup_storage")
                ? [
                    {
                      id: input.storageId,
                      object_prefix: "backups",
                      owner_user_id: "user-two",
                    },
                  ]
                : [
                    { id: input.sourceArtifactId },
                  ]) as unknown as ReadonlyArray<TRow>
            ),
        }),
    })

    await expect(
      Effect.runPromise(
        reserveBackupCopyEffect(input).pipe(Effect.provide(databaseLayer))
      )
    ).rejects.toBeInstanceOf(BackupStorageError)
  })

  it("queues the artifact and durable copy task", async () => {
    const writes: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = []
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected standalone database write"),
      queryRows: () => Effect.die("Unexpected standalone database query"),
      transaction: (_operation, run) =>
        run({
          execute: (sql, values) =>
            Effect.sync(() => {
              writes.push({ sql, values })
              return emptyResult
            }),
          queryRows: <TRow extends RowDataPacket>(sql: string) =>
            Effect.succeed(
              (sql.includes("backup_storage")
                ? [
                    {
                      id: input.storageId,
                      object_prefix: "backups",
                      owner_user_id: "user-one",
                    },
                  ]
                : sql.includes("JOIN")
                  ? [{ id: input.sourceArtifactId }]
                  : []) as unknown as ReadonlyArray<TRow>
            ),
        }),
    })

    const reserved = await Effect.runPromise(
      reserveBackupCopyEffect(input).pipe(Effect.provide(databaseLayer))
    )

    expect(reserved.artifactId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    )
    expect(reserved.taskId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    )
    expect(writes[0]?.sql).toContain("'queued'")
    expect(writes[1]?.sql).toContain("backup_copy_task")
    expect(writes[1]?.values?.slice(1)).toEqual([
      input.backupId,
      input.sourceArtifactId,
      reserved.artifactId,
      input.requestedBy,
    ])
  })
})

function incrementalStorageLayer(storage: {
  bucket: string
  object_prefix: string
  region: string
}) {
  const storageId = "11111111-1111-4111-8111-111111111111"
  return Layer.succeed(Database)({
    execute: () => Effect.die("Unexpected standalone database write"),
    queryRows: () => Effect.die("Unexpected standalone database query"),
    transaction: (_operation, run) =>
      run({
        execute: () => Effect.succeed(emptyResult),
        queryRows: <TRow extends RowDataPacket>(sql: string) =>
          Effect.sync(() => {
            if (sql.includes("backup_policy")) {
              return [
                {
                  admin_quantity_limit: null,
                  admin_size_limit_bytes: null,
                  exclude_patterns: [],
                  quantity_limit: 2,
                  size_limit_bytes: 2_048,
                  storage_id: storageId,
                },
              ] as unknown as ReadonlyArray<TRow>
            }
            if (sql.includes("backup_storage")) {
              return [
                {
                  bucket: storage.bucket,
                  deleting: 0,
                  enabled: 1,
                  endpoint: "https://s3.example.com",
                  id: storageId,
                  object_prefix: storage.object_prefix,
                  owner_user_id: null,
                  region: storage.region,
                },
              ] as unknown as ReadonlyArray<TRow>
            }
            return [] as unknown as ReadonlyArray<TRow>
          }),
      }),
  })
}
