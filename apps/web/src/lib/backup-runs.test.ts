import { describe, expect, it } from "vite-plus/test"

import {
  backupRunScopesEqual,
  backupRunsInputFromQueryKey,
  backupRunsQueryKey,
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

  it("only retains rows when the backup scope is unchanged", () => {
    const scope = {
      kind: "instance" as const,
      relayId: "relay-1",
      targetId: "server-1",
    }

    expect(backupRunScopesEqual(scope, { ...scope })).toBe(true)
    expect(
      backupRunScopesEqual(scope, { ...scope, targetId: "server-2" })
    ).toBe(false)
    expect(backupRunScopesEqual(null, null)).toBe(true)
    expect(backupRunScopesEqual(scope, null)).toBe(false)
  })

  it("recovers normalized backup input from its query key", () => {
    const query = normalizeBackupRunsQuery({
      direction: "desc",
      scope: null,
      search: "survival",
      sort: "createdAt",
      status: null,
    })
    const { cursor: _, ...queryWithoutCursor } = query

    expect(
      backupRunsInputFromQueryKey(backupRunsQueryKey(queryWithoutCursor))
    ).toEqual(query)
    expect(backupRunsInputFromQueryKey(["other", "query"])).toBeNull()
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
