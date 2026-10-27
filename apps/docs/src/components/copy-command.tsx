import * as React from "react"
import { Check, Copy } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

// A shell command with a button that copies it.
export function CopyCommand({
  className,
  command,
}: {
  className?: string
  command: string
}) {
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-3 border border-border bg-card py-1.5 pr-1.5 pl-4 font-mono text-[0.8125rem] leading-7",
        className
      )}
    >
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">
        <span aria-hidden="true" className="text-primary-ink select-none">
          ${" "}
        </span>
        {command}
      </code>
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
            .writeText(command)
            .then(() => setCopied(true))
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  )
}
