import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

// Long enough to read as feedback when the refresh itself is instant.
const minimumFeedbackMs = 500

export const InfraSyncButton = React.memo(function InfraSyncButton({
  disabled = false,
  label,
  onError,
  size = "icon",
  sync,
}: {
  disabled?: boolean
  label: string
  onError?: (cause: Error) => void
  /** `icon-sm` fits a card header. */
  size?: "icon" | "icon-sm"
  sync: () => Promise<unknown>
}) {
  // oxlint-disable-next-line react-doctor/query-mutation-missing-invalidation -- `sync` is the invalidation
  const mutation = useMutation({
    mutationFn: () =>
      Promise.all([
        sync(),
        new Promise((resolve) => setTimeout(resolve, minimumFeedbackMs)),
      ]),
    onError,
  })
  const syncing = mutation.isPending

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size={size}
          variant="outline"
          aria-label={label}
          aria-busy={syncing}
          disabled={syncing || disabled}
          onClick={() => mutation.mutate()}
        >
          <RefreshCw className={syncing ? "animate-spin" : ""} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
})
