import * as React from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { z } from "zod"

import { SecurityPage } from "@/components/security-page"
import { pageTitle } from "@/lib/page-title"
import { securityScopeSchema } from "@/lib/security"
import { securityOverviewQueryOptions } from "@/lib/security-queries"

export const Route = createFileRoute("/_app/kiln/security")({
  // The resource the page narrows to, as the scope picker keys it.
  validateSearch: z.object({ scope: securityScopeSchema.optional() }),
  loaderDeps: ({ search }) => ({ scope: search.scope ?? null }),
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(securityOverviewQueryOptions(null)),
      deps.scope
        ? context.queryClient.ensureQueryData(
            securityOverviewQueryOptions(deps.scope)
          )
        : null,
    ]),
  head: () => ({ meta: [{ title: pageTitle("Kiln Security") }] }),
  component: KilnSecurityRoute,
})

function KilnSecurityRoute() {
  const { scope } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const selectScope = React.useCallback(
    (next: string | null) =>
      void navigate({
        replace: true,
        search: next ? { scope: next } : {},
      }),
    [navigate]
  )
  return <SecurityPage scope={scope ?? null} onScopeChange={selectScope} />
}
