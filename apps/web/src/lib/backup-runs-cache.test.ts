import type { InfiniteData } from "@tanstack/react-query"
import { describe, expect, it } from "vite-plus/test"

import type { BackupRun, BackupRunsPage } from "@/lib/backup-runs"
import { patchBackupRunsData } from "@/lib/backup-runs-cache"

const firstId = "7ff61850-2e5e-4238-b960-755b743a246a"
const secondId = "ab145091-0f4d-44cc-a30b-b8b3ee21b36f"

describe("backup runs realtime cache patches", () => {
  it("uses no-op and reset for absent membership", () => {
    const data = infiniteData([[backupRun(firstId, 10)]])
    expect(patchBackupRunsData(data, secondId, null, "size")).toEqual({
      kind: "noop",
    })
    expect(
      patchBackupRunsData(data, secondId, backupRun(secondId, 20), "size")
    ).toEqual({ kind: "reset" })
  })

  it("patches existing rows in place when their order is stable", () => {
    const data = infiniteData([[backupRun(firstId, 10)]])
    const replacement = { ...backupRun(firstId, 10), taskBytesCompleted: 5 }
    const patch = patchBackupRunsData(data, firstId, replacement, "size")

    expect(patch.kind).toBe("update")
    if (patch.kind === "update") {
      expect(patch.data.pages[0]?.items[0]).toBe(replacement)
    }
  })

  it("removes matching rows and only drops empty tail pages", () => {
    const data = infiniteData([
      [backupRun(firstId, 10)],
      [backupRun(secondId, 20)],
    ])
    const patch = patchBackupRunsData(data, secondId, null, "size")

    expect(patch.kind).toBe("update")
    if (patch.kind === "update") {
      expect(patch.data.pages).toHaveLength(1)
      expect(patch.data.pageParams).toEqual([null])
    }
  })

  it("resets rather than hiding unloaded rows after the loaded set empties", () => {
    const data: InfiniteData<BackupRunsPage, string | null> = {
      pageParams: [null],
      pages: [{ items: [backupRun(firstId, 10)], nextCursor: "page-2" }],
    }

    expect(patchBackupRunsData(data, firstId, null, "size")).toEqual({
      kind: "reset",
    })
  })

  it("resets changed name order and terminal size order", () => {
    const nameData = infiniteData([[backupRun(firstId, "alpha")]])
    expect(
      patchBackupRunsData(nameData, firstId, backupRun(firstId, "beta"), "name")
    ).toEqual({ kind: "reset" })

    const active = backupRun(firstId, 10, "running")
    const terminal = backupRun(firstId, 20, "available")
    expect(
      patchBackupRunsData(infiniteData([[active]]), firstId, terminal, "size")
    ).toEqual({ kind: "reset" })
  })

  it("keeps active size progress in place for scroll stability", () => {
    const active = backupRun(firstId, 10, "running")
    const progressed = backupRun(firstId, 20, "running")
    expect(
      patchBackupRunsData(infiniteData([[active]]), firstId, progressed, "size")
        .kind
    ).toBe("update")
  })
})

function infiniteData(
  items: Array<Array<BackupRun>>
): InfiniteData<BackupRunsPage, string | null> {
  return {
    pageParams: items.map((_, index) => (index === 0 ? null : `page-${index}`)),
    pages: items.map((pageItems, index) => ({
      items: pageItems,
      nextCursor: index === items.length - 1 ? null : `page-${index + 1}`,
    })),
  }
}

function backupRun(
  id: string,
  orderValue: number | string | null,
  status: BackupRun["status"] = "available"
): BackupRun {
  return {
    artifacts: [],
    artifactKind: "archive",
    backupMode: "full",
    bytes: typeof orderValue === "number" ? orderValue : null,
    checksumSha256: null,
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    filename: null,
    id,
    name: "Backup",
    orderKey: { id, value: orderValue },
    reason: "manual",
    relayId: "relay-a",
    relayPresent: true,
    resticSnapshotId: null,
    status,
    storageId: null,
    targetId: "instance-a",
    targetKind: "instance",
    taskBytesCompleted: 0,
    taskBytesTotal: null,
    taskCurrentArtifactId: null,
    taskCurrentPath: null,
    taskError: null,
    taskId: "task-a",
    taskKind: "create",
    taskPhase: null,
    taskStartedAt: null,
    taskStatus: status === "running" ? "running" : "succeeded",
    taskUpdatedAt: "2026-01-01T00:00:00.000Z",
    warnings: [],
  }
}
