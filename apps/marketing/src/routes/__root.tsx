import type { ReactNode } from "react"
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { geistLatin, jetBrainsMonoLatin } from "@workspace/ui/lib/font-assets"

import siteCss from "~/styles.css?url"
import appIcon192 from "~/assets/app-icon-192.png?no-inline"
import faviconSvg from "~/assets/favicon.svg?no-inline"
import { NotFoundPage } from "~/components/not-found-page"
import { SiteFooter } from "~/components/site-footer"
import { SiteHeader } from "~/components/site-header"
import { siteName } from "~/lib/seo"
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
      // Pages set their own title, description, and preview; a page
      // without one, like a 404, is still Kiln.
      { title: siteName },
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
      { rel: "icon", href: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { rel: "apple-touch-icon", href: appIcon192, sizes: "192x192" },
      { rel: "stylesheet", href: siteCss },
    ],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
  notFoundComponent: NotFoundPage,
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
      <a
        href="#main"
        className="sr-only z-50 bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main">
        <Outlet />
      </main>
      <SiteFooter />
    </TooltipProvider>
  )
}
