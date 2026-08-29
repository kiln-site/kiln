import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"

import { BackupSettingsPage } from "@/components/backups-page"
import type { BackupFilters } from "@/components/backups/state"
import {
  backupStorageQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/backups/settings")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(backupStorageQueryOptions()),
      context.queryClient.ensureQueryData(relaySnapshotQueryOptions()),
      context.queryClient.ensureQueryData(
        managedDatabaseDirectoryQueryOptions()
      ),
    ])
  },
  head: () => ({ meta: [{ title: pageTitle("Backup Settings") }] }),
  component: BackupSettingsRoute,
})

function BackupSettingsRoute() {
  const filters = Route.useSearch()
  const navigate = Route.useNavigate()
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
    <BackupSettingsPage filters={filters} onFiltersChange={updateFilters} />
  )
}
