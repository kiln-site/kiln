import * as React from "react"
import { TriangleAlert } from "lucide-react"
import { Button } from "@workspace/ui/components/button"

import type { ConsoleStreamStore } from "./console-stores"
import { ConsoleTooltip } from "./console-tooltip"

export const ConsoleRetryButton = React.memo(function ConsoleRetryButton({
  streamStore,
  showLabel = false,
}: {
  streamStore: ConsoleStreamStore
  showLabel?: boolean
}) {
  const getError = React.useCallback(
    () => streamStore.getSnapshot().error,
    [streamStore]
  )
  const error = React.useSyncExternalStore(
    streamStore.subscribe,
    getError,
    getError
  )
  if (!error) return null
  return (
    <ConsoleTooltip
      content={`${error} Retry without reloading the page. Output and filters are kept.`}
    >
      <Button
        aria-label="Retry console connection"
        variant="ghost"
        size={showLabel ? "sm" : "icon-sm"}
        className="text-amber-300"
        onClick={streamStore.retry}
      >
        <TriangleAlert className="size-3.5" />
        {showLabel ? "Retry" : null}
      </Button>
    </ConsoleTooltip>
  )
})
