import type { AnyRouteMatch } from "@tanstack/react-router"

import type { SiteConfig } from "~/lib/site-config"

export const siteName = "Kiln"
export const siteDescription =
  "Kiln is a free, open-source panel for game servers, apps, Docker, and databases, running on machines you own."

// The link preview, 1200 by 480: short and wide.
const previewImage = {
  alt: "Kiln",
  height: 480,
  path: "/og.png",
  width: 1200,
}

// The root route loads the site config, so every route's head finds the
// site's URL in its first match.
export function siteUrlOf(matches: Array<{ loaderData?: unknown }>): string {
  return (matches[0]?.loaderData as SiteConfig | undefined)?.siteUrl ?? ""
}

// A page's title, description, canonical link, and link preview. The root
// loader holds the site's URL, so a route passes its matches.
export function pageHead({
  description = siteDescription,
  matches,
  path,
  title,
}: {
  description?: string
  matches: Array<{ loaderData?: unknown }>
  path: string
  title: string
}): { links: AnyRouteMatch["links"]; meta: AnyRouteMatch["meta"] } {
  const siteUrl = siteUrlOf(matches)
  const url = `${siteUrl}${path}`
  const image = `${siteUrl}${previewImage.path}`
  return {
    links: [{ rel: "canonical", href: url }],
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: siteName },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: url },
      { property: "og:image", content: image },
      { property: "og:image:width", content: String(previewImage.width) },
      { property: "og:image:height", content: String(previewImage.height) },
      { property: "og:image:alt", content: previewImage.alt },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: image },
    ],
  }
}

// Who makes Kiln and what it is, for search engines and AI assistants. Only
// the self-hosted plan is listed while paid plans are coming soon.
export function siteStructuredData(
  siteUrl: string,
  sameAs: ReadonlyArray<string>
) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${siteUrl}/#organization`,
        logo: `${siteUrl}/icon-192.png`,
        name: siteName,
        sameAs,
        url: siteUrl,
      },
      {
        "@type": "WebSite",
        "@id": `${siteUrl}/#website`,
        name: siteName,
        publisher: { "@id": `${siteUrl}/#organization` },
        url: siteUrl,
      },
      {
        "@type": "SoftwareApplication",
        applicationCategory: "DeveloperApplication",
        applicationSubCategory: "Server management panel",
        description: siteDescription,
        featureList: [
          "Game servers from Bricks, including Minecraft and Palworld",
          "Apps deployed from GitHub, Docker images, or Compose",
          "MySQL, MariaDB, PostgreSQL, Redis, and Valkey databases",
          "Browser console, file editor, NBT and SQLite editing",
          "Backups, schedules, access control, and activity history",
          "Cloudflare DNS and automatic HTTPS",
        ],
        image: `${siteUrl}/og.png`,
        isAccessibleForFree: true,
        license: "https://www.gnu.org/licenses/agpl-3.0.html",
        name: siteName,
        offers: {
          "@type": "Offer",
          name: "Self-hosted",
          price: "0",
          priceCurrency: "USD",
        },
        operatingSystem: "Linux",
        publisher: { "@id": `${siteUrl}/#organization` },
        url: siteUrl,
      },
    ],
  })
}
