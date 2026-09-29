import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import type { BackupArtifactKind } from "@workspace/contracts"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"
import { Database } from "@/effect/database"
import { betterAuthSecrets } from "@/lib/environment"
import { databaseTable } from "@/lib/database-config"

export interface BackupDownloadShare {
  artifactKind: BackupArtifactKind
  backupId: string
  backupName: string
  bytes: number | null
  checksumSha256: string | null
  createdAt: string
  downloadUrl: string
  expiresAt: string
  filename: string
  sharedBy: string
  sourceName: string
  targetId: string
  targetKind: "database" | "instance" | "platform"
}

interface BackupDownloadShareRow extends RowDataPacket {
  artifact_kind: BackupArtifactKind
  backup_created_at: number
  backup_id: string
  backup_name: string
  bytes: number | string | null
  checksum_sha256: string | null
  download_url_ciphertext: string
  expires_at: number
  filename: string
  shared_by: string
  source_name: string
  target_id: string
  target_kind: BackupDownloadShare["targetKind"]
}

export const createBackupDownloadShareEffect = Effect.fn(
  "backups.downloadShares.create"
)(function* (
  input: BackupDownloadShare & {
    tokenHash: string
  }
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const ciphertext = yield* Effect.try({
    try: () =>
      encryptWithKeyring(
        input.downloadUrl,
        betterAuthSecrets(),
        encryptionPurpose(input.tokenHash)
      ),
    catch: (cause) => cause,
  })
  yield* database.execute(
    "backup_download_shares_cleanup",
    `DELETE FROM ${databaseTable("backup_download_share")}
      WHERE expires_at <= ?`,
    [now]
  )
  yield* database.execute(
    "backup_download_shares_create",
    `INSERT INTO ${databaseTable("backup_download_share")}
      (token_hash, download_url_ciphertext, backup_id, backup_name, filename,
       bytes, checksum_sha256, artifact_kind, target_kind, target_id,
       source_name, shared_by, backup_created_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.tokenHash,
      ciphertext,
      input.backupId,
      input.backupName,
      input.filename,
      input.bytes,
      input.checksumSha256,
      input.artifactKind,
      input.targetKind,
      input.targetId,
      input.sourceName,
      input.sharedBy,
      Date.parse(input.createdAt),
      Date.parse(input.expiresAt),
      now,
    ]
  )
})

export const loadBackupDownloadShareEffect = Effect.fn(
  "backups.downloadShares.load"
)(function* (tokenHash: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const rows = yield* database.queryRows<BackupDownloadShareRow>(
    "backup_download_shares_load",
    `SELECT download_url_ciphertext, backup_id, backup_name, filename, bytes,
            checksum_sha256, artifact_kind, target_kind, target_id,
            source_name, shared_by, backup_created_at, expires_at
       FROM ${databaseTable("backup_download_share")}
      WHERE token_hash = ? AND expires_at > ?
      LIMIT 1`,
    [tokenHash, now]
  )
  const row = rows.at(0)
  if (!row) return null
  const decrypted = yield* Effect.try({
    try: () =>
      decryptWithKeyring(
        row.download_url_ciphertext,
        betterAuthSecrets(),
        encryptionPurpose(tokenHash)
      ),
    catch: (cause) => cause,
  })
  return {
    artifactKind: row.artifact_kind,
    backupId: row.backup_id,
    backupName: row.backup_name,
    bytes: databaseNumber(row.bytes),
    checksumSha256: row.checksum_sha256,
    createdAt: new Date(row.backup_created_at).toISOString(),
    downloadUrl: decrypted.plaintext,
    expiresAt: new Date(row.expires_at).toISOString(),
    filename: row.filename,
    sharedBy: row.shared_by,
    sourceName: row.source_name,
    targetId: row.target_id,
    targetKind: row.target_kind,
  } satisfies BackupDownloadShare
})

function encryptionPurpose(tokenHash: string): string {
  return `kiln-backup-download-share:${tokenHash}`
}

function databaseNumber(value: number | string | null): number | null {
  if (value === null) return null
  const number = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("Backup download share contains an invalid byte count")
  }
  return number
}
