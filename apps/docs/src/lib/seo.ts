import type { AnyRouteMatch } from "@tanstack/react-router"

import type { SiteConfig } from "~/lib/site-config"
import { withBase } from "~/lib/base"

// The root loader holds the site's URL, so every route's head finds it in its
// first match.
export function siteUrlOf(matches: Array<{ loaderData?: unknown }>): string {
  return (matches[0]?.loaderData as SiteConfig | undefined)?.siteUrl ?? ""
}

// A page's title, description, canonical link, and link preview.
export function pageHead({
  description,
  matches,
  path,
  title,
}: {
  description: string
  matches: Array<{ loaderData?: unknown }>
  // The docs path, like "/relays/add" or "/" for the docs' home.
  path: string
  title: string
}): { links: AnyRouteMatch["links"]; meta: AnyRouteMatch["meta"] } {
  const siteUrl = siteUrlOf(matches)
  const url = `${siteUrl}${withBase(path)}`
  const image = `${siteUrl}/og.png`
  return {
    links: [{ rel: "canonical", href: url }],
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:type", content: "article" },
      { property: "og:site_name", content: "Kiln Docs" },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: url },
      { property: "og:image", content: image },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: image },
    ],
  }
}
