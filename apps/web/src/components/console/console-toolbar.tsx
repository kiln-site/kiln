import * as React from "react"
import {
  formatRelayInstanceStateReason,
  type RelayInstanceStateReason,
} from "@workspace/contracts"

import {
  ConsoleLevelMenu,
  ConsoleSearchControl,
  consoleToolbarClassName,
} from "@/components/console/console-filters"
import { consoleRuntimeReasonDelayRemaining } from "@/components/console/console-lifecycle"
import type {
  ConsoleStreamStore,
  ConsoleUiStore,
} from "@/components/console/console-stores"
import {
  ConsoleRedactButton,
  ConsoleSelectionControl,
  ConsoleTimestampButton,
  ConsoleWrapButton,
} from "@/components/console/console-toolbar-actions"
import { ConsoleShareButton } from "@/components/console/console-share-button"
import { TailscaleConsoleFilterMenus } from "@/components/console/console-tailscale-filters"
import { ConsoleWarning } from "@/components/console/console-warning"
import { ConsoleRetryButton } from "@/components/console/console-retry-button"
import { useServerSnapshot } from "@/lib/use-server-workspace"
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
    <div className={consoleToolbarClassName}>
      <ConsoleSearchControl uiStore={uiStore} />
      <ConsoleLevelMenu uiStore={uiStore} />
      <ConsoleRetryButton streamStore={streamStore} />
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
  const { data: reason } = useServerSnapshot(selectReason)
  const { data: startedAt = null } = useServerSnapshot(selectStartedAt)
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
    <ConsoleWarning
      message={message}
      label={`Server state reason: ${message}`}
    />
  )
}
