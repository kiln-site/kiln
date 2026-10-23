import * as React from "react"
import { useLocation } from "@tanstack/react-router"
import { Check, ChevronsUpDown } from "lucide-react"

import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@workspace/ui/components/drawer"
import { cn } from "@workspace/ui/lib/utils"

import type { NavigationIcon } from "@/lib/navigation-destinations"

export interface SectionNavigationItem {
  // Sections render in order, with a divider wherever `group` changes.
  group?: string
  icon: NavigationIcon
  label: string
  to: string
}

/** What a section's Link is given: its look, what it shows, and a click. */
export interface SectionLinkProps {
  activeProps: { className: string }
  children: React.ReactNode
  className: string
  onClick?: () => void
}

type RenderSectionLink<TSection> = (
  section: TSection,
  props: SectionLinkProps
) => React.ReactNode

const tabClassName =
  "relative flex h-10 shrink-0 items-center gap-2 px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
const tabActiveProps = {
  className:
    "text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary",
}
const drawerLinkClassName =
  "group/section flex h-12 shrink-0 items-center gap-3 px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent/50 focus-visible:outline-none"
const drawerLinkActiveProps = { className: "bg-accent/40 text-foreground" }

/**
 * A page's section tabs. On phones they collapse into one button naming the
 * current section, which opens a drawer listing every section. Each caller
 * renders its own Link in `renderLink`, so routes and search stay typed.
 */
export function SectionNavigation<TSection extends SectionNavigationItem>({
  className,
  label,
  renderLink,
  sections,
  title,
}: {
  className?: string
  // Names the navigation for screen readers, e.g. "Backup sections".
  label: string
  renderLink: RenderSectionLink<TSection>
  sections: ReadonlyArray<TSection>
  // Heads the phone drawer, e.g. "Backups".
  title: string
}) {
  return (
    <div className={cn("min-w-0 border-b", className)}>
      <nav
        aria-label={label}
        className="no-scrollbar hidden min-w-0 gap-1 overflow-x-auto overflow-y-hidden md:flex"
      >
        {sections.map((section, index) => (
          <React.Fragment key={section.to}>
            {startsGroup(sections, index) ? (
              <span
                aria-hidden
                className="mx-1 h-4 w-px shrink-0 self-center bg-border"
              />
            ) : null}
            {renderLink(section, {
              activeProps: tabActiveProps,
              children: (
                <>
                  <section.icon className="size-3.5" />
                  {section.label}
                </>
              ),
              className: tabClassName,
            })}
          </React.Fragment>
        ))}
      </nav>
      <SectionDrawer
        label={label}
        renderLink={renderLink}
        sections={sections}
        title={title}
      />
    </div>
  )
}

function SectionDrawer<TSection extends SectionNavigationItem>({
  label,
  renderLink,
  sections,
  title,
}: {
  label: string
  renderLink: RenderSectionLink<TSection>
  sections: ReadonlyArray<TSection>
  title: string
}) {
  const [open, setOpen] = React.useState(false)
  const close = React.useCallback(() => setOpen(false), [])
  const pathname = useLocation({ select: (location) => location.pathname })
  const current = sections.find(
    (section) =>
      pathname === section.to || pathname.startsWith(`${section.to}/`)
  )
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger className="relative flex h-10 w-full items-center gap-2 px-3 text-xs font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary focus-visible:bg-accent/50 focus-visible:outline-none md:hidden">
        <span className="sr-only">{label}: </span>
        {current ? <current.icon className="size-3.5" /> : null}
        <span className="min-w-0 flex-1 truncate text-left">
          {current?.label ?? title}
        </span>
        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
      </DrawerTrigger>
      <DrawerContent>
        <DrawerTitle className="type-technical-label px-4 pt-2 pb-2 text-muted-foreground">
          {title}
        </DrawerTitle>
        <nav
          aria-label={label}
          className="flex flex-col overflow-y-auto overscroll-contain pb-3"
        >
          {sections.map((section, index) => (
            <React.Fragment key={section.to}>
              {startsGroup(sections, index) ? (
                <span aria-hidden className="mx-4 my-1 h-px bg-border/70" />
              ) : null}
              {renderLink(section, {
                activeProps: drawerLinkActiveProps,
                children: (
                  <>
                    <section.icon className="size-4" />
                    <span className="min-w-0 flex-1 truncate">
                      {section.label}
                    </span>
                    <Check className="size-4 text-primary-ink opacity-0 group-data-[status=active]/section:opacity-100" />
                  </>
                ),
                className: drawerLinkClassName,
                onClick: close,
              })}
            </React.Fragment>
          ))}
        </nav>
      </DrawerContent>
    </Drawer>
  )
}

function startsGroup(
  sections: ReadonlyArray<SectionNavigationItem>,
  index: number
) {
  return index > 0 && sections[index - 1]?.group !== sections[index]?.group
}
