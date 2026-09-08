import { firstAccessibleAppHref } from "@/lib/navigation-destinations"
import { isAccountEnabled, isAccountVerified } from "@/lib/account-policy"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { z } from "zod"

import { AuthPage } from "@/components/auth-page"
import { recoverPromise } from "@/effect/promise"
import { inviteTokenFromRedirect } from "@/lib/invitation-auth"
import { pageTitle } from "@/lib/page-title"
import {
  accessCapabilitiesQueryOptions,
  relayConnectionQueryOptions,
} from "@/lib/query-options"
import {
  relayInstanceRouteIdentifier,
  resolveCanonicalRelayInstance,
  resolveRelayInstance,
} from "@/lib/relay-selectors"
import { getInvitationPreview } from "@/server/access"
import { getAuthState } from "@/server/auth"
import { getUiPreferences } from "@/server/preferences"

export const Route = createFileRoute("/")({
  validateSearch: z.object({
    email: z.string().optional(),
    forgot: z.union([z.literal(true), z.literal("true")]).optional(),
    redirect: z.string().optional(),
    signup: z.union([z.literal(true), z.literal("true")]).optional(),
    verified: z.union([z.literal(true), z.literal("true")]).optional(),
  }),
  beforeLoad: async ({ context, search }) => {
    const state = await getAuthState()
    if (!state.user) {
      const token = inviteTokenFromRedirect(search.redirect)
      const invitation = token
        ? await recoverPromise(
            () => getInvitationPreview({ data: { token } }),
            () => null
          )
        : null
      const invitationSignup = Boolean(invitation && !invitation.accountExists)
      return {
        ...state,
        invitationEmail: invitation?.email,
        invitationSignup,
      }
    }
    if (!isAccountEnabled(state.user) || !isAccountVerified(state.user)) {
      throw redirect({
        to: "/account-status",
        search: { redirect: search.redirect },
      })
    }
    if (search.redirect?.startsWith("/")) {
      throw redirect({ href: search.redirect })
    }
    const capabilities = await context.queryClient.ensureQueryData(
      accessCapabilitiesQueryOptions()
    )
    if (
      !capabilities.isPlatformAdmin &&
      !capabilities.canManageRelays &&
      capabilities.grants.length === 0
    ) {
      throw redirect({ href: firstAccessibleAppHref(capabilities) })
    }
    const [connection, uiPreferences] = await Promise.all([
      context.queryClient.ensureQueryData(
        relayConnectionQueryOptions(context.queryClient)
      ),
      getUiPreferences(),
    ])
    if (connection.status !== "connected") {
      if (
        state.user.isDevelopmentBypass ||
        state.user.role === "admin" ||
        state.user.role === "relay_creator"
      ) {
        throw redirect({ to: "/infra/relays" })
      }
      throw redirect({ href: firstAccessibleAppHref(capabilities) })
    }
    const instances = connection.snapshot.instances
    const rememberedResolution = resolveCanonicalRelayInstance(
      instances,
      uiPreferences.selectedInstanceRouteId
    )
    const rememberedAliasResolution = resolveRelayInstance(
      instances,
      uiPreferences.selectedInstanceRouteId
    )
    const rememberedInstance =
      rememberedResolution.status === "found"
        ? rememberedResolution.instance
        : null
    const rememberedRouteIdentifier = rememberedInstance
      ? relayInstanceRouteIdentifier(instances, rememberedInstance)
      : null
    if (!rememberedInstance || !rememberedRouteIdentifier) {
      const collisionSearch =
        rememberedResolution.status === "ambiguous"
          ? rememberedAliasResolution.status === "found"
            ? rememberedAliasResolution.instance.shortId
            : uiPreferences.selectedInstanceRouteId
          : null
      throw redirect({
        href: collisionSearch
          ? `/infra/servers?search=${encodeURIComponent(collisionSearch)}`
          : "/infra/servers",
      })
    }
    throw redirect({
      to: "/server/$serverId/console",
      params: {
        serverId: rememberedRouteIdentifier,
      },
    })
  },
  head: ({ match }) => ({
    meta: [
      {
        title: pageTitle(
          match.context.invitationSignup ? "Create Account" : "Sign In"
        ),
      },
    ],
  }),
  component: LoginRoute,
})

function LoginRoute() {
  const search = Route.useSearch()
  const {
    developmentBypassEnabled,
    emailDeliveryEnabled,
    invitationEmail,
    invitationSignup,
    setupRequired,
    signupEnabled,
  } = Route.useRouteContext()
  return (
    <AuthPage
      key={`${invitationEmail ?? ""}:${invitationSignup ? "signup" : "signin"}:${search.forgot ? "forgot" : ""}`}
      developmentBypassEnabled={developmentBypassEnabled}
      emailDeliveryEnabled={emailDeliveryEnabled}
      initialEmail={invitationEmail ?? search.email}
      lockedEmail={invitationEmail}
      forgotPassword={Boolean(search.forgot)}
      redirectPath={search.redirect}
      setupRequired={setupRequired}
      signupEnabled={signupEnabled || invitationSignup}
      startWithSignup={invitationSignup}
      verified={Boolean(search.verified)}
    />
  )
}
