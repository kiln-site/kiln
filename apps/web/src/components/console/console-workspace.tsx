import * as React from "react"

import {
  createConsoleAggregateStreamStore,
  createConsoleStreamStore,
  createConsoleUiStore,
} from "@/components/console/console-stores"
import {
  ConsoleStreamController,
  TailscaleConsoleStreamController,
} from "@/components/console/console-stream-controller"
import { ConsoleCommandBar } from "@/components/console/console-command-bar"
import { ConsoleLogViewportController } from "@/components/console/console-log-viewport"
import { ConsoleToolbar } from "@/components/console/console-toolbar"
import type {
  ConsoleAggregateStreamStore,
  ConsoleStreamStore,
} from "@/components/console/console-stores"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"

export function ConsoleWorkspace({
  instance,
  active,
  canShare,
  canWrite,
}: {
  instance: InstanceWorkspaceInstance
  active: boolean
  canShare: boolean
  canWrite: boolean
}) {
  return (
    <ConsoleWorkspaceSession
      key={`${instance.relayId}:${instance.id}`}
      instance={instance}
      active={active}
      canShare={canShare}
      canWrite={canWrite}
    />
  )
}

function ConsoleWorkspaceSession({
  instance,
  active,
  canShare,
  canWrite,
}: {
  instance: InstanceWorkspaceInstance
  active: boolean
  canShare: boolean
  canWrite: boolean
}) {
  const tailscale = instance.implementation.toLowerCase() === "tailscale"
  const [uiStore] = React.useState(createConsoleUiStore)
  const [streamStore] = React.useState<ConsoleStreamStore>(() =>
    tailscale
      ? createConsoleAggregateStreamStore(instance.id)
      : createConsoleStreamStore()
  )

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-card">
      {tailscale ? (
        <TailscaleConsoleStreamController
          instanceId={instance.id}
          streamStore={streamStore as ConsoleAggregateStreamStore}
        />
      ) : (
        <ConsoleStreamController
          instanceId={instance.id}
          relayId={instance.relayId}
          streamStore={streamStore}
        />
      )}
      <ConsoleToolbar
        active={active}
        canShare={canShare && !tailscale}
        instance={instance}
        streamStore={streamStore}
        uiStore={uiStore}
      />
      <ConsoleLogViewportController
        active={active}
        streamStore={streamStore}
        uiStore={uiStore}
      />

      <ConsoleCommandBar
        active={active}
        canWrite={
          canWrite && instance.implementation.toLowerCase() !== "tailscale"
        }
        instance={instance}
      />
    </section>
  )
}
