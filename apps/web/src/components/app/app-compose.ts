import { useQuery } from "@tanstack/react-query"
import type { AppSourceType } from "@workspace/contracts"

import { appDeploymentSummaryQueryOptions } from "@/lib/query-options"

/**
 * Whether the app runs a Compose file: a pasted one, or a repository's.
 * Compose files publish ports and name services themselves.
 */
export function useAppRunsCompose(
  app: { id: string; relayId: string },
  sourceType: AppSourceType
): boolean {
  const { data: build } = useQuery({
    ...appDeploymentSummaryQueryOptions(app.relayId, app.id),
    enabled: sourceType === "github",
    select: (summary) => summary.source?.build ?? null,
  })
  return sourceType === "compose" || build === "compose"
}
