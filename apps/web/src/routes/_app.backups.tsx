import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import {
  BackupsPage,
  createBackupSearchStore,
  type BackupFilters,
} from "@/components/backups-page"
import {
  backupStorageQueryOptions,
  backupsQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import { pageTitle } from "@/lib/page-title"
import { requireGlobalDestinationAccess } from "@/lib/route-access"

const backupSearchSchema = z.object({
  kind: z.enum(["database", "relay", "server"]).optional(),
  relay: z.string().max(120).optional(),
  search: z.string().max(160).optional(),
  server: z.string().max(120).optional(),
  status: z.enum(["available", "active", "failed"]).optional(),
})

export const Route = createFileRoute("/_app/backups")({
  validateSearch: backupSearchSchema,
  beforeLoad: async ({ context }) => {
    await requireGlobalDestinationAccess(context.queryClient, "backups")
  },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(backupsQueryOptions()),
      context.queryClient.ensureQueryData(backupStorageQueryOptions()),
      context.queryClient.ensureQueryData(relaySnapshotQueryOptions()),
      context.queryClient.ensureQueryData(
        managedDatabaseDirectoryQueryOptions()
      ),
    ])
  },
  head: () => ({ meta: [{ title: pageTitle("Backups") }] }),
  component: BackupsRoute,
})

function BackupsRoute() {
  const filters = Route.useSearch()
  const navigate = Route.useNavigate()
  const [searchStore] = React.useState(() =>
    createBackupSearchStore(filters.search ?? "")
  )

  React.useLayoutEffect(() => {
    searchStore.set(filters.search ?? "")
  }, [filters.search, searchStore])

  const updateFilters = React.useCallback(
    (change: Partial<BackupFilters>) => {
      void navigate({
        replace: true,
        search: (previous) => ({ ...previous, ...change }),
      })
    },
    [navigate]
  )

  return (
    <BackupsPage
      filters={filters}
      searchStore={searchStore}
      onFiltersChange={updateFilters}
    />
  )
}
