import * as React from "react"

import { cn } from "@workspace/ui/lib/utils"

import { instanceKindIcons } from "@/components/instance-kind-icon"

export interface InstanceKindCountValues {
  apps: number
  databases: number
  instances: number
  relays: number
}

// The same icons as the infrastructure map's Relay cards.
const instanceKinds = [
  {
    key: "relays",
    icon: instanceKindIcons.relay,
    one: "Relay",
    other: "Relays",
  },
  {
    key: "instances",
    icon: instanceKindIcons.server,
    one: "game server",
    other: "game servers",
  },
  {
    key: "apps",
    icon: instanceKindIcons.app,
    one: "App",
    other: "Apps",
  },
  {
    key: "databases",
    icon: instanceKindIcons.database,
    one: "database",
    other: "databases",
  },
] as const

/**
 * A count per kind of instance, dimmed at zero. The counts take no pointer
 * events, so a click reaches whatever sits behind or around them.
 */
export const InstanceKindCounts = React.memo(function InstanceKindCounts({
  counts,
}: {
  counts: InstanceKindCountValues
}) {
  return instanceKinds.map(({ key, icon: Icon, one, other }) => {
    const count = counts[key]
    return (
      <span
        key={key}
        title={`${count} ${count === 1 ? one : other}`}
        className={cn(
          "pointer-events-none flex items-center gap-1 tabular-nums",
          count ? "text-foreground" : "opacity-40"
        )}
      >
        <Icon className="size-3.5" aria-hidden="true" />
        {count}
        <span className="sr-only">{count === 1 ? one : other}</span>
      </span>
    )
  })
})
