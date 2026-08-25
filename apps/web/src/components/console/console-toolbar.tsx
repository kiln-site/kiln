import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  formatRelayInstanceStateReason,
  type RelayInstanceStateReason,
} from "@workspace/contracts"
import { TriangleAlert } from "lucide-react"

import {
  ConsoleLevelMenu,
  ConsoleSearchControl,
  TailscaleConsoleFilterMenus,
} from "@/components/console/console-filters"
import { consoleRuntimeReasonDelayRemaining } from "@/components/console/console-lifecycle"
import type {
  ConsoleStreamStore,
  ConsoleUiStore,
} from "@/components/console/console-stores"
import {
  ConsoleRedactButton,
  ConsoleSelectionControl,
  ConsoleShareButton,
  ConsoleTimestampButton,
  ConsoleWrapButton,
} from "@/components/console/console-toolbar-actions"
import { ConsoleTooltip } from "@/components/console/console-tooltip"
import { relaySnapshotQueryOptions } from "@/lib/query-options"
import {
  selectInstanceLifecycleStartedAt,
  selectInstanceStateReason,
  type InstanceWorkspaceInstance,
} from "@/lib/relay-selectors"

interface ConsoleToolbarProps {
  active: boolean
  canShare: boolean
  instance: InstanceWorkspaceInstance
  streamStore: ConsoleStreamStore
  uiStore: ConsoleUiStore
}

export const ConsoleToolbar = React.memo(function ConsoleToolbar({
  active,
  canShare,
  instance,
  streamStore,
  uiStore,
}: ConsoleToolbarProps) {
  return (
    <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2.5 sm:px-4">
      <ConsoleSearchControl uiStore={uiStore} />
      <ConsoleLevelMenu uiStore={uiStore} />
      {instance.implementation.toLowerCase() === "tailscale" ? (
        <TailscaleConsoleFilterMenus
          instanceId={instance.id}
          uiStore={uiStore}
        />
      ) : null}
      <ConsoleRuntimeReason
        instanceId={instance.id}
        relayId={instance.relayId}
      />
      <div className="ml-auto flex items-center gap-1.5">
        <ConsoleShareButton
          canShare={canShare}
          instance={instance}
          streamStore={streamStore}
          uiStore={uiStore}
        />
        <ConsoleSelectionControl active={active} uiStore={uiStore} />
        <ConsoleRedactButton uiStore={uiStore} />
        {canShare ? <ConsoleWrapButton uiStore={uiStore} /> : null}
        <ConsoleTimestampButton uiStore={uiStore} />
      </div>
    </div>
  )
})

const ConsoleRuntimeReason = React.memo(function ConsoleRuntimeReason({
  instanceId,
  relayId,
}: {
  instanceId: string
  relayId: string
}) {
  const selectReason = React.useMemo(
    () => selectInstanceStateReason(instanceId, relayId),
    [instanceId, relayId]
  )
  const selectStartedAt = React.useMemo(
    () => selectInstanceLifecycleStartedAt(instanceId, relayId),
    [instanceId, relayId]
  )
  const { data: reason } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectReason,
  })
  const { data: startedAt = null } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectStartedAt,
  })
  if (!reason) return null
  return reason.code === "waiting_for_readiness" ? (
    <DelayedConsoleRuntimeReasonContent
      key={startedAt ?? "unknown"}
      reason={reason}
      startedAt={startedAt}
    />
  ) : (
    <ConsoleRuntimeReasonContent reason={reason} />
  )
})

function DelayedConsoleRuntimeReasonContent({
  reason,
  startedAt,
}: {
  reason: RelayInstanceStateReason
  startedAt: string | null
}) {
  const [visible, setVisible] = React.useState(
    () => consoleRuntimeReasonDelayRemaining(reason, startedAt) === 0
  )
  React.useEffect(() => {
    const remaining = consoleRuntimeReasonDelayRemaining(reason, startedAt)
    if (remaining === 0) {
      setVisible(true)
      return
    }
    setVisible(false)
    const timer = window.setTimeout(() => setVisible(true), remaining)
    return () => window.clearTimeout(timer)
  }, [reason, startedAt])
  return visible ? <ConsoleRuntimeReasonContent reason={reason} /> : null
}

function ConsoleRuntimeReasonContent({
  reason,
}: {
  reason: RelayInstanceStateReason
}) {
  const message = formatRelayInstanceStateReason(reason)
  return (
    <ConsoleTooltip content={message}>
      <span
        aria-label={`Server state reason: ${message}`}
        className="inline-flex shrink-0 items-center text-amber-300 outline-none"
        role="status"
        tabIndex={0}
      >
        <TriangleAlert className="size-3.5 shrink-0" />
      </span>
    </ConsoleTooltip>
  )
}
