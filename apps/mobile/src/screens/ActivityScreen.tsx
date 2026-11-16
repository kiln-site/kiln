import type { ReactElement } from "react"
import { FlatList, View } from "react-native"

import { errorMessage } from "../api/hearth"
import { useActivity } from "../api/queries"
import { ActivityRow } from "../components/ActivityRow"
import { useBarInset } from "../components/chrome"
import { AppText, Loading, Notice, PageHeading } from "../components/ui"

export function ActivityScreen(): ReactElement {
  const activity = useActivity()
  const barInset = useBarInset()

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
      contentContainerStyle={{ paddingBottom: barInset }}
      data={activity.data ?? []}
      keyExtractor={(entry) => entry.id}
      renderItem={({ item }) => <ActivityRow entry={item} />}
      refreshing={activity.isRefetching}
      onRefresh={() => void activity.refetch()}
      ListHeaderComponent={
        <View className="px-4">
          <PageHeading eyebrow="Manage" title="Activity" />
          {activity.isError ? (
            <View className="pb-4">
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
          <AppText className="p-8 text-center text-sm text-foreground-muted">
            Nothing has happened yet.
          </AppText>
        )
      }
    />
  )
}
