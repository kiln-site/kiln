import * as React from "react"
import { Link, Outlet } from "@tanstack/react-router"

import { SectionNavigation } from "@/components/section-navigation"
import { settingsDestinations } from "@/lib/navigation-destinations"

export const SettingsShell = React.memo(function SettingsShell({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-full flex-col bg-background lg:has-[[data-settings-fill]]:h-full">
      <header className="mx-auto w-full max-w-[90rem] shrink-0 px-3 pt-3 sm:px-5">
        <SettingsNavigation />
      </header>
      <div
        data-slot="settings-content"
        className="min-h-0 flex-1 [contain:paint]"
      >
        {children}
      </div>
    </div>
  )
})

export function SettingsRouteOutlet() {
  return <Outlet />
}

const SettingsNavigation = React.memo(function SettingsNavigation() {
  return (
    <SectionNavigation
      label="Settings sections"
      sections={settingsDestinations}
      title="Settings"
      renderLink={(tab, props) => <Link to={tab.to} {...props} />}
    />
  )
})
