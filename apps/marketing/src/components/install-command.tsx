import * as React from "react"
import { Check, Copy } from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { useSiteConfig } from "~/lib/use-site-config"

/** The command that installs Kiln, from this site's `/install`. */
export function useInstallCommand(options: { node?: boolean } = {}): string {
  const { siteUrl } = useSiteConfig()
  return `curl -fsSL ${siteUrl}/install | sh${options.node ? " -s -- --node" : ""}`
}

/** A shell prompt line with the command and a button that copies it. */
export function InstallCommand({
  className,
  command,
}: {
  className?: string
  command: string
}) {
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1_800)
    return () => window.clearTimeout(timer)
  }, [copied])

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-3 font-mono text-[0.8125rem] leading-7",
        className
      )}
    >
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">
        <span aria-hidden="true" className="text-primary-ink select-none">
          ${" "}
        </span>
        {command}
      </code>
      <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={copied ? "Command copied" : "Copy command"}
            className={cn(
              "grid size-8 shrink-0 place-items-center border border-border bg-background/60 transition-colors",
              copied
                ? "text-emerald-400"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(command)
                .then(() => setCopied(true))
            }}
          >
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {copied ? "Copied" : "Copy command"}
        </TooltipContent>
      </Tooltip>
      </TooltipProvider>
    </div>
  )
}
