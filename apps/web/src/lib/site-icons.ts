import { Result } from "effect"
import { z } from "zod"

// Where an app's site keeps its icon: what its pages and web app manifest
// name, and the spots sites keep one by convention, largest first. Pages
// and manifests are untrusted: only HTTPS addresses are returned, and
// nothing in them is run.

export interface SiteIconCandidate {
  /** The icon's largest side in pixels; scalable icons count as largest. */
  readonly size: number
  readonly url: string
  /** A conventional spot the site never named, which may not exist. */
  readonly guessed?: boolean
}

export interface SitePage {
  readonly icons: ReadonlyArray<SiteIconCandidate>
  /** The page's web app manifest, which can name larger icons. */
  readonly manifestUrl: string | null
}

const LINK_TAG = /<link\b[^>]*>/giu
const BASE_TAG = /<base\b[^>]*>/iu
const ATTRIBUTE =
  /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu
// How many candidates are worth trying; a page can name hundreds.
const MAX_CANDIDATES = 12

// Without `sizes`, Apple's touch icon is 180 pixels by convention; any
// other icon is assumed to be a favicon.
const APPLE_TOUCH_ICON_SIZE = 180
const FAVICON_SIZE = 32
const SCALABLE_SIZE = 4096

// Where sites keep icons without always saying so, and the size each
// usually is: the Android icons favicon generators write, Apple's touch
// icons, scalable favicons, and the classic favicon.
const CONVENTIONAL_ICONS: ReadonlyArray<readonly [string, number]> = [
  ["/android-chrome-512x512.png", 512],
  ["/icon-512.png", 512],
  ["/android-chrome-192x192.png", 192],
  ["/icon-192.png", 192],
  ["/apple-touch-icon.png", APPLE_TOUCH_ICON_SIZE],
  ["/apple-touch-icon-precomposed.png", APPLE_TOUCH_ICON_SIZE],
  ["/favicon.svg", SCALABLE_SIZE],
  ["/icon.svg", SCALABLE_SIZE],
  ["/icon.png", 128],
  ["/favicon.png", 64],
  ["/favicon.ico", FAVICON_SIZE],
]

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
  if (reference.trim().toLowerCase().startsWith("data:")) return null
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
 * The icons a page names, and its manifest, resolved against the page's
 * address (or its `<base>`). Monochrome Safari pinned-tab masks are left
 * out, since they draw as a silhouette.
 */
export function readSitePage(html: string, pageUrl: string): SitePage {
  const page = new URL(pageUrl)
  const baseHref = BASE_TAG.exec(html)
  const base =
    (baseHref
      ? resolve(attributes(baseHref[0]).get("href") ?? "", page)
      : null) ?? page
  const icons: Array<SiteIconCandidate> = []
  let manifestUrl: string | null = null
  for (const [tag] of html.matchAll(LINK_TAG)) {
    const values = attributes(tag)
    const relations = (values.get("rel") ?? "").toLowerCase().split(/\s+/u)
    const url = resolve(values.get("href") ?? "", base)
    if (!url) continue
    if (relations.includes("manifest")) {
      manifestUrl ??= url.href
      continue
    }
    const touch =
      relations.includes("apple-touch-icon") ||
      relations.includes("apple-touch-icon-precomposed")
    if (!touch && !relations.includes("icon")) continue
    icons.push({
      size:
        declaredSize(
          values.get("sizes"),
          url,
          values.get("type")?.toLowerCase()
        ) ?? (touch ? APPLE_TOUCH_ICON_SIZE : FAVICON_SIZE),
      url: url.href,
    })
  }
  return { icons, manifestUrl }
}

const manifestSchema = z.object({
  icons: z
    .array(
      z.object({
        purpose: z.string().optional(),
        sizes: z.string().optional(),
        src: z.string().max(2_048),
        type: z.string().optional(),
      })
    )
    .max(256)
    .optional(),
})

/**
 * The icons a web app manifest names. Icons only for a monochrome mask are
 * left out, and maskable ones, padded to be cropped, count as half their
 * size, so a plain icon of the same size wins.
 */
export function readManifestIcons(
  manifest: unknown,
  manifestUrl: string
): Array<SiteIconCandidate> {
  const parsed = manifestSchema.safeParse(manifest)
  if (!parsed.success) return []
  const base = new URL(manifestUrl)
  return (parsed.data.icons ?? []).flatMap((icon) => {
    const purposes = (icon.purpose ?? "any").toLowerCase().split(/\s+/u)
    const plain = purposes.includes("any")
    if (!plain && !purposes.includes("maskable")) return []
    const url = resolve(icon.src, base)
    if (!url) return []
    const size =
      declaredSize(icon.sizes, url, icon.type?.toLowerCase()) ?? FAVICON_SIZE
    return [{ size: plain ? size : size / 2, url: url.href }]
  })
}

/** The conventional spots on a site's origin, for when it names none. */
export function conventionalIcons(siteUrl: string): Array<SiteIconCandidate> {
  const origin = new URL(siteUrl).origin
  return CONVENTIONAL_ICONS.map(([path, size]) => ({
    guessed: true,
    size,
    url: new URL(path, origin).href,
  }))
}

/**
 * Every candidate once, largest first. An icon the site named comes before
 * a guessed spot of the same size, since it's sure to exist.
 */
export function rankSiteIcons(
  candidates: ReadonlyArray<SiteIconCandidate>
): Array<SiteIconCandidate> {
  const unique = new Map<string, SiteIconCandidate>()
  for (const candidate of candidates) {
    const existing = unique.get(candidate.url)
    unique.set(
      candidate.url,
      existing
        ? {
            size: Math.max(existing.size, candidate.size),
            url: candidate.url,
            ...(existing.guessed && candidate.guessed ? { guessed: true } : {}),
          }
        : candidate
    )
  }
  return [...unique.values()]
    .sort(
      (left, right) =>
        right.size - left.size ||
        Number(Boolean(left.guessed)) - Number(Boolean(right.guessed))
    )
    .slice(0, MAX_CANDIDATES)
}
