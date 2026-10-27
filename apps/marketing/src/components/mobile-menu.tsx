import * as React from "react"
import { Link } from "@tanstack/react-router"
import { Menu } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@workspace/ui/components/drawer"

import { socialLinks } from "@/lib/social-links"

import { BrandSvg } from "~/components/brand-svg"
import { ComingSoon } from "~/components/coming-soon"
import { brandMarks } from "~/lib/brand-marks"
import { comingSoon } from "~/lib/coming-soon"
import { signInUrl, signUpUrl } from "~/lib/plans"
import { newTab } from "~/lib/new-tab"
import { useSiteConfig } from "~/lib/use-site-config"

const pageLinkClassName =
  "flex h-12 items-center justify-center text-xl font-semibold tracking-[-0.03em] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground focus-visible:underline focus-visible:underline-offset-4 data-[status=active]:text-primary-ink"

const socials = [
  { link: socialLinks.github, mark: brandMarks.github },
  { link: socialLinks.discord, mark: brandMarks.discord },
  { link: socialLinks.x, mark: brandMarks.x },
]

// The site's menu on a phone. It opens over the page from the bottom, so the
// page never moves.
export function MobileMenu() {
  const { hearthUrl } = useSiteConfig()
  const [open, setOpen] = React.useState(false)
  const close = React.useCallback(() => setOpen(false), [])

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          className="md:hidden"
          aria-label="Open menu"
        >
          <Menu />
        </Button>
      </DrawerTrigger>
      <DrawerContent className="px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <DrawerTitle className="sr-only">Menu</DrawerTitle>

        <nav aria-label="Main" className="grid grid-cols-2 gap-3 pt-5">
          <PageLink to="/pricing" onNavigate={close}>
            Pricing
          </PageLink>
          <PageLink to="/compare" onNavigate={close}>
            Compare
          </PageLink>
        </nav>

        <div className="mt-8 grid grid-cols-2 gap-3">
          <Button asChild variant="outline" className="h-12 text-[0.9375rem]">
            <a href={signInUrl(hearthUrl)}>Log in</a>
          </Button>
          <ComingSoon soon={comingSoon.signUp} label="Sign up" className="flex">
            <Button asChild className="h-12 w-full text-[0.9375rem]">
              <a href={signUpUrl(hearthUrl)}>Sign up</a>
            </Button>
          </ComingSoon>
        </div>

        <ul className="mt-8 flex justify-center gap-3">
          {socials.map(({ link, mark }) => (
            <li key={link.href}>
              <a
                href={link.href}
                {...newTab}
                aria-label={link.label}
                className="grid size-12 place-items-center border border-border text-muted-foreground transition-colors outline-none hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <BrandSvg mark={mark} className="size-5" />
              </a>
            </li>
          ))}
        </ul>
      </DrawerContent>
    </Drawer>
  )
}

function PageLink({
  children,
  onNavigate,
  to,
}: {
  children: React.ReactNode
  onNavigate: () => void
  to: "/pricing" | "/compare"
}) {
  return (
    <Link to={to} className={pageLinkClassName} onClick={onNavigate}>
      {children}
    </Link>
  )
}
