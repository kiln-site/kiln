import type { SymbolViewProps } from "expo-symbols"
import { View } from "react-native"

import type { ActivityEntry } from "../api/queries"
import { cn } from "../lib/cn"
import { formatRelative } from "../lib/format"
import { AppText, Icon, MonoText } from "./ui"

const TYPE_ICONS: Record<ActivityEntry["type"], SymbolViewProps["name"]> = {
  server: "server.rack",
  power: "power",
  console: "terminal",
  files: "doc",
  network: "network",
  access: "person.badge.key",
  relay: "antenna.radiowaves.left.and.right",
  updates: "arrow.down.circle",
  system: "gearshape",
}

export function ActivityRow(props: {
  readonly entry: ActivityEntry
  /** A rule under the row; off for the last row inside a card. */
  readonly divider?: boolean
}) {
  const { entry } = props
  return (
    <View
      className={cn(
        "flex-row gap-3 px-4 py-3",
        props.divider !== false && "border-b border-border"
      )}
    >
      <View className="pt-0.5">
        <Icon name={TYPE_ICONS[entry.type]} size={16} color="muted" />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <AppText className="text-sm">{entry.label}</AppText>
        <MonoText className="text-2xs text-foreground-muted" numberOfLines={1}>
          {[entry.actor.name, entry.server?.name ?? entry.relay.name, entry.source]
            .filter(Boolean)
            .join(" · ")}
        </MonoText>
      </View>
      <MonoText className="text-2xs text-foreground-muted">
        {formatRelative(entry.occurredAt)}
      </MonoText>
    </View>
  )
}

