import { createFileRoute } from "@tanstack/react-router"

import { BackupDestinationsPage } from "@/components/backups-page"
import { backupStorageQueryOptions } from "@/lib/query-options"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/backups/destinations")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(backupStorageQueryOptions()),
  head: () => ({ meta: [{ title: pageTitle("Backup Destinations") }] }),
  component: BackupDestinationsPage,
})
