import type * as React from "react"
import { Link } from "@tanstack/react-router"
import { DEFAULT_KILN_GIT_REPO } from "@workspace/contracts"

import { socialLinks } from "@/lib/social-links"

import { ComingSoon } from "~/components/coming-soon"
import { KilnMark } from "~/components/kiln-mark"
import { comingSoon } from "~/lib/coming-soon"
import { signInUrl } from "~/lib/plans"
import { newTab } from "~/lib/new-tab"
import { useSiteConfig } from "~/lib/use-site-config"

export function SiteFooter() {
  const { docsUrl, hearthUrl } = useSiteConfig()

  return (
    <footer className="border-t border-border">
      <div className="site-container grid gap-10 py-12 sm:grid-cols-[1fr_auto] sm:py-16">
        <div className="max-w-xs">
          <div className="flex items-center gap-2.5">
            <KilnMark className="size-6" />
            <span className="font-semibold tracking-[-0.04em]">Kiln</span>
          </div>
          <p className="type-support mt-3 text-muted-foreground">
            Free and open source under{" "}
            <a
              href={`${DEFAULT_KILN_GIT_REPO}/blob/main/LICENSE`}
              className="underline underline-offset-4 transition-colors hover:text-foreground"
              {...newTab}
            >
              AGPL-3.0
            </a>
            .
            <br />
            Made by QuartzDev.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-x-12 gap-y-8 sm:grid-cols-3">
          <FooterGroup title="Product">
            <FooterLink>
              <Link to="/pricing">Pricing</Link>
            </FooterLink>
            <FooterLink>
              <Link to="/compare">Compare</Link>
            </FooterLink>
            <FooterLink>
              <ComingSoon soon={comingSoon.docs} label="Docs">
                <a href={docsUrl} {...newTab}>
                  Docs
                </a>
              </ComingSoon>
            </FooterLink>
            <FooterLink>
              <a href={signInUrl(hearthUrl)}>Log in</a>
            </FooterLink>
          </FooterGroup>
          <FooterGroup title="Community">
            <FooterLink>
              <a href={socialLinks.github.href} {...newTab}>
                GitHub
              </a>
            </FooterLink>
            <FooterLink>
              <a href={socialLinks.discord.href} {...newTab}>
                Discord
              </a>
            </FooterLink>
            <FooterLink>
              <a href={socialLinks.x.href} {...newTab}>
                X
              </a>
            </FooterLink>
          </FooterGroup>
          <FooterGroup title="Legal">
            <FooterLink>
              <Link to="/terms">Terms</Link>
            </FooterLink>
            <FooterLink>
              <Link to="/privacy">Privacy</Link>
            </FooterLink>
          </FooterGroup>
        </div>
      </div>
    </footer>
  )
}

function FooterGroup({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <h2 className="type-label text-foreground">{title}</h2>
      <ul className="mt-3 space-y-2">{children}</ul>
    </div>
  )
}

function FooterLink({ children }: { children: React.ReactNode }) {
  return (
    <li className="type-support text-muted-foreground [&_a]:transition-colors [&_a]:outline-none [&_a]:hover:text-foreground [&_a]:focus-visible:text-foreground [&_a]:focus-visible:underline">
      {children}
    </li>
  )
}
