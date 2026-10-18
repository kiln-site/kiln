import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { GitHubSyncPage } from "@/components/github-sync-page"
import { githubSyncOverviewQueryOptions } from "@/lib/query-options"
import { pageTitle } from "@/lib/page-title"

// Where GitHub's setup redirects land, with the outcome to show once.
const syncSearchSchema = z.object({
  connected: z.uuid().optional(),
  githubError: z.string().max(300).optional(),
})

export const Route = createFileRoute("/_app/automations/sync")({
  validateSearch: syncSearchSchema,
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(githubSyncOverviewQueryOptions())
  },
  head: () => ({ meta: [{ title: pageTitle("Sync") }] }),
  component: GitHubSyncPage,
})
