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

import { useInfraUpdateDialogStore } from "@/components/infra-update-dialog-provider"
import { accessibleInfrastructureDestinations } from "@/lib/navigation-destinations"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

export const InfraShell = React.memo(function InfraShell({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-full bg-background">
      <header className="mx-auto w-full max-w-[90rem] px-3 pt-3 sm:px-5">
        <InfraNavigation />
      </header>
      <div data-slot="infra-content" className="[contain:paint]">
        {children}
      </div>
    </div>
  )
})

export function InfraRouteOutlet() {
  return <Outlet />
}

const InfraNavigation = React.memo(function InfraNavigation() {
  const store = useInfraUpdateDialogStore()
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  const destinations = accessibleInfrastructureDestinations(capabilities)

  return (
    <div className="mb-6 flex min-w-0 items-center gap-2 border-b">
      <nav
        aria-label="Infrastructure sections"
        className="no-scrollbar flex min-w-0 flex-1 gap-1 overflow-x-auto overflow-y-hidden"
      >
        {destinations.map((tab) => (
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
      {capabilities.canUpdateRelays ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Review system updates"
              className="mb-1 h-8 shrink-0 px-2 sm:px-2.5"
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
      ) : null}
    </div>
  )
})
