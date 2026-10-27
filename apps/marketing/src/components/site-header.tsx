import * as React from "react"
import { Link } from "@tanstack/react-router"

import { Button } from "@workspace/ui/components/button"

import { socialLinks } from "@/lib/social-links"

import { ComingSoon } from "~/components/coming-soon"
import { KilnMark } from "~/components/kiln-mark"
import { MobileMenu } from "~/components/mobile-menu"
import { comingSoon } from "~/lib/coming-soon"
import { signInUrl, signUpUrl } from "~/lib/plans"
import { newTab } from "~/lib/new-tab"
import { useSiteConfig } from "~/lib/use-site-config"

export function SiteHeader() {
  const { docsUrl, hearthUrl } = useSiteConfig()

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <div className="site-container flex h-16 items-center gap-6">
        <Link
          to="/"
          className="-ml-1 flex items-center gap-2.5 px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <KilnMark />
          <span className="text-lg font-semibold tracking-[-0.04em]">Kiln</span>
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          <HeaderLink to="/pricing">Pricing</HeaderLink>
          <HeaderLink to="/compare">Compare</HeaderLink>
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
          <MobileMenu />
        </div>
      </div>
    </header>
  )
}

const headerLinkClassName =
  "px-3 py-2 text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"

function HeaderLink({
  to,
  children,
}: {
  to: "/pricing" | "/compare"
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
