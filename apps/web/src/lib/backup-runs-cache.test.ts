import { QueryClient, type InfiniteData } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vite-plus/test"

import type { BackupRun, BackupRunsPage } from "@/lib/backup-runs"
import {
  commitRefreshedBackupRunsFirstPage,
  mergeRefreshedBackupRunsFirstPage,
  patchBackupRunsData,
} from "@/lib/backup-runs-cache"

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

describe("backup runs background first-page refresh", () => {
  it("keeps the loaded cache untouched when reconciliation changed nothing", () => {
    const current = infiniteData([
      [backupRun(firstId, 20)],
      [backupRun(secondId, 10)],
    ])

    expect(mergeRefreshedBackupRunsFirstPage(current, current.pages[0]!)).toBe(
      current
    )
  })

  it("updates stable first-page rows without discarding later pages", () => {
    const current = infiniteData([
      [backupRun(firstId, 20)],
      [backupRun(secondId, 10)],
    ])
    const refreshed = {
      ...current.pages[0]!,
      items: [{ ...current.pages[0]!.items[0]!, taskBytesCompleted: 5 }],
    }

    const result = mergeRefreshedBackupRunsFirstPage(current, refreshed)

    expect(result.pages).toHaveLength(2)
    expect(result.pages[0]).toEqual(refreshed)
    expect(result.pages[1]).toBe(current.pages[1])
  })

  it("resets an invalid cursor chain when first-page membership changes", () => {
    const current = infiniteData([
      [backupRun(firstId, 20)],
      [backupRun(secondId, 10)],
    ])
    const replacementId = "84924518-b4c4-4fc0-a8fd-ee9a6b451f85"
    const refreshed = {
      items: [backupRun(replacementId, 30)],
      nextCursor: "replacement-page-2",
    }

    expect(mergeRefreshedBackupRunsFirstPage(current, refreshed)).toEqual({
      pageParams: [null],
      pages: [refreshed],
    })
  })

  it("cancels an in-flight page load before replacing a changed cursor chain", async () => {
    const queryClient = new QueryClient()
    const queryKey = ["backups", "runs", "test"] as const
    const current = infiniteData([
      [backupRun(firstId, 20)],
      [backupRun(secondId, 10)],
    ])
    const refreshed = {
      items: [
        backupRun("84924518-b4c4-4fc0-a8fd-ee9a6b451f85", 30),
      ],
      nextCursor: "replacement-page-2",
    }
    queryClient.setQueryData(queryKey, current)
    const cancel = vi.spyOn(queryClient, "cancelQueries")

    await commitRefreshedBackupRunsFirstPage(
      queryClient,
      queryKey,
      refreshed
    )

    expect(cancel).toHaveBeenCalledWith(
      { exact: true, queryKey },
      { silent: true }
    )
    expect(queryClient.getQueryData(queryKey)).toEqual({
      pageParams: [null],
      pages: [refreshed],
    })
  })

  it("does not cancel a compatible in-flight next page", async () => {
    const queryClient = new QueryClient()
    const queryKey = ["backups", "runs", "test"] as const
    const current = infiniteData([
      [backupRun(firstId, 20)],
      [backupRun(secondId, 10)],
    ])
    const refreshed = {
      ...current.pages[0]!,
      items: [{ ...current.pages[0]!.items[0]!, taskBytesCompleted: 5 }],
    }
    queryClient.setQueryData(queryKey, current)
    const cancel = vi.spyOn(queryClient, "cancelQueries")

    await commitRefreshedBackupRunsFirstPage(
      queryClient,
      queryKey,
      refreshed
    )

    expect(cancel).not.toHaveBeenCalled()
    expect(
      queryClient.getQueryData<InfiniteData<BackupRunsPage, string | null>>(
        queryKey
      )?.pages
    ).toHaveLength(2)
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
