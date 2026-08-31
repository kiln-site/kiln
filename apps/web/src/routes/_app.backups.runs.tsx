import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"

import { BackupsPage } from "@/components/backups-page"
import {
  createBackupSearchStore,
  type BackupFilters,
} from "@/components/backups/state"
import {
  backupStorageQueryOptions,
  accessCapabilitiesQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/backups/runs")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(backupStorageQueryOptions()),
      context.queryClient.ensureQueryData(accessCapabilitiesQueryOptions()),
      context.queryClient.ensureQueryData(relaySnapshotQueryOptions()),
      context.queryClient.ensureQueryData(
        managedDatabaseDirectoryQueryOptions()
      ),
    ])
  },
  head: () => ({ meta: [{ title: pageTitle("Backup Runs") }] }),
  component: BackupRunsRoute,
})

function BackupRunsRoute() {
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
