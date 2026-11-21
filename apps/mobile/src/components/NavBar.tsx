import type { NavigationContainerRef } from "@react-navigation/native"
import * as Haptics from "expo-haptics"
import type { SFSymbol } from "expo-symbols"
import type { ReactElement } from "react"
import { Pressable, View, useColorScheme, type ViewStyle } from "react-native"

import { NativeNavBar, type NavContext } from "../../modules/kiln-native"
import { cn } from "../lib/cn"
import { usePalette } from "../lib/palette"
import {
  TABS,
  contextDrawer,
  tabOf,
  type ContentRoute,
  type DrawerKind,
  type Tab,
} from "../menus"
import { HOME, showSection, type RootStackParamList } from "../navigation"
import { BAR_HEIGHT, useBarFrame, useKeyboardOpen } from "./chrome"
import { AppText, Icon } from "./ui"

type Navigation = NavigationContainerRef<RootStackParamList>

/**
 * The floating bottom bar. Home goes straight to Home; Infra and Manage open
 * a drawer of their pages, and the circle a drawer of the pages of what's on
 * screen.
 */
export function NavBar(props: {
  readonly navigation: Navigation
  readonly route: ContentRoute
  /** The drawer open over the page, which its tab shows as selected. */
  readonly drawer: DrawerKind | null
}): ReactElement | null {
  const palette = usePalette()
  const scheme = useColorScheme()
  const frame = useBarFrame()
  // The bar would sit on the keyboard; inputs above it take its place.
  if (useKeyboardOpen()) return null

  const drawer = contextDrawer(props.route)
  const context: NavContext | null = drawer
    ? { title: `${drawer.title} pages`, systemImage: drawer.symbol }
    : null
  const selected: Tab =
    props.drawer && props.drawer !== "context"
      ? props.drawer
      : tabOf(props.route)
  const onSelect = (id: string) => {
    void Haptics.selectionAsync()
    if (id === "home") showSection(props.navigation, HOME)
    else if (id === "infra" || id === "manage" || id === "context")
      props.navigation.navigate("Drawer", { kind: id })
  }

  if (NativeNavBar) {
    return (
      <NativeNavBar
        // UIKit's tab bar insets itself from the screen's edges and keeps
        // above the home indicator.
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 128,
        }}
        pointerEvents="box-none"
        sections={TABS}
        selectedSection={selected}
        context={context}
        tint={palette.primaryText}
        appearance={scheme === "light" ? "light" : "dark"}
        onSelect={(event) => onSelect(event.nativeEvent.id)}
      />
    )
  }
  return (
    <FallbackNavBar
      style={{
        position: "absolute",
        left: 16,
        right: 16,
        bottom: frame.bottom,
        height: BAR_HEIGHT,
      }}
      selected={selected}
      context={context}
      onSelect={onSelect}
    />
  )
}

/** Android: the same bar drawn in React Native. */
function FallbackNavBar(props: {
  readonly style: ViewStyle
  readonly selected: Tab
  readonly context: NavContext | null
  readonly onSelect: (id: string) => void
}): ReactElement {
  return (
    <View
      style={props.style}
      pointerEvents="box-none"
      className="flex-row items-end justify-between"
    >
      <View className="h-full flex-row rounded-full border border-border bg-card p-1">
        {TABS.map((tab) => {
          const selected = tab.id === props.selected
          return (
            <Pressable
              key={tab.id}
              accessibilityRole="button"
              accessibilityLabel={tab.title}
              accessibilityState={{ selected }}
              onPress={() => props.onSelect(tab.id)}
              className={cn(
                "w-20 items-center justify-center gap-0.5 rounded-full",
                selected && "bg-raised"
              )}
            >
              <Icon
                name={tab.systemImage}
                color={selected ? "primaryText" : "foreground"}
              />
              <AppText
                className={cn(
                  "text-2xs font-medium",
                  selected && "text-primary-text"
                )}
              >
                {tab.title}
              </AppText>
            </Pressable>
          )
        })}
      </View>
      {props.context ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.context.title}
          onPress={() => props.onSelect("context")}
          className="size-[62px] items-center justify-center rounded-full border border-border bg-card"
        >
          <Icon name={props.context.systemImage as SFSymbol} size={20} />
        </Pressable>
      ) : null}
    </View>
  )
}
