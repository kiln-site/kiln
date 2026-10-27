import { createServerFn } from "@tanstack/react-start"

export interface SiteConfig {
  analytics: { scriptUrl: string; websiteId: string } | null
  // Where kiln.site is served. The docs live below it, at the build's base.
  siteUrl: string
}

// Read at request time so one build serves any deployment. These are the same
// variables the marketing site reads.
export const getSiteConfig = createServerFn({ method: "GET" }).handler(
  (): SiteConfig => ({
    analytics: analyticsConfig(),
    siteUrl: baseUrl(process.env.KILN_SITE_URL, "https://kiln.site"),
  })
)

function analyticsConfig(): SiteConfig["analytics"] {
  const scriptUrl = process.env.KILN_WEB_ANALYTICS_URL?.trim()
  const websiteId = process.env.KILN_WEB_ANALYTICS_WEBSITE_ID?.trim()
  if (!scriptUrl || !websiteId || !URL.canParse(scriptUrl)) return null
  const url = new URL(scriptUrl)
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  return { scriptUrl, websiteId }
}

function baseUrl(configured: string | undefined, fallback: string): string {
  const value = configured?.trim()
  if (!value || !URL.canParse(value)) return fallback
  return value.replace(/\/+$/, "")
}
