import { Matches, useRouterState } from "@tanstack/react-router"

import { AppDocument } from "@/components/app-document"
import { AppRouterErrorBoundary } from "@/components/app-error-page"
import { AppFrame } from "@/components/app-frame"
import { PageTimingMonitor } from "@/components/page-timing-monitor"

export function AppRouterApplication() {
  const usesAppFrame = useRouterState({
    select: (state) =>
      state.matches.some((match) => match.routeId === "/_app"),
  })

  return (
    <AppDocument>
      <PageTimingMonitor />
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
