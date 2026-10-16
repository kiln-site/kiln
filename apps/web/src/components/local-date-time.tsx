import * as React from "react"

const formatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
})
const subscribe = () => () => {}
const serverSnapshot = () => "—"

function timestampSnapshot(timestamp: string, dateOnly: boolean) {
  const format = dateOnly ? dateFormatter : formatter
  return () => format.format(new Date(timestamp))
}

// Only this label updates after hydration, using the browser's locale and
// timezone. The server and the first client render share the same placeholder.
export const LocalDateTime = React.memo(function LocalDateTime({
  dateOnly = false,
  timestamp,
}: {
  dateOnly?: boolean
  timestamp: string
}) {
  const snapshot = React.useMemo(
    () => timestampSnapshot(timestamp, dateOnly),
    [dateOnly, timestamp]
  )
  const text = React.useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  return <time dateTime={timestamp}>{text}</time>
})
