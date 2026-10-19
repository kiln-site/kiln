import * as React from "react"
import { Boxes, Database, RadioTower, Server } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

export interface InstanceKindCountValues {
  apps: number
  databases: number
  instances: number
  relays: number
}

// The same icons and colours as the infrastructure map's Relay cards.
const instanceKinds = [
  {
    key: "relays",
    icon: RadioTower,
    tone: "text-primary",
    one: "Relay",
    other: "Relays",
  },
  {
    key: "instances",
    icon: Server,
    tone: "text-emerald-300",
    one: "game server",
    other: "game servers",
  },
  {
    key: "apps",
    icon: Boxes,
    tone: "text-red-300",
    one: "app",
    other: "apps",
  },
  {
    key: "databases",
    icon: Database,
    tone: "text-blue-300",
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
  return instanceKinds.map(({ key, icon: Icon, tone, one, other }) => {
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
        <Icon className={cn("size-3.5", tone)} aria-hidden="true" />
        {count}
        <span className="sr-only">{count === 1 ? one : other}</span>
      </span>
    )
  })
})
