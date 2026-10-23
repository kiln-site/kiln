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
    <div className="min-h-full bg-background">
      <header className="mx-auto w-full max-w-[90rem] px-3 pt-3 sm:px-5">
        <SettingsNavigation />
      </header>
      <div data-slot="settings-content" className="[contain:paint]">
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
