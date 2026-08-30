import type { InfiniteData, QueryClient } from "@tanstack/react-query"

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
  input: BackupRunsQuery
): Promise<void> {
  const normalized = normalizeBackupRunsQuery(input)
  const { cursor: _, ...query } = normalized
  const queryKey = backupRunsQueryKey(query)
  await queryClient.cancelQueries({ exact: true, queryKey }, { silent: true })
  const firstPage = await getBackupRunsPage({
    data: { ...query, cursor: null },
  })
  queryClient.setQueryData<InfiniteData<BackupRunsPage, string | null>>(
    queryKey,
    { pageParams: [null], pages: [firstPage] }
  )
}

export async function resetActiveBackupRunsToFirstPage(
  queryClient: QueryClient
): Promise<void> {
  const active = queryClient
    .getQueryCache()
    .findAll({ queryKey: ["backups", "runs"], type: "active" })
  await Promise.all(
    active.flatMap((query) => {
      const input = backupRunsInputFromQueryKey(query.queryKey)
      return input ? [resetBackupRunsToFirstPage(queryClient, input)] : []
    })
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
