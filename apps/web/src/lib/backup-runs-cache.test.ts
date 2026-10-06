import {
  InfiniteQueryObserver,
  QueryClient,
  type InfiniteData,
} from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

const server = vi.hoisted(() => ({ getBackupRunsPage: vi.fn() }))

vi.mock("@/server/backups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/backups")>()),
  getBackupRunsPage: server.getBackupRunsPage,
}))

import type { BackupRun, BackupRunsPage } from "@/lib/backup-runs"
import {
  patchBackupRunsData,
  refreshActiveBackupRunsFirstPages,
} from "@/lib/backup-runs-cache"
import { backupRunsInfiniteQueryOptions } from "@/lib/query-options"

const firstId = "7ff61850-2e5e-4238-b960-755b743a246a"
const secondId = "ab145091-0f4d-44cc-a30b-b8b3ee21b36f"
const thirdId = "c3a9e2d4-5b1f-4c8e-9a7d-2f6b8e0c1d3a"
const replacementId = "84924518-b4c4-4fc0-a8fd-ee9a6b451f85"

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
  type RunsData = InfiniteData<BackupRunsPage, string | null>

  const openObservers: Array<() => void> = []

  afterEach(() => {
    openObservers.splice(0).forEach((unsubscribe) => unsubscribe())
    server.getBackupRunsPage.mockReset()
  })

  // A mounted backups table showing `current`, fetched through the same query
  // options the page uses.
  function mountedRuns(current: RunsData) {
    const queryClient = new QueryClient()
    const options = backupRunsInfiniteQueryOptions({
      direction: "desc",
      search: "",
      sort: "createdAt",
    })
    queryClient.setQueryData(options.queryKey, current)
    const observer = new InfiniteQueryObserver(queryClient, options)
    openObservers.push(observer.subscribe(() => undefined))
    return {
      data: () => queryClient.getQueryData<RunsData>(options.queryKey),
      observer,
      refresh: () => refreshActiveBackupRunsFirstPages(queryClient),
    }
  }

  // Answers first-page requests with `firstPage` and holds later pages until
  // the returned function releases them.
  function serveFirstPage(firstPage: BackupRunsPage) {
    let releaseNextPage!: (page: BackupRunsPage) => void
    const nextPage = new Promise<BackupRunsPage>((resolve) => {
      releaseNextPage = resolve
    })
    server.getBackupRunsPage.mockImplementation(
      ({ data }: { data: { cursor: string | null } }) =>
        data.cursor === null ? Promise.resolve(firstPage) : nextPage
    )
    return releaseNextPage
  }

  it("keeps the loaded cache untouched when reconciliation changed nothing", async () => {
    const current = infiniteData([
      [backupRun(firstId, 20)],
      [backupRun(secondId, 10)],
    ])
    const runs = mountedRuns(current)
    serveFirstPage(structuredClone(current.pages[0]!))

    await runs.refresh()

    expect(runs.data()).toBe(current)
  })

  it("updates stable first-page rows without discarding later pages", async () => {
    const current = infiniteData([
      [backupRun(firstId, 20)],
      [backupRun(secondId, 10)],
    ])
    const refreshed = {
      ...current.pages[0]!,
      items: [{ ...current.pages[0]!.items[0]!, taskBytesCompleted: 5 }],
    }
    const runs = mountedRuns(current)
    serveFirstPage(refreshed)

    await runs.refresh()

    expect(runs.data()?.pages).toHaveLength(2)
    expect(runs.data()?.pages[0]).toEqual(refreshed)
    expect(runs.data()?.pages[1]).toBe(current.pages[1])
  })

  it("resets an invalid cursor chain when first-page membership changes", async () => {
    const current = infiniteData([
      [backupRun(firstId, 20)],
      [backupRun(secondId, 10)],
    ])
    const refreshed = {
      items: [backupRun(replacementId, 30)],
      nextCursor: "replacement-page-2",
    }
    const runs = mountedRuns(current)
    serveFirstPage(refreshed)

    await runs.refresh()

    expect(runs.data()).toEqual({ pageParams: [null], pages: [refreshed] })
  })

  it("drops a page still loading from a replaced cursor chain", async () => {
    const current = infiniteData([
      [backupRun(firstId, 20)],
      [backupRun(secondId, 10)],
    ])
    current.pages[1]!.nextCursor = "page-2"
    const refreshed = {
      items: [backupRun(replacementId, 30)],
      nextCursor: "replacement-page-2",
    }
    const runs = mountedRuns(current)
    const releaseNextPage = serveFirstPage(refreshed)
    const loadingNextPage = runs.observer.fetchNextPage()

    await runs.refresh()
    releaseNextPage({ items: [backupRun(thirdId, 5)], nextCursor: null })
    await loadingNextPage

    expect(runs.data()).toEqual({ pageParams: [null], pages: [refreshed] })
  })

  it("keeps a page still loading when the first page boundary is unchanged", async () => {
    const current = infiniteData([
      [backupRun(firstId, 20)],
      [backupRun(secondId, 10)],
    ])
    current.pages[1]!.nextCursor = "page-2"
    const refreshed = {
      ...current.pages[0]!,
      items: [{ ...current.pages[0]!.items[0]!, taskBytesCompleted: 5 }],
    }
    const runs = mountedRuns(current)
    const releaseNextPage = serveFirstPage(refreshed)
    const loadingNextPage = runs.observer.fetchNextPage()

    await runs.refresh()
    releaseNextPage({ items: [backupRun(thirdId, 5)], nextCursor: null })
    await loadingNextPage

    expect(
      runs.data()?.pages.flatMap((page) => page.items.map(({ id }) => id))
    ).toEqual([firstId, secondId, thirdId])
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
