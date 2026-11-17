import type { SFSymbol } from "expo-symbols"
import type { ReactNode } from "react"
import { Pressable, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { cn } from "../lib/cn"
import { AppText, Icon, MonoText } from "./ui"

/** A sheet that slides up from the bar: a small heading, then its rows. */
export function DrawerSheet(props: {
  readonly title: string | undefined
  readonly children: ReactNode
}) {
  const insets = useSafeAreaInsets()
  return (
    <View
      className="pt-5"
      style={{ paddingBottom: Math.max(insets.bottom, 16) }}
    >
      <MonoText className="text-2xs text-foreground-muted px-6 pb-2 tracking-widest uppercase">
        {props.title}
      </MonoText>
      {props.children}
    </View>
  )
}

/** A drawer row: an icon tile and a label, current or destructive. */
export function DrawerRow(props: {
  readonly symbol: SFSymbol
  readonly label: string
  readonly onPress: () => void
  readonly selected?: boolean
  readonly tone?: "danger"
  readonly trailing?: ReactNode
}) {
  const accent = props.selected
    ? "primaryText"
    : props.tone === "danger"
      ? "danger"
      : "muted"
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(props.selected) }}
      onPress={props.onPress}
      className="active:bg-raised min-h-13 flex-row items-center gap-3 px-6 py-2.5"
    >
      <View
        className={cn(
          "size-9 items-center justify-center border bg-card",
          props.selected
            ? "border-primary"
            : props.tone === "danger"
              ? "border-danger"
              : "border-border"
        )}
      >
        <Icon name={props.symbol} size={17} color={accent} />
      </View>
      <AppText
        className={cn(
          "flex-1 text-base font-medium",
          props.selected && "text-primary-text",
          props.tone === "danger" && "text-danger"
        )}
      >
        {props.label}
      </AppText>
      {props.trailing ??
        (props.selected ? (
          <Icon name="checkmark" size={15} color="primaryText" />
        ) : null)}
    </Pressable>
  )
}
