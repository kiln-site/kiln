import * as React from "react"

import { cn } from "@workspace/ui/lib/utils"

import {
  VolumeKindIcon,
  instanceKindIcons,
} from "@/components/instance-kind-icon"

export interface InstanceKindCountValues {
  apps: number
  databases: number
  instances: number
  relays: number
  /** Volumes aren't instances, and are counted only where something has them. */
  volumes?: number
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
  {
    key: "volumes",
    icon: VolumeKindIcon,
    one: "volume",
    other: "volumes",
  },
] as const

/**
 * A count per kind of instance, dimmed at zero. The counts take no pointer
 * events, so a click reaches whatever sits behind or around them.
 */
export const InstanceKindCounts = React.memo(function InstanceKindCounts({
  atLeast,
  counts,
  volumes = "some",
}: {
  /** Kinds there may be more of than counted, as volumes not yet known. */
  atLeast?: ReadonlyArray<keyof InstanceKindCountValues>
  counts: InstanceKindCountValues
  /** `always` counts volumes at zero too, where they're among what's said. */
  volumes?: "always" | "some"
}) {
  return instanceKinds.map(({ key, icon: Icon, one, other }) => {
    const count = counts[key] ?? 0
    // Shown only where there are some, so a list without any keeps its
    // four kinds.
    if (key === "volumes" && !count && volumes === "some") return null
    const more = atLeast?.includes(key) === true
    return (
      <span
        key={key}
        title={`${more ? "At least " : ""}${count} ${count === 1 && !more ? one : other}`}
        className={cn(
          "pointer-events-none flex items-center gap-1 tabular-nums",
          count || more ? "text-foreground" : "opacity-40"
        )}
      >
        <Icon className="size-3.5" aria-hidden="true" />
        {count}
        {more ? "+" : null}
        <span className="sr-only">
          {more ? " or more " : ""}
          {count === 1 && !more ? one : other}
        </span>
      </span>
    )
  })
})
