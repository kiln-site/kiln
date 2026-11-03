import * as React from "react"
import { Cloud } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

/**
 * Whether a hostname's record goes through Cloudflare's proxy, in
 * Cloudflare's own terms: an orange cloud, or a grey one for DNS only.
 */
export const CloudflareProxyStatus = React.memo(function CloudflareProxyStatus({
  className,
  iconOnly = false,
  proxied,
}: {
  className?: string
  /** Just the cloud, labelled for screen readers and on hover. */
  iconOnly?: boolean
  proxied: boolean
}) {
  const label = proxied ? "Proxied" : "DNS only"
  return (
    <span
      className={cn(
        "type-meta inline-flex shrink-0 items-center gap-1 whitespace-nowrap",
        proxied
          ? "text-orange-600 dark:text-orange-400"
          : "text-muted-foreground",
        className
      )}
      title={iconOnly ? `Cloudflare: ${label}` : undefined}
    >
      <Cloud
        aria-hidden
        className={cn("size-3.5", proxied && "fill-current")}
      />
      <span className={iconOnly ? "sr-only" : undefined}>{label}</span>
    </span>
  )
})
