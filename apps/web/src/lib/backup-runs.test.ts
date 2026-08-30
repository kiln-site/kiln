import { describe, expect, it } from "vite-plus/test"

import {
  backupRunsQueryFingerprint,
  compareBackupRunOrderKeys,
  normalizeBackupRunsQuery,
} from "@/lib/backup-runs"
import { flattenCursorPages } from "@/lib/cursor-page"

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

  it("keeps null sizes last and breaks ties by id", () => {
    expect(
      compareBackupRunOrderKeys(
        { id: "b", value: null },
        { id: "a", value: 10 },
        "asc"
      )
    ).toBeGreaterThan(0)
    expect(
      compareBackupRunOrderKeys(
        { id: "b", value: 10 },
        { id: "a", value: 10 },
        "desc"
      )
    ).toBeLessThan(0)
  })

  it("deduplicates overlapping cursor pages in their server order", () => {
    expect(
      flattenCursorPages(
        [
          { items: [{ id: "a" }, { id: "b" }], nextCursor: "next" },
          { items: [{ id: "b" }, { id: "c" }], nextCursor: null },
        ],
        (item) => item.id
      )
    ).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }])
  })
})
