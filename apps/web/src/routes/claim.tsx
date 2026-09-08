import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { AccountClaimPage } from "@/components/account-claim-page"
import { getAccountClaimPreview } from "@/server/users"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/claim")({
  validateSearch: (search: Record<string, unknown>) => {
    const result = z
      .object({
        token: z.string().regex(/^[a-f0-9]{64}$/u),
        redirect: z.string().max(2048).optional(),
      })
      .safeParse(search)
    return result.success ? result.data : { token: "" }
  },
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: ({ deps }) =>
    deps.token ? getAccountClaimPreview({ data: { token: deps.token } }) : null,
  head: () => ({
    meta: [
      { title: pageTitle("Claim Account") },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  headers: () => ({ "Cache-Control": "no-store" }),
  component: ClaimRoute,
})
function ClaimRoute() {
  const search = Route.useSearch()
  const claim = Route.useLoaderData()
  return (
    <AccountClaimPage
      key={search.token}
      token={search.token}
      email={claim?.email}
      redirectPath={search.redirect}
    />
  )
}
