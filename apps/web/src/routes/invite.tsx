import { ResourceInvitationDialog } from "@/components/resource-invitation-dialog"
import { isAccountEnabled, isAccountVerified } from "@/lib/account-policy"
import { invitationInfrastructureHref } from "@/lib/resource-invitation-query"
import { getResourceInvitation } from "@/server/resource-access"
import { useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router"
import { z } from "zod"

import { InvitationPage } from "@/components/invitation-page"
import { recoverPromise } from "@/effect/promise"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  invitationReferencePath,
  invitePath,
  type InvitationReference,
} from "@/lib/invitation-auth"
import { pageTitle } from "@/lib/page-title"
import { invitationPreviewQueryOptions } from "@/lib/query-options"
import { getAuthState } from "@/server/auth"

// Drops a malformed secret rather than failing the whole page.
const secret = (min: number, max: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.length >= min && value.length <= max
        ? value
        : undefined,
    z.string().min(min).max(max).optional()
  )

const invitationSearchSchema = z.object({
  id: z.uuid().optional(),
  key: secret(32, 128),
  token: secret(32, 256),
})

export const Route = createFileRoute("/invite")({
  validateSearch: invitationSearchSchema,
  loaderDeps: ({ search }) => ({
    id: search.id,
    key: search.key,
    token: search.token,
  }),
  beforeLoad: async ({ context, search }) => {
    const state = await getAuthState()
    const token = search.token
    if (search.id) {
      const returnPath = search.key
        ? invitationReferencePath({ id: search.id, key: search.key })
        : `/invite?id=${encodeURIComponent(search.id)}`
      if (!state.user) {
        const preview = search.key
          ? await recoverPromise(
              () =>
                context.queryClient.ensureQueryData(
                  invitationPreviewQueryOptions({
                    id: search.id!,
                    key: search.key!,
                  })
                ),
              () => null
            )
          : null
        // A new person sets up their account right here.
        if (preview && !preview.accountExists) return state
        throw redirect({
          to: "/",
          search: { email: preview?.email, redirect: returnPath },
        })
      }
      if (!isAccountEnabled(state.user) || !isAccountVerified(state.user))
        throw redirect({
          to: "/account-status",
          search: { redirect: returnPath },
        })
      const invitation = await recoverPromise(
        () => getResourceInvitation({ data: { id: search.id! } }),
        () => null
      )
      // Let the invitation dialog show its unavailable/error state and close
      // action when this account cannot load the invitation.
      if (invitation?.pending)
        throw redirect({
          href: invitationInfrastructureHref(invitation),
          replace: true,
        })
      return state
    }
    if (!token) return state
    if (state.user) {
      if (!isAccountEnabled(state.user) || !isAccountVerified(state.user))
        throw redirect({
          to: "/account-status",
          search: { redirect: invitePath(token) },
        })
      const scoped = await recoverPromise(
        () => getResourceInvitation({ data: { token } }),
        () => null
      )
      if (scoped)
        throw redirect({
          href: scoped.pending
            ? invitationInfrastructureHref(scoped)
            : `/invite?id=${encodeURIComponent(scoped.id)}`,
          replace: true,
        })
      return state
    }
    const preview = await recoverPromise(
      () =>
        context.queryClient.ensureQueryData(
          invitationPreviewQueryOptions({ token })
        ),
      () => null
    )
    // A new person sets up their account right here.
    if (!preview || !preview.accountExists) return state
    throw redirect({
      to: "/",
      search: {
        email: preview.email,
        redirect: invitePath(token),
      },
    })
  },
  loader: ({ context, deps }) => {
    const reference = pageReference(deps, context.user)
    return reference
      ? context.queryClient.ensureQueryData(
          invitationPreviewQueryOptions(reference)
        )
      : null
  },
  head: () => ({
    meta: [
      { title: pageTitle("Invitation") },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  headers: () => ({ "Cache-Control": "no-store" }),
  component: InviteRoute,
})

// The invitation this page shows itself, rather than the resource dialog a
// signed-in recipient gets for an emailed link.
function pageReference(
  search: { id?: string; key?: string; token?: string },
  user: AuthenticatedUser | null
): InvitationReference | null {
  if (search.id)
    return search.key && !user ? { id: search.id, key: search.key } : null
  return search.token ? { token: search.token } : null
}

function InviteRoute() {
  const search = Route.useSearch()
  const { user } = Route.useRouteContext()
  const navigate = useNavigate()
  if (search.id && user)
    return (
      <ResourceInvitationDialog
        invitationId={search.id}
        onClose={() => void navigate({ to: "/" })}
      />
    )
  const reference = pageReference(search, user)
  if (!reference) {
    return <InvitationPage preview={null} reference={null} user={user} />
  }
  return <InvitationWithReference reference={reference} user={user} />
}

function InvitationWithReference({
  reference,
  user,
}: {
  reference: InvitationReference
  user: AuthenticatedUser | null
}) {
  const { data: preview } = useSuspenseQuery(
    invitationPreviewQueryOptions(reference)
  )
  return <InvitationPage preview={preview} reference={reference} user={user} />
}
