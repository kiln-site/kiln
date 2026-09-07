import * as React from "react"

import type { ConsoleStreamStore } from "./console-stores"
import { ConsoleWarning } from "./console-warning"

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
    <ConsoleWarning
      message={`${error} Retry without reloading the page. Output and filters are kept`}
      label="Retry console connection"
      action={{
        onClick: streamStore.retry,
        text: showLabel ? "Retry" : undefined,
      }}
    />
  )
})
