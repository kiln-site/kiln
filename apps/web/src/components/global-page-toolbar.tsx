import * as React from "react"
import { useRouterState } from "@tanstack/react-router"

import { SidebarTrigger } from "@workspace/ui/components/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import { sectionDestinationLabel } from "@/lib/navigation-destinations"
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
    <h1 className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="type-page-title shrink-0 text-foreground">
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
      <span className="type-page-context min-w-0 truncate text-muted-foreground">
        {title}
      </span>
    </>
  )
}

function sectionPageFromPathname(
  section: PageSection,
  pathname: string
): string | null {
  if (
    section !== "infra" &&
    section !== "settings" &&
    section !== "automations"
  ) {
    return null
  }
  return sectionDestinationLabel(section, pathname)
}

export const ToolbarSidebarTrigger = React.memo(
  function ToolbarSidebarTrigger() {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarTrigger
            className="-mr-1.5 -ml-2.5 size-8 shrink-0 text-muted-foreground shadow-none hover:bg-accent/70 hover:text-foreground"
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
