import { createFileRoute } from "@tanstack/react-router"

import { ScheduleHistoryPage } from "@/components/schedules-page"
import {
  githubSyncRunsQueryOptions,
  schedulesQueryOptions,
} from "@/lib/query-options"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/automations/history")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(schedulesQueryOptions()),
      context.queryClient.ensureQueryData(githubSyncRunsQueryOptions()),
    ])
  },
  head: () => ({ meta: [{ title: pageTitle("Automation History") }] }),
  component: ScheduleHistoryPage,
})
