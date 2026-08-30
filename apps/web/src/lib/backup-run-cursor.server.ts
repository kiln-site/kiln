import { z } from "zod"
import { Result } from "effect"

import type { BackupRunSort } from "@/lib/backup-runs"

const backupRunCursorSchema = z.strictObject({
  fingerprint: z.string().min(1),
  id: z.uuid(),
  value: z.union([
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    z.string(),
    z.null(),
  ]),
  version: z.literal(1),
})

export function encodeBackupRunCursor(input: {
  fingerprint: string
  id: string
  value: number | string | null
}): string {
  return Buffer.from(JSON.stringify({ ...input, version: 1 }), "utf8").toString(
    "base64url"
  )
}

export function decodeBackupRunCursor(
  encoded: string | null,
  fingerprint: string,
  sort: BackupRunSort
): { id: string; value: number | string | null } | null {
  if (!encoded) return null
  const decoded = Result.try(() =>
    JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
  )
  if (Result.isFailure(decoded)) throw new Error("Invalid backup cursor")
  const parsed = backupRunCursorSchema.safeParse(decoded.success)
  if (!parsed.success) throw new Error("Invalid backup cursor")
  const cursor = parsed.data
  if (cursor.fingerprint !== fingerprint) {
    throw new Error("Backup cursor does not match this query")
  }
  const expectsText = sort === "name" || sort === "target"
  if (
    (expectsText && typeof cursor.value !== "string") ||
    (sort === "createdAt" && typeof cursor.value !== "number") ||
    (sort === "size" &&
      cursor.value !== null &&
      typeof cursor.value !== "number")
  ) {
    throw new Error("Backup cursor has an invalid order value")
  }
  return { id: cursor.id, value: cursor.value }
}
