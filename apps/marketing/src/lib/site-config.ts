import { createServerFn } from "@tanstack/react-start"

export interface SiteConfig {
  docsUrl: string
  hearthUrl: string
  // Where this site is served, for canonical links and link previews.
  siteUrl: string
}

// Read at request time so one build serves any deployment.
export const getSiteConfig = createServerFn({ method: "GET" }).handler(
  (): SiteConfig => ({
    docsUrl: baseUrl(process.env.KILN_DOCS_URL, "https://docs.kiln.site"),
    hearthUrl: baseUrl(process.env.KILN_HEARTH_URL, "https://panel.kiln.site"),
    siteUrl: baseUrl(process.env.KILN_SITE_URL, "https://kiln.site"),
  })
)

function baseUrl(configured: string | undefined, fallback: string): string {
  const value = configured?.trim()
  if (!value || !URL.canParse(value)) return fallback
  return value.replace(/\/+$/, "")
}
