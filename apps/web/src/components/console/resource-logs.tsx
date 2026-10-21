import * as React from "react"
import type { RelayBrowserResourceKind } from "@workspace/contracts"

import { ConsoleCopyContext } from "@/components/console/console-copy-context"
import {
  ConsoleLevelMenu,
  ConsoleSearchControl,
  consoleToolbarClassName,
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
import { consoleCopy } from "@/lib/console-copy"

type LogsResourceKind = Exclude<RelayBrowserResourceKind, "instance">

// The server console without its command bar: a database's, an app's, or a
// Relay's container output, followed live the same way. Key it by resource so
// a different one starts a fresh session.
export function ResourceLogsSession({
  header,
  id,
  kind,
  relayAvailable,
  relayId,
  stream,
}: {
  // Shown above the toolbar, for picking between a resource's outputs.
  header?: React.ReactNode
  id: string
  kind: LogsResourceKind
  relayAvailable: boolean
  relayId: string
  // Which of the resource's outputs to follow, for kinds with more than one.
  stream?: string
}) {
  const [uiStore] = React.useState(createConsoleUiStore)
  const [streamStore] = React.useState(createConsoleStreamStore)

  return (
    <ConsoleCopyContext.Provider value={consoleCopy[kind]}>
      <section className="flex min-h-0 flex-1 flex-col bg-card">
        <ResourceLogsStreamController
          id={id}
          kind={kind}
          relayAvailable={relayAvailable}
          relayId={relayId}
          stream={stream}
          streamStore={streamStore}
        />
        {header}
        <ResourceLogsToolbar streamStore={streamStore} uiStore={uiStore} />
        <ConsoleLogViewportController
          active
          streamStore={streamStore}
          uiStore={uiStore}
        />
      </section>
    </ConsoleCopyContext.Provider>
  )
}

const ResourceLogsToolbar = React.memo(function ResourceLogsToolbar({
  streamStore,
  uiStore,
}: {
  streamStore: ConsoleStreamStore
  uiStore: ConsoleUiStore
}) {
  return (
    <div className={consoleToolbarClassName}>
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

const ResourceLogsStreamController = React.memo(
  function ResourceLogsStreamController({
    id,
    kind,
    relayAvailable,
    relayId,
    stream,
    streamStore,
  }: {
    id: string
    kind: LogsResourceKind
    relayAvailable: boolean
    relayId: string
    stream: string | undefined
    streamStore: ConsoleStreamStore
  }) {
    const retryVersion = React.useSyncExternalStore(
      streamStore.subscribeRetry,
      streamStore.getRetrySnapshot,
      streamStore.getRetrySnapshot
    )
    const resource = React.useMemo(
      () => (stream === undefined ? { id, kind } : { id, kind, stream }),
      [id, kind, stream]
    )
    const snapshot = useRelayConsoleStream(
      relayId,
      resource,
      relayAvailable,
      useRelayBrowserOrigin(relayId),
      useRelayConsoleTransport(relayId),
      // Only servers have a runtime, so no server state lines.
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
