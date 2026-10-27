import * as React from "react"
import { Link } from "@tanstack/react-router"
import { ArrowUpRight, Menu, Search } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@workspace/ui/components/drawer"

import { DiscordIcon, GitHubIcon } from "~/components/brand-icons"
import { DocsNav } from "~/components/docs-nav"
import { KilnMark } from "~/components/kiln-mark"
import {
  SearchButton,
  preloadSearchIndex,
  useOpenSearch,
} from "~/components/search"
import { links } from "~/lib/links"
import { useSiteConfig } from "~/lib/use-site-config"

export function DocsHeader() {
  const { siteUrl } = useSiteConfig()
  const openSearch = useOpenSearch()

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[90rem] items-center gap-3 px-4 sm:px-6">
        <MobileNav />
        <div className="flex items-center gap-2.5">
          <a
            href={siteUrl}
            aria-label="Kiln home"
            className="-ml-1 flex items-center gap-2.5 px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <KilnMark className="size-6" />
            <span className="text-[1.0625rem] font-semibold tracking-[-0.04em]">
              Kiln
            </span>
          </a>
          <span aria-hidden="true" className="h-5 w-px bg-border" />
          <Link
            to="/"
            className="text-[1.0625rem] font-medium tracking-[-0.03em] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground"
          >
            Docs
          </Link>
        </div>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <SearchButton className="hidden w-64 md:flex lg:w-80" />
          <Button
            variant="ghost"
            size="icon-lg"
            className="md:hidden"
            aria-label="Search the docs"
            onClick={openSearch}
            onPointerEnter={() => void preloadSearchIndex()}
          >
            <Search />
          </Button>
          <a
            href={siteUrl}
            className="hidden items-center gap-1 px-2.5 py-2 text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground lg:flex"
          >
            kiln.site
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </a>
          <IconLink href={links.github} label="Kiln on GitHub">
            <GitHubIcon className="size-[18px]" />
          </IconLink>
          <IconLink href={links.discord} label="Kiln on Discord">
            <DiscordIcon className="size-[18px]" />
          </IconLink>
        </div>
      </div>
    </header>
  )
}

function IconLink({
  children,
  href,
  label,
}: {
  children: React.ReactNode
  href: string
  label: string
}) {
  return (
    <a
      href={href}
      aria-label={label}
      target="_blank"
      rel="noreferrer"
      className="hidden size-9 place-items-center text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 sm:grid"
    >
      {children}
    </a>
  )
}

// On phones and tablets the sidebar opens from the bottom in a drawer, over
// the page, so nothing moves.
function MobileNav() {
  const [open, setOpen] = React.useState(false)
  const close = React.useCallback(() => setOpen(false), [])
  // Opening on a page far down the list starts with that page in view. Only
  // the list scrolls; scrollIntoView would move the page behind it too.
  const showCurrentPage = React.useCallback((list: HTMLDivElement | null) => {
    const current = list?.querySelector('[data-status="active"]')
    if (!list || !current) return
    const listBox = list.getBoundingClientRect()
    const box = current.getBoundingClientRect()
    list.scrollTop +=
      box.top - listBox.top - listBox.height / 2 + box.height / 2
  }, [])
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          className="-ml-2 lg:hidden"
          aria-label="Open the docs menu"
        >
          <Menu />
        </Button>
      </DrawerTrigger>
      <DrawerContent className="pb-[env(safe-area-inset-bottom)]">
        <DrawerTitle className="sr-only">Docs</DrawerTitle>
        <div
          ref={showCurrentPage}
          className="min-h-0 overflow-y-auto overscroll-contain px-3 pt-3 pb-6"
        >
          <DocsNav onNavigate={close} />
          <div className="mt-8 flex gap-3 px-3">
            <a
              href={links.github}
              target="_blank"
              rel="noreferrer"
              aria-label="Kiln on GitHub"
              className="grid size-11 place-items-center border border-border text-muted-foreground transition-colors hover:text-foreground"
            >
              <GitHubIcon className="size-5" />
            </a>
            <a
              href={links.discord}
              target="_blank"
              rel="noreferrer"
              aria-label="Kiln on Discord"
              className="grid size-11 place-items-center border border-border text-muted-foreground transition-colors hover:text-foreground"
            >
              <DiscordIcon className="size-5" />
            </a>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
