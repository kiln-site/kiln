import * as React from "react"

import {
  ConsoleLevelMenu,
  ConsoleSearchControl,
} from "@/components/console/console-filters"
import { ConsoleLogViewportController } from "@/components/console/console-log-viewport"
import { ConsoleRetryButton } from "@/components/console/console-retry-button"
import {
  createConsoleStreamStore,
  createConsoleUiStore,
  type ConsoleStreamStore,
  type ConsoleUiStore,
} from "@/components/console/console-stores"
import {
  useRelayBrowserOrigin,
  useRelayConsoleTransport,
} from "@/components/console/console-stream-controller"
import {
  ConsoleRedactButton,
  ConsoleSelectionControl,
  ConsoleTimestampButton,
  ConsoleWrapButton,
} from "@/components/console/console-toolbar-actions"
import { useRelayConsoleStream } from "@/components/console/use-relay-console-stream"
import { databaseRelayAvailable } from "@/components/database/database-presentation"
import { useDatabaseWorkspace } from "@/components/database/database-workspace-context"

// The server console without its command bar: the database container's
// output, followed live the same way.
export function DatabaseLogsPage() {
  const { database } = useDatabaseWorkspace()
  return (
    <DatabaseLogsSession
      key={`${database.relayId}:${database.id}`}
      databaseId={database.id}
      relayAvailable={databaseRelayAvailable(database)}
      relayId={database.relayId}
    />
  )
}

function DatabaseLogsSession({
  databaseId,
  relayAvailable,
  relayId,
}: {
  databaseId: string
  relayAvailable: boolean
  relayId: string
}) {
  const [uiStore] = React.useState(createConsoleUiStore)
  const [streamStore] = React.useState(createConsoleStreamStore)

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-card">
      <DatabaseLogsStreamController
        databaseId={databaseId}
        relayAvailable={relayAvailable}
        relayId={relayId}
        streamStore={streamStore}
      />
      <DatabaseLogsToolbar streamStore={streamStore} uiStore={uiStore} />
      <ConsoleLogViewportController
        active
        streamStore={streamStore}
        uiStore={uiStore}
      />
    </section>
  )
}

const DatabaseLogsToolbar = React.memo(function DatabaseLogsToolbar({
  streamStore,
  uiStore,
}: {
  streamStore: ConsoleStreamStore
  uiStore: ConsoleUiStore
}) {
  return (
    <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2.5 sm:px-4">
      <ConsoleSearchControl uiStore={uiStore} />
      <ConsoleLevelMenu uiStore={uiStore} />
      <ConsoleRetryButton streamStore={streamStore} />
      <div className="ml-auto flex items-center gap-1.5">
        <ConsoleSelectionControl active uiStore={uiStore} />
        <ConsoleRedactButton uiStore={uiStore} />
        <ConsoleWrapButton uiStore={uiStore} />
        <ConsoleTimestampButton uiStore={uiStore} />
      </div>
    </div>
  )
})

const DatabaseLogsStreamController = React.memo(
  function DatabaseLogsStreamController({
    databaseId,
    relayAvailable,
    relayId,
    streamStore,
  }: {
    databaseId: string
    relayAvailable: boolean
    relayId: string
    streamStore: ConsoleStreamStore
  }) {
    const retryVersion = React.useSyncExternalStore(
      streamStore.subscribeRetry,
      streamStore.getRetrySnapshot,
      streamStore.getRetrySnapshot
    )
    const resource = React.useMemo(
      () => ({ id: databaseId, kind: "database" as const }),
      [databaseId]
    )
    const snapshot = useRelayConsoleStream(
      relayId,
      resource,
      relayAvailable,
      useRelayBrowserOrigin(relayId),
      useRelayConsoleTransport(relayId),
      // Databases have no server runtime, so no server state lines.
      null,
      undefined,
      false,
      retryVersion
    )
    React.useLayoutEffect(
      () => streamStore.setSnapshot(snapshot),
      [snapshot, streamStore]
    )
    return null
  }
)
