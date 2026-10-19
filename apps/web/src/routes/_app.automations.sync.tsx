import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { GitHubSyncPage } from "@/components/github-sync-page"
import { githubSyncOverviewQueryOptions } from "@/lib/query-options"
import { pageTitle } from "@/lib/page-title"

// Opens Add sync, from Sources with that source chosen.
const syncSearchSchema = z.object({
  create: z.boolean().optional(),
  source: z.uuid().optional(),
})

export const Route = createFileRoute("/_app/automations/sync")({
  validateSearch: syncSearchSchema,
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(githubSyncOverviewQueryOptions())
  },
  head: () => ({ meta: [{ title: pageTitle("Sync") }] }),
  component: GitHubSyncPage,
})
