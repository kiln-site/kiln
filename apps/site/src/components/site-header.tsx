import * as React from "react"
import { Link } from "@tanstack/react-router"
import { Menu, X } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import { socialLinks } from "@/lib/social-links"

import { ComingSoon } from "~/components/coming-soon"
import { KilnMark } from "~/components/kiln-mark"
import { comingSoon } from "~/lib/coming-soon"
import { signInUrl, signUpUrl } from "~/lib/plans"
import { newTab } from "~/lib/new-tab"
import { useSiteConfig } from "~/lib/use-site-config"

export function SiteHeader() {
  const { docsUrl, hearthUrl } = useSiteConfig()
  const [menuOpen, setMenuOpen] = React.useState(false)
  const menuId = React.useId()

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <div className="site-container flex h-16 items-center gap-6">
        <Link
          to="/"
          className="-ml-1 flex items-center gap-2.5 px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          onClick={() => setMenuOpen(false)}
        >
          <KilnMark />
          <span className="text-lg font-semibold tracking-[-0.04em]">Kiln</span>
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          <HeaderLink to="/pricing">Pricing</HeaderLink>
          <ComingSoon soon={comingSoon.docs} label="Docs">
            <HeaderAnchor href={docsUrl} {...newTab}>
              Docs
            </HeaderAnchor>
          </ComingSoon>
          <HeaderAnchor href={socialLinks.github.href} {...newTab}>
            GitHub
          </HeaderAnchor>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Button
            asChild
            variant="ghost"
            className="hidden h-9 px-3 sm:inline-flex"
          >
            <a href={signInUrl(hearthUrl)}>Log in</a>
          </Button>
          <ComingSoon soon={comingSoon.signUp} label="Sign up">
            <Button asChild className="h-9 px-3.5">
              <a href={signUpUrl(hearthUrl)}>Sign up</a>
            </Button>
          </ComingSoon>
          <Button
            variant="ghost"
            size="icon-lg"
            className="md:hidden"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X /> : <Menu />}
          </Button>
        </div>
      </div>

      {menuOpen ? (
        <nav
          id={menuId}
          aria-label="Main"
          className="border-t border-border/70 md:hidden"
        >
          <div className="site-container flex flex-col py-2">
            <MobileLink to="/pricing" onNavigate={() => setMenuOpen(false)}>
              Pricing
            </MobileLink>
            <ComingSoon soon={comingSoon.docs} label="Docs" className="flex">
              <MobileAnchor href={docsUrl} {...newTab}>
                Docs
              </MobileAnchor>
            </ComingSoon>
            <MobileAnchor href={socialLinks.github.href} {...newTab}>
              GitHub
            </MobileAnchor>
            <MobileAnchor href={signInUrl(hearthUrl)}>Log in</MobileAnchor>
          </div>
        </nav>
      ) : null}
    </header>
  )
}

const headerLinkClassName =
  "px-3 py-2 text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"

function HeaderLink({
  to,
  children,
}: {
  to: "/pricing"
  children: React.ReactNode
}) {
  return (
    <Link
      to={to}
      className={headerLinkClassName}
      activeProps={{ className: "text-foreground" }}
    >
      {children}
    </Link>
  )
}

function HeaderAnchor(props: React.ComponentProps<"a">) {
  return <a {...props} className={headerLinkClassName} />
}

const mobileLinkClassName =
  "flex h-12 items-center border-b border-border/50 text-base last:border-b-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"

function MobileLink({
  to,
  onNavigate,
  children,
}: {
  to: "/pricing"
  onNavigate: () => void
  children: React.ReactNode
}) {
  return (
    <Link to={to} className={mobileLinkClassName} onClick={onNavigate}>
      {children}
    </Link>
  )
}

function MobileAnchor(props: React.ComponentProps<"a">) {
  return <a {...props} className={mobileLinkClassName} />
}
