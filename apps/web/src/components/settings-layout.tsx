import * as React from "react"
import { Link, Outlet } from "@tanstack/react-router"

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
    <nav
      aria-label="Settings sections"
      className="flex gap-1 overflow-x-auto overflow-y-hidden border-b"
    >
      {settingsDestinations.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          className="relative flex h-10 shrink-0 items-center gap-2 px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          activeProps={{
            className:
              "text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary",
          }}
        >
          <tab.icon className="size-3.5" />
          {tab.label}
        </Link>
      ))}
    </nav>
  )
})
