import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { AccountClaimPage } from "@/components/account-claim-page"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/claim")({
  validateSearch: (search: Record<string, unknown>) => {
    const result = z
      .object({ token: z.string().regex(/^[a-f0-9]{64}$/u) })
      .safeParse(search)
    return result.success ? result.data : { token: "" }
  },
  head: () => ({
    meta: [
      { title: pageTitle("Claim Account") },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: ClaimRoute,
})
function ClaimRoute() {
  return <AccountClaimPage token={Route.useSearch().token} />
}
