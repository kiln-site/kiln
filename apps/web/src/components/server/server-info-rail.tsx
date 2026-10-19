import * as React from "react"

import { InstanceInfoRail, InfoContainerCard } from "@/components/resource-info-rail"
import {
  formatCpuLimit,
  formatDiskLimit,
  formatMemoryLimit,
} from "@/lib/resource-limits"
import type {
  InstanceSettingsInstance,
  RelayNodeSummary,
} from "@/lib/relay-selectors"

// What the game server is at a glance. Its name, status, and usage are in
// the header.
export function ServerInfoRail({
  instance,
  node,
}: {
  instance: InstanceSettingsInstance
  node: RelayNodeSummary
}) {
  const resource = React.useMemo(
    () => ({
      id: instance.id,
      kind: "instance" as const,
      relayId: instance.relayId,
    }),
    [instance.id, instance.relayId]
  )
  return (
    <InstanceInfoRail
      relayName={node.name}
      resource={resource}
      container={
        <InfoContainerCard
          containerId={instance.containerId}
          // Older Relays don't report the server's folder.
          dataDirectory={instance.hostDirectory ?? null}
          cpu={formatCpuLimit(instance.limits.cpuMillis)}
          disk={formatDiskLimit(instance.limits.diskBytes)}
          memory={formatMemoryLimit(instance.limits.memoryBytes)}
          name={instance.service}
        />
      }
    />
  )
}
