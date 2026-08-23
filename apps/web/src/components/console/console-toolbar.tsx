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
  const { data: reason } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectReason,
  })
  return reason ? <ConsoleRuntimeReasonContent reason={reason} /> : null
})

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
        className="flex max-w-64 min-w-0 shrink items-center gap-1.5 text-[0.625rem] font-medium text-amber-300 outline-none sm:text-xs"
        role="status"
        tabIndex={0}
      >
        <TriangleAlert className="size-3.5 shrink-0" />
        <span className="hidden truncate xl:inline">{message}</span>
      </span>
    </ConsoleTooltip>
  )
}
