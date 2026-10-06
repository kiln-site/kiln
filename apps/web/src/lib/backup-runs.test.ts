import { describe, expect, it } from "vite-plus/test"

import {
  backupRunsQueryFingerprint,
  normalizeBackupRunsQuery,
} from "@/lib/backup-runs"

describe("backup runs query primitives", () => {
  it("normalizes search without including the cursor in the fingerprint", () => {
    const first = normalizeBackupRunsQuery({
      cursor: "first",
      direction: "desc",
      search: "  SURVIVAL  ",
      sort: "createdAt",
    })
    const second = normalizeBackupRunsQuery({
      cursor: "second",
      direction: "desc",
      search: "survival",
      sort: "createdAt",
    })

    expect(first.search).toBe("survival")
    expect(backupRunsQueryFingerprint(first)).toBe(
      backupRunsQueryFingerprint(second)
    )
  })
})
