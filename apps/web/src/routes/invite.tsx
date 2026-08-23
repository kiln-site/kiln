import { useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { z } from "zod"

import { InvitationPage } from "@/components/invitation-page"
import { recoverPromise } from "@/effect/promise"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { invitePath } from "@/lib/invitation-auth"
import { pageTitle } from "@/lib/page-title"
import { invitationPreviewQueryOptions } from "@/lib/query-options"
import { getInvitationPreview } from "@/server/access"
import { getAuthState } from "@/server/auth"

const invitationSearchSchema = z.object({
  token: z.preprocess(
    (value) =>
      typeof value === "string" && value.length >= 32 && value.length <= 256
        ? value
        : undefined,
    z.string().min(32).max(256).optional()
  ),
})

export const Route = createFileRoute("/invite")({
  validateSearch: invitationSearchSchema,
  loaderDeps: ({ search }) => ({ token: search.token }),
  beforeLoad: async ({ search }) => {
    const state = await getAuthState()
    const token = search.token
    if (!token || state.user) return state
    const preview = await recoverPromise(
      () => getInvitationPreview({ data: { token } }),
      () => null
    )
    if (!preview) return state
    throw redirect({
      to: "/",
      search: {
        email: preview.email,
        redirect: invitePath(token),
      },
    })
  },
  loader: ({ context, deps }) =>
    deps.token
      ? context.queryClient.ensureQueryData(
          invitationPreviewQueryOptions(deps.token)
        )
      : null,
  head: () => ({ meta: [{ title: pageTitle("Invitation") }] }),
  component: InviteRoute,
})

function InviteRoute() {
  const { token } = Route.useSearch()
  const { user } = Route.useRouteContext()
  if (!token) {
    return <InvitationPage preview={null} token="" user={user} />
  }
  return <InvitationWithToken token={token} user={user} />
}

function InvitationWithToken({
  token,
  user,
}: {
  token: string
  user: AuthenticatedUser | null
}) {
  const { data: preview } = useSuspenseQuery(
    invitationPreviewQueryOptions(token)
  )
  return <InvitationPage preview={preview} token={token} user={user} />
}
