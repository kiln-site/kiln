import * as React from "react"
import { Link, Outlet } from "@tanstack/react-router"
import { CloudCog, History, SlidersHorizontal } from "lucide-react"

import { SectionNavigation } from "@/components/section-navigation"

const backupDestinations = [
  { icon: History, label: "Runs", to: "/backups/runs" },
  { icon: CloudCog, label: "Destinations", to: "/backups/destinations" },
  { icon: SlidersHorizontal, label: "Settings", to: "/backups/settings" },
] as const

export const BackupsShell = React.memo(function BackupsShell({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="mx-auto w-full max-w-[90rem] shrink-0 px-3 pt-3 sm:px-5">
        <BackupsNavigation />
      </header>
      <div
        data-slot="backups-content"
        className="min-h-0 flex-1 overflow-y-auto [contain:paint]"
      >
        {children}
      </div>
    </div>
  )
})

export function BackupsRouteOutlet() {
  return <Outlet />
}

const BackupsNavigation = React.memo(function BackupsNavigation() {
  return (
    <SectionNavigation
      className="mb-6"
      label="Backup sections"
      sections={backupDestinations}
      title="Backups"
      renderLink={(tab, props) => (
        <Link
          to={tab.to}
          activeOptions={{ exact: true, includeSearch: false }}
          search={(previous) => ({
            kind: previous.kind,
            relay: previous.relay,
            server: previous.server,
          })}
          {...props}
        />
      )}
    />
  )
})
