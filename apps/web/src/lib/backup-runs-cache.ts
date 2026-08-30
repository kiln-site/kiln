import {
  type InfiniteData,
  type QueryKey,
  type QueryClient,
  replaceEqualDeep,
} from "@tanstack/react-query"

import type {
  BackupRun,
  BackupRunsPage,
  BackupRunsQuery,
} from "@/lib/backup-runs"
import {
  backupRunsInputFromQueryKey,
  backupRunsQueryKey,
  normalizeBackupRunsQuery,
} from "@/lib/backup-runs"
import { getBackupRunsPage } from "@/server/backups"

export async function resetBackupRunsToFirstPage(
  queryClient: QueryClient,
  input: BackupRunsQuery,
  signal?: AbortSignal
): Promise<void> {
  const normalized = normalizeBackupRunsQuery(input)
  const { cursor: _, ...query } = normalized
  const queryKey = backupRunsQueryKey(query)
  signal?.throwIfAborted()
  await queryClient.cancelQueries({ exact: true, queryKey }, { silent: true })
  signal?.throwIfAborted()
  const firstPage = await getBackupRunsPage({
    data: { ...query, cursor: null },
    signal,
  })
  signal?.throwIfAborted()
  queryClient.setQueryData<InfiniteData<BackupRunsPage, string | null>>(
    queryKey,
    { pageParams: [null], pages: [firstPage] }
  )
}

export async function resetActiveBackupRunsToFirstPage(
  queryClient: QueryClient,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const active = queryClient
    .getQueryCache()
    .findAll({ queryKey: ["backups", "runs"], type: "active" })
  await Promise.all(
    active.flatMap((query) => {
      const input = backupRunsInputFromQueryKey(query.queryKey)
      return input
        ? [resetBackupRunsToFirstPage(queryClient, input, signal)]
        : []
    })
  )
}

export async function refreshActiveBackupRunsFirstPages(
  queryClient: QueryClient,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const active = queryClient
    .getQueryCache()
    .findAll({ queryKey: ["backups", "runs"], type: "active" })
  await Promise.all(
    active.flatMap((query) => {
      const input = backupRunsInputFromQueryKey(query.queryKey)
      return input
        ? [refreshBackupRunsFirstPage(queryClient, input, signal)]
        : []
    })
  )
}

async function refreshBackupRunsFirstPage(
  queryClient: QueryClient,
  input: BackupRunsQuery,
  signal?: AbortSignal
): Promise<void> {
  const normalized = normalizeBackupRunsQuery(input)
  const { cursor: _, ...query } = normalized
  const queryKey = backupRunsQueryKey(query)
  signal?.throwIfAborted()
  const firstPage = await getBackupRunsPage({
    data: { ...query, cursor: null },
    signal,
  })
  await commitRefreshedBackupRunsFirstPage(
    queryClient,
    queryKey,
    firstPage,
    signal
  )
}

export async function commitRefreshedBackupRunsFirstPage(
  queryClient: QueryClient,
  queryKey: QueryKey,
  firstPage: BackupRunsPage,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const current = queryClient.getQueryData<
    InfiniteData<BackupRunsPage, string | null>
  >(queryKey)
  if (!backupRunsFirstPageBoundaryIsStable(current, firstPage)) {
    await queryClient.cancelQueries({ exact: true, queryKey }, { silent: true })
  }
  signal?.throwIfAborted()
  queryClient.setQueryData<InfiniteData<BackupRunsPage, string | null>>(
    queryKey,
    (latest) => mergeRefreshedBackupRunsFirstPage(latest, firstPage)
  )
}

export function mergeRefreshedBackupRunsFirstPage(
  current: InfiniteData<BackupRunsPage, string | null> | undefined,
  firstPage: BackupRunsPage
): InfiniteData<BackupRunsPage, string | null> {
  if (!current || current.pages.length === 0) {
    return { pageParams: [null], pages: [firstPage] }
  }
  const currentFirstPage = current.pages[0]
  const refreshedFirstPage = replaceEqualDeep(currentFirstPage, firstPage)
  if (refreshedFirstPage === currentFirstPage) return current

  if (backupRunsFirstPageBoundaryIsStable(current, refreshedFirstPage)) {
    return {
      ...current,
      pages: [refreshedFirstPage, ...current.pages.slice(1)],
    }
  }
  return { pageParams: [null], pages: [refreshedFirstPage] }
}

function backupRunsFirstPageBoundaryIsStable(
  current: InfiniteData<BackupRunsPage, string | null> | undefined,
  refreshedFirstPage: BackupRunsPage
): boolean {
  const currentFirstPage = current?.pages[0]
  return Boolean(
    currentFirstPage &&
    currentFirstPage.nextCursor === refreshedFirstPage.nextCursor &&
    currentFirstPage.items.length === refreshedFirstPage.items.length &&
    currentFirstPage.items.every(
      (backup, index) => backup.id === refreshedFirstPage.items[index]?.id
    )
  )
}

export type BackupRunPatch =
  | { kind: "noop" }
  | { kind: "reset" }
  | {
      data: InfiniteData<BackupRunsPage, string | null>
      kind: "update"
    }

export function patchBackupRunsData(
  data: InfiniteData<BackupRunsPage, string | null> | undefined,
  backupId: string,
  replacement: BackupRun | null,
  sort: BackupRunsQuery["sort"]
): BackupRunPatch {
  if (!data || data.pages.length === 0) {
    return replacement ? { kind: "reset" } : { kind: "noop" }
  }
  const existing = findBackupRun(data.pages, backupId)
  if (!existing) {
    return replacement ? { kind: "reset" } : { kind: "noop" }
  }
  if (!replacement) {
    const pages = data.pages.map((page) => ({
      ...page,
      items: page.items.filter((backup) => backup.id !== backupId),
    }))
    const pageParams = [...data.pageParams]
    while (pages.length > 1 && pages.at(-1)?.items.length === 0) {
      pages.pop()
      pageParams.pop()
    }
    if (
      pages.every((page) => page.items.length === 0) &&
      pages.some((page) => page.nextCursor !== null)
    ) {
      return { kind: "reset" }
    }
    return { data: { pageParams, pages }, kind: "update" }
  }
  const orderChanged = existing.orderKey.value !== replacement.orderKey.value
  const canPatchChangedOrder = sort === "size" && backupRunIsActive(replacement)
  if (orderChanged && sort !== "createdAt" && !canPatchChangedOrder) {
    return { kind: "reset" }
  }
  return {
    data: {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.map((backup) =>
          backup.id === replacement.id ? replacement : backup
        ),
      })),
    },
    kind: "update",
  }
}

function findBackupRun(
  pages: ReadonlyArray<BackupRunsPage>,
  backupId: string
): BackupRun | null {
  for (const page of pages) {
    const backup = page.items.find((candidate) => candidate.id === backupId)
    if (backup) return backup
  }
  return null
}

function backupRunIsActive(backup: BackupRun): boolean {
  return (
    ["queued", "running", "deleting"].includes(backup.status) ||
    (backup.status === "available" &&
      ["queued", "running"].includes(backup.taskStatus)) ||
    backup.artifacts.some((artifact) =>
      ["queued", "running", "deleting"].includes(artifact.status)
    )
  )
}
