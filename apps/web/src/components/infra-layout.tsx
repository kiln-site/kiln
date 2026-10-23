import * as React from "react"
import { useSuspenseQuery } from "@tanstack/react-query"
import { Link, Outlet } from "@tanstack/react-router"
import { CloudDownload } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import { HearthMark } from "@/components/hearth-mark"
import { useInfraUpdateDialogStore } from "@/components/infra-update-dialog-provider"
import { SectionNavigation } from "@/components/section-navigation"
import { accessibleInfrastructureDestinations } from "@/lib/navigation-destinations"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

export const InfraShell = React.memo(function InfraShell({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="mx-auto w-full max-w-[90rem] shrink-0 px-3 pt-3 sm:px-5">
        <InfraNavigation />
      </header>
      <div
        data-slot="infra-content"
        className="min-h-0 flex-1 overflow-y-auto [contain:paint]"
      >
        {children}
      </div>
    </div>
  )
})

export function InfraRouteOutlet() {
  return <Outlet />
}

const InfraNavigation = React.memo(function InfraNavigation() {
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  const destinations = accessibleInfrastructureDestinations(capabilities)

  return (
    <SectionNavigation
      className="mb-6"
      label="Infrastructure sections"
      sections={destinations}
      title="Infrastructure"
      renderLink={(tab, props) => <Link to={tab.to} {...props} />}
    />
  )
})

export const InfraToolbarActions = React.memo(function InfraToolbarActions() {
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  if (!capabilities.isPlatformAdmin && !capabilities.canUpdateRelays) {
    return null
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      {capabilities.isPlatformAdmin ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              className="h-9 w-9 shrink-0 gap-1.5 bg-card px-0 text-xs shadow-none sm:w-auto sm:px-3"
              size="sm"
              variant="outline"
            >
              <Link aria-label="Open Kiln's services" to="/kiln/info">
                <HearthMark className="size-4" />
                <span className="hidden sm:inline">Kiln</span>
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Hearth, its database, and the Traefik in front of them
          </TooltipContent>
        </Tooltip>
      ) : null}
      {capabilities.canUpdateRelays ? <InfraUpdatesButton /> : null}
    </div>
  )
})

// Opens the updates review, here and on Kiln's own pages.
export function InfraUpdatesButton({
  className = "h-9 w-9 shrink-0 gap-1.5 bg-card px-0 text-xs shadow-none sm:w-[6.5rem] sm:px-3",
}: {
  className?: string
}) {
  const store = useInfraUpdateDialogStore()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label="Review system updates"
          className={className}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => store.open()}
        >
          <CloudDownload />
          <span className="hidden sm:inline">Updates</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Review system updates
      </TooltipContent>
    </Tooltip>
  )
}
