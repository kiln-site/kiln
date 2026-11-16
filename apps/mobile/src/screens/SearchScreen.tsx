import { useNavigation } from "@react-navigation/native"
import { useLayoutEffect, useState, type ReactElement } from "react"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import { FlatList, Pressable, View } from "react-native"

import { AppText, Icon, MonoText } from "../components/ui"
import {
  INFRA_PAGES,
  MANAGE_PAGES,
  showSection,
  type RootStackParamList,
  type SectionParams,
} from "../navigation"

const DESTINATIONS = [
  ...INFRA_PAGES.map((page) => ({
    key: `infra:${page.id}`,
    label: page.label,
    symbol: page.symbol,
    area: "Infrastructure",
    params: { area: "infra", page: page.id } satisfies SectionParams,
  })),
  ...MANAGE_PAGES.map((page) => ({
    key: `manage:${page.id}`,
    label: page.label,
    symbol: page.symbol,
    area: "Manage",
    params: { area: "manage", page: page.id, sub: page.pages[0]?.id } satisfies SectionParams,
  })),
]

/** Kiln's command menu. Pages only for now; instances and actions come later. */
export function SearchScreen(): ReactElement {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList, "Search">>()
  const [query, setQuery] = useState("")

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: "Search Kiln",
        autoFocus: true,
        hideNavigationBar: false,
        onChangeText: (event) => setQuery(event.nativeEvent.text),
      },
    })
  }, [navigation])

  const needle = query.trim().toLowerCase()
  const results = needle
    ? DESTINATIONS.filter((entry) =>
        `${entry.label} ${entry.area}`.toLowerCase().includes(needle)
      )
    : DESTINATIONS

  return (
    <FlatList
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      data={results}
      keyExtractor={(entry) => entry.key}
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          onPress={() => showSection(navigation, item.params)}
          className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-raised"
        >
          <View className="size-8 items-center justify-center border border-border bg-card">
            <Icon name={item.symbol} size={15} color="muted" />
          </View>
          <AppText className="flex-1 font-medium text-base">{item.label}</AppText>
          <MonoText className="text-2xs uppercase tracking-widest text-foreground-muted">
            {item.area}
          </MonoText>
        </Pressable>
      )}
      ListEmptyComponent={
        <AppText className="p-8 text-center text-sm text-foreground-muted">
          Nothing matches “{query.trim()}”.
        </AppText>
      }
    />
  )
}
