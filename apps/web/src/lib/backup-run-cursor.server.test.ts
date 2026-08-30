import { describe, expect, it } from "vite-plus/test"

import {
  decodeBackupRunCursor,
  encodeBackupRunCursor,
} from "@/lib/backup-run-cursor.server"

const backupId = "7ff61850-2e5e-4238-b960-755b743a246a"

describe("backup run cursors", () => {
  it("round trips an opaque order key", () => {
    const encoded = encodeBackupRunCursor({
      fingerprint: "query-a",
      id: backupId,
      value: 42,
    })

    expect(encoded).not.toContain(backupId)
    expect(decodeBackupRunCursor(encoded, "query-a", "size")).toEqual({
      id: backupId,
      value: 42,
    })
  })

  it("rejects a cursor reused with another query", () => {
    const encoded = encodeBackupRunCursor({
      fingerprint: "query-a",
      id: backupId,
      value: "backup",
    })

    expect(() => decodeBackupRunCursor(encoded, "query-b", "name")).toThrow(
      "does not match"
    )
  })

  it("rejects order values for the wrong sort", () => {
    const encoded = encodeBackupRunCursor({
      fingerprint: "query-a",
      id: backupId,
      value: "backup",
    })

    expect(() =>
      decodeBackupRunCursor(encoded, "query-a", "createdAt")
    ).toThrow("invalid order value")
  })

  it("rejects malformed cursor payloads consistently", () => {
    const encoded = Buffer.from(
      JSON.stringify({ version: 1 }),
      "utf8"
    ).toString("base64url")

    expect(() =>
      decodeBackupRunCursor(encoded, "query-a", "createdAt")
    ).toThrow("Invalid backup cursor")
  })
})
