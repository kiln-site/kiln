import { Matches, useRouterState } from "@tanstack/react-router"
import type { RouterState } from "@tanstack/react-router"

import { AppDocument } from "@/components/app-document"
import { AppRouterErrorBoundary } from "@/components/app-error-page"
import { AppFrame } from "@/components/app-frame"
import { PageTimingMonitor } from "@/components/page-timing-monitor"
import { ServiceWorker } from "@/components/service-worker"
import { useFollowActiveAccount } from "@/components/use-follow-active-account"

export function AppRouterApplication() {
  const usesAppFrame = useRouterState({
    select: (state) =>
      state.matches.some((match) => match.routeId === "/_app"),
  })

  const userId = useRouterState({ select: selectSignedInUserId })

  return (
    <AppDocument>
      {userId ? <ActiveAccountFollower userId={userId} /> : null}
      <PageTimingMonitor />
      <ServiceWorker />
      <AppRouterErrorBoundary>
        {usesAppFrame ? (
          <AppFrame>
            <Matches />
          </AppFrame>
        ) : (
          <Matches />
        )}
      </AppRouterErrorBoundary>
    </AppDocument>
  )
}

// Any page loaded for a signed-in user names that user in its route context.
function selectSignedInUserId(state: RouterState): string | null {
  const context = state.matches.at(-1)?.context as
    | { user?: { id: string } | null }
    | undefined
  return context?.user?.id ?? null
}

/** Keeps this tab acting only as the account it renders. */
function ActiveAccountFollower({ userId }: { userId: string }) {
  useFollowActiveAccount(userId)
  return null
}
