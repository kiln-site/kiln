import * as React from "react"
import { useRouterState } from "@tanstack/react-router"

import { SidebarTrigger } from "@workspace/ui/components/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import type { GlobalSection } from "@/lib/route-sections"

type PageSection = Exclude<GlobalSection, null>

type GlobalPageToolbarProps =
  | { section: PageSection; title?: never }
  | { section?: never; title: string }

export const GlobalPageToolbar = React.memo(function GlobalPageToolbar({
  section,
  title,
}: GlobalPageToolbarProps) {
  return (
    <header className="shrink-0 border-b bg-background/90 backdrop-blur-xl">
      <div className="flex min-h-20 items-center gap-4 px-3 py-2 sm:px-5">
        <ToolbarSidebarTrigger />
        <span className="h-8 w-px shrink-0 bg-border/80" aria-hidden="true" />
        <PageTitle section={section} title={title} />
      </div>
    </header>
  )
})

const PageTitle = React.memo(function PageTitle({
  section,
  title,
}: {
  section?: PageSection
  title?: string
}) {
  const pageTitle = title ?? (section ? sectionTitles[section] : "Hearth")

  return (
    <h1 className="flex min-w-0 flex-1 items-baseline gap-2 font-heading tracking-[-0.035em]">
      <span className="shrink-0 text-xl font-semibold text-foreground sm:text-2xl">
        {pageTitle}
      </span>
      {section ? <SectionRouteTitle section={section} /> : null}
    </h1>
  )
})

const sectionTitles: Record<PageSection, string> = {
  access: "Access",
  activity: "Activity",
  automations: "Automations",
  backups: "Backups",
  infra: "Infrastructure",
  settings: "Settings",
}

function SectionRouteTitle({ section }: { section: PageSection }) {
  const title = useRouterState({
    select: (state) =>
      sectionPageFromPathname(section, state.location.pathname),
  })
  if (!title) return null

  return (
    <>
      <span className="shrink-0 text-border">/</span>
      <span className="min-w-0 truncate text-base font-medium text-muted-foreground sm:text-lg">
        {title}
      </span>
    </>
  )
}

function sectionPageFromPathname(
  section: PageSection,
  pathname: string
): string | null {
  if (section === "infra") {
    if (pathname.startsWith("/infra/setup")) return "Setup"
    if (pathname.startsWith("/infra/relays")) return "Relays"
    if (pathname.startsWith("/infra/tailscale")) return "Tailscale"
    if (pathname.startsWith("/infra/domains")) return "Domains"
    if (pathname.startsWith("/infra/servers")) return "Servers"
    if (pathname.startsWith("/infra/databases")) return "Databases"
    return null
  }
  if (section === "settings") {
    if (pathname.startsWith("/settings/appearance")) return "Appearance"
    if (pathname.startsWith("/settings/files")) return "Files"
    if (pathname.startsWith("/settings/account")) return "Account"
    if (pathname.startsWith("/settings/billing")) return "Billing"
    return null
  }
  if (section === "automations") {
    if (pathname.startsWith("/automations/schedules")) return "Schedules"
    if (pathname.startsWith("/automations/sync")) return "Sync"
    if (pathname.startsWith("/automations/history")) return "History"
    if (pathname.startsWith("/automations/calendar")) return "Calendar"
  }
  return null
}

export const ToolbarSidebarTrigger = React.memo(
  function ToolbarSidebarTrigger() {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarTrigger
            className="-ml-1 size-8 shrink-0 text-muted-foreground shadow-none hover:bg-accent/70 hover:text-foreground"
            aria-label="Toggle sidebar"
          />
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          Toggle sidebar
        </TooltipContent>
      </Tooltip>
    )
  }
)
