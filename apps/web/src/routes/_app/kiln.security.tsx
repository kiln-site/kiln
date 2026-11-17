import * as React from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { z } from "zod"

import { SecurityPage } from "@/components/security-page"
import { pageTitle } from "@/lib/page-title"
import { recoveryCodeStatusQueryOptions } from "@/lib/query-options"
import { securityScopeSchema } from "@/lib/security"
import { securityOverviewQueryOptions } from "@/lib/security-queries"

export const Route = createFileRoute("/_app/kiln/security")({
  // The resource the page narrows to, as the scope picker keys it, and
  // whether the recovery code's dialog is open, so the notification asking
  // for it opens it from any page, this one included.
  validateSearch: z.object({
    recoveryCode: z.literal("save").optional(),
    scope: securityScopeSchema.optional(),
  }),
  loaderDeps: ({ search }) => ({ scope: search.scope ?? null }),
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(securityOverviewQueryOptions(null)),
      context.queryClient.ensureQueryData(recoveryCodeStatusQueryOptions()),
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
  const { recoveryCode, scope } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const selectScope = React.useCallback(
    (next: string | null) =>
      void navigate({
        replace: true,
        search: (current) => ({
          recoveryCode: current.recoveryCode,
          scope: next ?? undefined,
        }),
      }),
    [navigate]
  )
  const setRecoveryCodeOpen = React.useCallback(
    (open: boolean) =>
      void navigate({
        replace: true,
        search: (current) => ({
          recoveryCode: open ? ("save" as const) : undefined,
          scope: current.scope,
        }),
      }),
    [navigate]
  )
  return (
    <SecurityPage
      recoveryCodeOpen={recoveryCode === "save"}
      scope={scope ?? null}
      onRecoveryCodeOpenChange={setRecoveryCodeOpen}
      onScopeChange={selectScope}
    />
  )
}
