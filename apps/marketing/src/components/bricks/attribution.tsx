import { BookOpen, Globe, LifeBuoy, type LucideIcon } from "lucide-react"

import type { BrickV2Links } from "@workspace/contracts"
import { cn } from "@workspace/ui/lib/utils"

import { BrandSvg } from "~/components/brand-svg"
import { brandMarks } from "~/lib/brand-marks"
import { newTab } from "~/lib/new-tab"

export const linkKinds = ["homepage", "source", "docs", "support"] as const
export type LinkKind = (typeof linkKinds)[number]

export const linkLabels: Record<LinkKind, string> = {
  homepage: "Website",
  source: "Source",
  docs: "Docs",
  support: "Support",
}

const linkIcons: Record<LinkKind, LucideIcon> = {
  homepage: Globe,
  source: Globe,
  docs: BookOpen,
  support: LifeBuoy,
}

// A link's mark: GitHub's for GitHub, otherwise one for what it is.
export function LinkIcon({
  className = "size-3.5",
  href,
  kind,
}: {
  className?: string
  href: string | undefined
  kind: LinkKind
}) {
  if (href && /^https:\/\/(?:www\.)?github\.com\//iu.test(href)) {
    return <BrandSvg mark={brandMarks.github} className={className} />
  }
  const Icon = linkIcons[kind]
  return <Icon aria-hidden="true" className={cn("shrink-0", className)} />
}

// Who made a Brick and where to find more, as small linked pills.
export function Attribution({
  author,
  className,
  links,
}: {
  author: string
  className?: string
  links: BrickV2Links | undefined
}) {
  const entries = linkKinds.flatMap((kind) =>
    links?.[kind] ? [[kind, links[kind]] as const] : []
  )
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <span className="type-support mr-1 text-muted-foreground">
        by <span className="text-foreground">{author}</span>
      </span>
      {entries.map(([kind, href]) => (
        <LinkPill key={kind} href={href} kind={kind} />
      ))}
    </div>
  )
}

function LinkPill({ href, kind }: { href: string; kind: LinkKind }) {
  return (
    <a
      href={href}
      {...newTab}
      title={href}
      className="type-label inline-flex h-6 items-center gap-1.5 border border-border bg-card/50 px-2 text-muted-foreground transition-colors outline-none hover:border-primary/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <LinkIcon href={href} kind={kind} className="size-3" />
      {linkLabels[kind]}
    </a>
  )
}
