import * as React from "react"

const formatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})
const subscribe = () => () => {}
const serverSnapshot = () => "—"

function timestampSnapshot(timestamp: string) {
  return () => formatter.format(new Date(timestamp))
}

// Only this label updates after hydration, using the browser's locale and
// timezone. The server and the first client render share the same placeholder.
export const LocalDateTime = React.memo(function LocalDateTime({
  timestamp,
}: {
  timestamp: string
}) {
  const snapshot = React.useMemo(
    () => timestampSnapshot(timestamp),
    [timestamp]
  )
  const text = React.useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  return <time dateTime={timestamp}>{text}</time>
})
