import type { ReactElement } from "react"
import type { SymbolViewProps } from "expo-symbols"
import { FlatList, View } from "react-native"

import { errorMessage } from "../api/hearth"
import { useActivity, type ActivityEntry } from "../api/queries"
import { AppText, Icon, Loading, MonoText, Notice } from "../components/ui"
import { formatRelative } from "../lib/format"

const TYPE_ICONS: Record<ActivityEntry["type"], SymbolViewProps["name"]> = {
  server: "cube",
  power: "power",
  console: "terminal",
  files: "doc",
  network: "network",
  access: "person.badge.key",
  relay: "server.rack",
  updates: "arrow.down.circle",
  system: "gearshape",
}

function ActivityRow(props: { readonly entry: ActivityEntry }) {
  const { entry } = props
  return (
    <View className="flex-row gap-3 border-b border-border px-4 py-3">
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

export function ActivityScreen(): ReactElement {
  const activity = useActivity()

  if (activity.isPending)
    return (
      <View className="flex-1 bg-screen">
        <Loading />
      </View>
    )

  return (
    <FlatList
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      data={activity.data ?? []}
      keyExtractor={(entry) => entry.id}
      renderItem={({ item }) => <ActivityRow entry={item} />}
      refreshing={activity.isRefetching}
      onRefresh={() => void activity.refetch()}
      ListHeaderComponent={
        activity.isError ? (
          <View className="p-4">
            <Notice
              tone="danger"
              title="Couldn't load activity"
              message={errorMessage(activity.error)}
            />
          </View>
        ) : undefined
      }
      ListEmptyComponent={
        activity.isError ? undefined : (
          <AppText className="p-8 text-center text-sm text-foreground-muted">
            Nothing has happened yet.
          </AppText>
        )
      }
    />
  )
}
