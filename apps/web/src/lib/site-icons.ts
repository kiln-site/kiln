import { Result } from "effect"

// The icons a web page names for itself, largest first, so an app's icon
// can come from its own site. Pages are untrusted: only HTTPS addresses
// are returned, and nothing in them is run.

export interface SiteIconCandidate {
  /** The icon's largest side in pixels; scalable icons count as largest. */
  readonly size: number
  readonly url: string
}

const LINK_TAG = /<link\b[^>]*>/giu
const BASE_TAG = /<base\b[^>]*>/iu
const ATTRIBUTE =
  /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu
// How many candidates are worth trying; a page can name hundreds.
const MAX_CANDIDATES = 8

// Without `sizes`, Apple's touch icon is 180 pixels by convention; any
// other icon is assumed to be a favicon.
const APPLE_TOUCH_ICON_SIZE = 180
const FAVICON_SIZE = 32
const SCALABLE_SIZE = 4096

function attributes(tag: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const name = match[1]?.toLowerCase()
    const value = match[2] ?? match[3] ?? match[4] ?? ""
    if (name && !values.has(name)) values.set(name, decodeEntities(value))
  }
  return values
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([\da-f]+);/giu, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/gu, (_, decimal: string) =>
      String.fromCodePoint(Number(decimal))
    )
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&")
}

function resolve(reference: string, base: URL): URL | null {
  return Result.try(() => new URL(reference.trim(), base)).pipe(
    Result.match({
      onFailure: () => null,
      onSuccess: (url) => (url.protocol === "https:" ? url : null),
    })
  )
}

function declaredSize(
  sizes: string | undefined,
  url: URL,
  type: string | undefined
): number | null {
  if (sizes) {
    let largest = 0
    for (const size of sizes.toLowerCase().split(/\s+/u)) {
      if (size === "any") return SCALABLE_SIZE
      const match = /^(\d{1,5})x(\d{1,5})$/u.exec(size)
      if (match) {
        largest = Math.max(largest, Number(match[1]), Number(match[2]))
      }
    }
    if (largest > 0) return largest
  }
  if (type === "image/svg+xml" || url.pathname.toLowerCase().endsWith(".svg")) {
    return SCALABLE_SIZE
  }
  return null
}

/**
 * The icons `html` names, largest first, resolved against the page's
 * address (or its `<base>`). Monochrome Safari pinned-tab masks are left
 * out, since they draw as a silhouette.
 */
export function siteIconCandidates(
  html: string,
  pageUrl: string
): Array<SiteIconCandidate> {
  const page = new URL(pageUrl)
  const baseHref = BASE_TAG.exec(html)
  const base =
    (baseHref
      ? resolve(attributes(baseHref[0]).get("href") ?? "", page)
      : null) ?? page
  const candidates = new Map<string, SiteIconCandidate>()
  for (const [tag] of html.matchAll(LINK_TAG)) {
    const values = attributes(tag)
    const relations = (values.get("rel") ?? "").toLowerCase().split(/\s+/u)
    const touch =
      relations.includes("apple-touch-icon") ||
      relations.includes("apple-touch-icon-precomposed")
    if (!touch && !relations.includes("icon")) continue
    const href = values.get("href")
    if (!href || href.trim().toLowerCase().startsWith("data:")) continue
    const url = resolve(href, base)
    if (!url) continue
    const size =
      declaredSize(
        values.get("sizes"),
        url,
        values.get("type")?.toLowerCase()
      ) ?? (touch ? APPLE_TOUCH_ICON_SIZE : FAVICON_SIZE)
    const existing = candidates.get(url.href)
    if (!existing || existing.size < size) {
      candidates.set(url.href, { size, url: url.href })
    }
  }
  return [...candidates.values()]
    .sort((left, right) => right.size - left.size)
    .slice(0, MAX_CANDIDATES)
}
