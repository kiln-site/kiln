import * as React from "react"

import { InstanceInfoRail } from "@/components/resource-info-rail"
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
      name: instance.name,
      relayId: instance.relayId,
    }),
    [instance.id, instance.name, instance.relayId]
  )
  return (
    <InstanceInfoRail relayName={node.name} resource={resource} />
  )
}
