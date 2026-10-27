import type { ReactNode } from "react"
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { geistLatin, jetBrainsMonoLatin } from "@workspace/ui/lib/font-assets"

import docsCss from "~/styles.css?url"
import appIcon192 from "~/assets/app-icon-192.png?no-inline"
import faviconSvg from "~/assets/favicon.svg?no-inline"
import { DocsHeader } from "~/components/docs-header"
import { NotFound } from "~/components/not-found"
import { SearchProvider } from "~/components/search"
import { withBase } from "~/lib/base"
import { getSiteConfig } from "~/lib/site-config"
import { useSiteConfig } from "~/lib/use-site-config"

export const Route = createRootRoute({
  loader: () => getSiteConfig(),
  staleTime: Infinity,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#121010" },
      { title: "Kiln Docs" },
    ],
    links: [
      {
        rel: "preload",
        href: geistLatin,
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        href: jetBrainsMonoLatin,
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      { rel: "icon", href: faviconSvg, type: "image/svg+xml", sizes: "any" },
      {
        rel: "icon",
        href: withBase("/favicon.ico"),
        sizes: "16x16 32x32 48x48",
      },
      { rel: "apple-touch-icon", href: appIcon192, sizes: "192x192" },
      { rel: "stylesheet", href: docsCss },
    ],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
  notFoundComponent: NotFound,
})

function RootDocument({ children }: { children: ReactNode }) {
  const { analytics } = useSiteConfig()
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
        {analytics && (
          <script
            defer
            src={analytics.scriptUrl}
            data-website-id={analytics.websiteId}
          />
        )}
      </head>
      <body className="min-h-dvh antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function RootLayout() {
  return (
    <TooltipProvider delayDuration={150}>
      <SearchProvider>
        <a
          href="#main"
          className="sr-only z-50 bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          Skip to content
        </a>
        <DocsHeader />
        <main id="main">
          <Outlet />
        </main>
      </SearchProvider>
    </TooltipProvider>
  )
}
