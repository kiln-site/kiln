import * as React from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { CloudflareLogo } from "@/components/brand-logos"

/**
 * Whether a hostname's record goes through Cloudflare's proxy, as
 * Cloudflare's dashboard shows it: its orange cloud when proxied, grey when
 * DNS only.
 */
export const CloudflareProxyStatus = React.memo(function CloudflareProxyStatus({
  className,
  iconOnly = false,
  proxied,
}: {
  className?: string
  /** Just the cloud, which names its state on hover. */
  iconOnly?: boolean
  proxied: boolean
}) {
  const label = proxied ? "Proxied" : "DNS only"
  const mark = (
    <span
      className={cn(
        "type-meta inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap",
        proxied ? "text-orange-600 dark:text-orange-400" : "text-muted-foreground",
        className
      )}
      tabIndex={iconOnly ? 0 : undefined}
    >
      <CloudflareLogo
        className={cn("size-4", !proxied && "text-muted-foreground/55")}
      />
      <span className={iconOnly ? "sr-only" : undefined}>{label}</span>
    </span>
  )
  if (!iconOnly) return mark
  return (
    <Tooltip>
      <TooltipTrigger asChild>{mark}</TooltipTrigger>
      <TooltipContent side="bottom">
        {proxied ? "Proxied through Cloudflare" : "DNS only on Cloudflare"}
      </TooltipContent>
    </Tooltip>
  )
})
