import { z } from "zod"

import type { CursorPage } from "@/lib/cursor-page"

export const backupRunSorts = ["name", "target", "size", "createdAt"] as const
export const backupRunsSearchMaxLength = 200
export type BackupRunSort = (typeof backupRunSorts)[number]
export type BackupRunSortDirection = "asc" | "desc"
export type BackupRunStatus = "active" | "available" | "failed"

export const backupRunScopeSchema = z.strictObject({
  kind: z.enum(["database", "instance", "platform"]),
  relayId: z.string().min(1).max(43),
  targetId: z.string().min(1).max(120),
})

export const backupRunsQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(2_048).nullable().optional(),
  direction: z.enum(["asc", "desc"]).default("desc"),
  scope: backupRunScopeSchema.nullable().optional(),
  search: z.string().trim().max(backupRunsSearchMaxLength).default(""),
  sort: z.enum(backupRunSorts).default("createdAt"),
  status: z.enum(["active", "available", "failed"]).nullable().optional(),
})

export type BackupRunsQuery = z.infer<typeof backupRunsQuerySchema>
export type BackupRunScope = z.infer<typeof backupRunScopeSchema>

export interface BackupRunOrderKey {
  id: string
  value: number | string | null
}

export interface BackupRunArtifact {
  bytes: number | null
  checksumSha256: string | null
  error: string | null
  filename: string | null
  id: string
  status: "available" | "deleted" | "deleting" | "failed" | "queued" | "running"
  storageId: string | null
}

export interface BackupRun {
  artifacts: Array<BackupRunArtifact>
  artifactKind:
    | "archive"
    | "database_dump"
    | "platform_bundle"
    | "restic_snapshot"
  backupMode: "full" | "incremental"
  bytes: number | null
  checksumSha256: string | null
  completedAt: string | null
  createdAt: string
  filename: string | null
  id: string
  name: string
  orderKey: BackupRunOrderKey
  reason: "final_delete" | "manual" | "pre_restore" | "scheduled"
  relayId: string
  relayPresent: boolean
  resticSnapshotId: string | null
  status: "available" | "deleted" | "deleting" | "failed" | "queued" | "running"
  storageId: string | null
  targetId: string
  targetKind: "database" | "instance" | "platform"
  taskBytesCompleted: number
  taskBytesTotal: number | null
  taskCurrentArtifactId: string | null
  taskCurrentPath: string | null
  taskError: string | null
  taskId: string
  taskKind: "create" | "delete" | "export" | "restore"
  taskPhase:
    | "preparing"
    | "collecting"
    | "archiving"
    | "dumping"
    | "uploading"
    | "finalizing"
    | null
  taskStartedAt: string | null
  taskStatus: "cancelled" | "failed" | "queued" | "running" | "succeeded"
  taskUpdatedAt: string
  warnings: Array<string>
}

export type BackupRunsPage = CursorPage<BackupRun>

export function normalizeBackupRunsQuery(input: BackupRunsQuery) {
  return {
    cursor: input.cursor ?? null,
    direction: input.direction,
    scope: input.scope ?? null,
    search: input.search.trim().toLowerCase(),
    sort: input.sort,
    status: input.status ?? null,
  }
}

export function backupRunsQueryFingerprint(
  input: Omit<ReturnType<typeof normalizeBackupRunsQuery>, "cursor">
): string {
  return JSON.stringify({
    direction: input.direction,
    scope: input.scope,
    search: input.search,
    sort: input.sort,
    status: input.status,
    version: 1,
  })
}

export function backupRunsQueryKey(
  query: Omit<ReturnType<typeof normalizeBackupRunsQuery>, "cursor">
) {
  return ["backups", "runs", query] as const
}

export function compareBackupRunOrderKeys(
  left: BackupRunOrderKey,
  right: BackupRunOrderKey,
  direction: BackupRunSortDirection
): number {
  if (left.value === null && right.value !== null) return 1
  if (left.value !== null && right.value === null) return -1
  const valueComparison = compareNullableOrderValues(left.value, right.value)
  if (valueComparison !== 0) {
    return direction === "asc" ? valueComparison : -valueComparison
  }
  return direction === "asc"
    ? left.id.localeCompare(right.id)
    : right.id.localeCompare(left.id)
}

function compareNullableOrderValues(
  left: BackupRunOrderKey["value"],
  right: BackupRunOrderKey["value"]
): number {
  if (left === null) return right === null ? 0 : 1
  if (right === null) return -1
  if (typeof left === "number" && typeof right === "number") {
    return left - right
  }
  return String(left).localeCompare(String(right))
}
