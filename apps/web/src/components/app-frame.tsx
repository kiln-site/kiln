import * as React from "react"
import { useSuspenseQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"

import {
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from "@workspace/ui/components/sidebar"

import { AppRouteContent } from "@/components/app-route-content"
import { AppSidebar } from "@/components/app-sidebar"
import { InfraUpdateDialogProvider } from "@/components/infra-update-dialog-provider"
import { PanelFooter } from "@/components/panel-footer"
import { RealtimeSync } from "@/components/realtime-sync"
import { RelayConnectionToastMonitor } from "@/components/relay-connection-toast"
import { applyAppearance, saveAppearanceCache } from "@/lib/appearance"
import type { AppearancePreferences } from "@/lib/appearance"
import { uiPreferencesQueryOptions } from "@/lib/query-options"
import type { UiPreferences } from "@/lib/query-options"

function selectAppFramePreferences(preferences: UiPreferences) {
  return {
    appearance: preferences.appearance,
    selectedInstanceRouteId: preferences.selectedInstanceRouteId,
    sidebarOpen: preferences.sidebarOpen,
  }
}

export const AppFrame = React.memo(function AppFrame({
  children,
}: {
  children: React.ReactNode
}) {
  const { data: uiPreferences } = useSuspenseQuery({
    ...uiPreferencesQueryOptions(),
    select: selectAppFramePreferences,
  })

  return (
    <SidebarProvider defaultOpen={uiPreferences.sidebarOpen}>
      <AppearanceHydrator appearance={uiPreferences.appearance} />
      <InfraUpdateDialogProvider>
        <RealtimeSync />
        <RelayConnectionToastMonitor />
        <MobileSidebarNavigationDismiss />
        <AppSidebar
          initialSelectedInstanceRouteId={uiPreferences.selectedInstanceRouteId}
        />
        <SidebarInset className="h-dvh min-w-0 overflow-hidden">
          <div
            data-slot="app-content"
            className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <AppRouteContent>{children}</AppRouteContent>
          </div>
          <PanelFooter />
        </SidebarInset>
      </InfraUpdateDialogProvider>
    </SidebarProvider>
  )
})

const AppearanceHydrator = React.memo(function AppearanceHydrator({
  appearance,
}: {
  appearance: AppearancePreferences
}) {
  React.useEffect(() => {
    saveAppearanceCache(appearance)
    if (appearance.colorScheme !== "system") return

    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)")
    const applySystemAppearance = () => applyAppearance(appearance)
    colorScheme.addEventListener("change", applySystemAppearance)
    return () =>
      colorScheme.removeEventListener("change", applySystemAppearance)
  }, [appearance])
  return null
})

function MobileSidebarNavigationDismiss() {
  const { isMobile, setOpenMobile } = useSidebar()
  const router = useRouter()

  React.useEffect(() => {
    return router.subscribe("onBeforeNavigate", () => {
      if (isMobile) setOpenMobile(false)
    })
  }, [isMobile, router, setOpenMobile])

  return null
}
