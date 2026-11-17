import type { ReactElement } from "react"
import { FlatList, View } from "react-native"

import { errorMessage } from "../api/hearth"
import { useActivity } from "../api/queries"
import { ActivityRow } from "../components/ActivityRow"
import { useBarInset, usePullToRefresh } from "../components/chrome"
import { AppText, Loading, Notice } from "../components/ui"

export function ActivityScreen(): ReactElement {
  const activity = useActivity()
  const barInset = useBarInset()
  const pull = usePullToRefresh(() => activity.refetch())

  if (activity.isPending)
    return (
      <View className="bg-screen flex-1">
        <Loading />
      </View>
    )

  return (
    <FlatList
      className="bg-screen flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: barInset }}
      data={activity.data ?? []}
      keyExtractor={(entry) => entry.id}
      renderItem={({ item }) => <ActivityRow entry={item} />}
      refreshing={pull.refreshing}
      onRefresh={pull.onRefresh}
      ListHeaderComponent={
        <View className="px-4">
          {activity.isError ? (
            <View className="py-4">
              <Notice
                tone="danger"
                title="Couldn't load activity"
                message={errorMessage(activity.error)}
              />
            </View>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        activity.isError ? undefined : (
          <AppText className="text-foreground-muted p-8 text-center text-sm">
            Nothing has happened yet.
          </AppText>
        )
      }
    />
  )
}
