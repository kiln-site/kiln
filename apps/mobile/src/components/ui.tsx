import { SymbolView, type SymbolViewProps } from "expo-symbols"
import type { ReactNode } from "react"
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
  type TextProps,
} from "react-native"

import { cn } from "../lib/cn"
import { usePalette, type PaletteColor } from "../lib/palette"
import { useBarInset } from "./chrome"

export function AppText(props: TextProps & { readonly className?: string }) {
  const { className, ...rest } = props
  return (
    <Text
      {...rest}
      className={cn("font-sans text-sm text-foreground", className)}
    />
  )
}

/** Technical values (IDs, addresses, numbers) use Hearth's mono face. */
export function MonoText(props: TextProps & { readonly className?: string }) {
  const { className, ...rest } = props
  return (
    <Text
      {...rest}
      className={cn("font-mono text-sm text-foreground", className)}
    />
  )
}

export function Icon(props: {
  readonly name: SymbolViewProps["name"]
  readonly size?: number
  readonly color?: PaletteColor
}) {
  const palette = usePalette()
  return (
    <SymbolView
      // Icons sit beside a text label; VoiceOver should read only the label.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      name={props.name}
      size={props.size ?? 18}
      tintColor={palette[props.color ?? "foreground"]}
      weight="medium"
    />
  )
}

/** Small uppercase label above a group, as Hearth's section headings. */
export function SectionLabel(props: {
  readonly children: ReactNode
  readonly trailing?: ReactNode
}) {
  return (
    <View className="mt-6 mb-2 flex-row items-end justify-between px-1">
      <AppText className="font-mono-medium text-2xs text-foreground-muted tracking-widest uppercase">
        {props.children}
      </AppText>
      {props.trailing}
    </View>
  )
}

export function Card(props: {
  readonly children: ReactNode
  readonly className?: string
}) {
  return (
    <View
      className={cn("border border-border bg-card", props.className)}
      style={{ borderCurve: "continuous" }}
    >
      {props.children}
    </View>
  )
}

export function Divider() {
  return <View className="ml-4 h-px bg-border" />
}

export function Row(props: {
  readonly title: string
  readonly subtitle?: string
  readonly leading?: ReactNode
  readonly trailing?: ReactNode
  readonly onPress?: () => void
  readonly mono?: boolean
}) {
  const content = (
    <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
      {props.leading}
      <View className="min-w-0 flex-1">
        <AppText className="text-base font-medium" numberOfLines={1}>
          {props.title}
        </AppText>
        {props.subtitle ? (
          props.mono ? (
            <MonoText
              className="text-foreground-muted mt-0.5 text-xs"
              numberOfLines={1}
            >
              {props.subtitle}
            </MonoText>
          ) : (
            <AppText
              className="text-foreground-muted mt-0.5 text-xs"
              numberOfLines={1}
            >
              {props.subtitle}
            </AppText>
          )
        ) : null}
      </View>
      {props.trailing}
      {props.onPress ? (
        <Icon name="chevron.right" size={13} color="muted" />
      ) : null}
    </View>
  )
  if (!props.onPress) return content
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="active:bg-raised"
    >
      {content}
    </Pressable>
  )
}

const BUTTON_TONES = {
  primary: {
    box: "bg-primary border-primary",
    text: "text-primary-foreground",
    icon: "primaryForeground",
  },
  secondary: {
    box: "bg-card border-border",
    text: "text-foreground",
    icon: "foreground",
  },
  danger: { box: "bg-card border-danger", text: "text-danger", icon: "danger" },
} as const satisfies Record<
  string,
  { box: string; text: string; icon: PaletteColor }
>

export function Button(props: {
  readonly label: string
  readonly onPress: () => void
  readonly tone?: keyof typeof BUTTON_TONES
  readonly icon?: SymbolViewProps["name"]
  readonly disabled?: boolean
  readonly loading?: boolean
  readonly className?: string
}) {
  const tone = BUTTON_TONES[props.tone ?? "secondary"]
  const disabled = Boolean(props.disabled || props.loading)
  const palette = usePalette()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled, busy: Boolean(props.loading) }}
      disabled={disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-12 flex-row items-center justify-center gap-2 border px-4 active:opacity-70",
        tone.box,
        disabled && "opacity-50",
        props.className
      )}
    >
      {props.loading ? (
        <ActivityIndicator color={palette[tone.icon]} />
      ) : props.icon ? (
        <Icon name={props.icon} size={16} color={tone.icon} />
      ) : null}
      <AppText className={cn("text-sm font-semibold", tone.text)}>
        {props.label}
      </AppText>
    </Pressable>
  )
}

type StateTone = "success" | "warning" | "danger" | "muted" | "info"

const STATE_TONES: Record<string, StateTone> = {
  running: "success",
  connected: "success",
  starting: "warning",
  stopping: "warning",
  provisioning: "info",
  installing: "info",
  updating: "info",
  stopped: "muted",
  offline: "muted",
  failed: "danger",
  unreachable: "danger",
  missing: "danger",
}

const DOT = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  muted: "bg-foreground-muted",
  info: "bg-info",
} as const

const LABEL = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  muted: "text-foreground-muted",
  info: "text-info",
} as const

export function stateTone(state: string): StateTone {
  return STATE_TONES[state] ?? "muted"
}

export function StatePill(props: { readonly state: string }) {
  const tone = stateTone(props.state)
  return (
    <View className="flex-row items-center gap-1.5">
      <View className={cn("size-2", DOT[tone])} />
      <MonoText className={cn("text-xs", LABEL[tone])}>{props.state}</MonoText>
    </View>
  )
}

/** A labelled bar for a used/limit pair, such as memory or disk. */
export function Meter(props: {
  readonly label: string
  readonly value: string
  readonly detail?: string
  readonly ratio: number | null
  /** Usage without a hard limit, like CPU across cores, never warns. */
  readonly neutral?: boolean
}) {
  const ratio =
    props.ratio === null ? null : Math.min(Math.max(props.ratio, 0), 1)
  const tone =
    ratio === null
      ? "bg-foreground-muted"
      : props.neutral
        ? "bg-primary"
        : ratio > 0.9
          ? "bg-danger"
          : ratio > 0.75
            ? "bg-warning"
            : "bg-primary"
  return (
    <View className="flex-1 gap-2 p-4">
      <AppText className="font-mono-medium text-2xs text-foreground-muted tracking-widest uppercase">
        {props.label}
      </AppText>
      <MonoText className="font-mono-medium text-xl">{props.value}</MonoText>
      <View className="bg-raised h-1">
        {ratio !== null ? (
          <View
            className={cn("h-1", tone)}
            style={{ width: `${ratio * 100}%` }}
          />
        ) : null}
      </View>
      {props.detail ? (
        <MonoText className="text-2xs text-foreground-muted">
          {props.detail}
        </MonoText>
      ) : null}
    </View>
  )
}

export function Screen(props: {
  readonly children: ReactNode
  readonly refreshing?: boolean
  readonly onRefresh?: () => void
}) {
  const palette = usePalette()
  const barInset = useBarInset()
  return (
    <ScrollView
      className="bg-screen flex-1"
      contentContainerClassName="px-4"
      contentContainerStyle={{ paddingBottom: barInset }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      refreshControl={
        props.onRefresh ? (
          <RefreshControl
            refreshing={props.refreshing ?? false}
            onRefresh={props.onRefresh}
            tintColor={palette.primary}
          />
        ) : undefined
      }
    >
      {props.children}
    </ScrollView>
  )
}

export function Notice(props: {
  readonly title: string
  readonly message?: string
  readonly tone?: "danger" | "muted"
  readonly action?: { readonly label: string; readonly onPress: () => void }
}) {
  const danger = props.tone === "danger"
  return (
    <Card className={cn("gap-1 p-4", danger && "border-danger")}>
      <AppText className={cn("text-sm font-semibold", danger && "text-danger")}>
        {props.title}
      </AppText>
      {props.message ? (
        <AppText className="text-foreground-muted text-sm">
          {props.message}
        </AppText>
      ) : null}
      {props.action ? (
        <Button
          label={props.action.label}
          onPress={props.action.onPress}
          className="mt-3 self-start"
        />
      ) : null}
    </Card>
  )
}

export function Loading() {
  const palette = usePalette()
  return (
    <View className="items-center py-10">
      <ActivityIndicator color={palette.primary} />
    </View>
  )
}

export type InstanceKind = "relay" | "server" | "database" | "app" | "tunnel"

const KIND_ICONS = {
  relay: { name: "antenna.radiowaves.left.and.right", color: "kindRelay" },
  server: { name: "server.rack", color: "kindServer" },
  database: { name: "cylinder", color: "kindDatabase" },
  app: { name: "cube", color: "kindApp" },
  tunnel: {
    name: "point.3.connected.trianglepath.dotted",
    color: "kindTunnel",
  },
} as const satisfies Record<
  InstanceKind,
  { name: SymbolViewProps["name"]; color: PaletteColor }
>

/**
 * An instance's icon as Hearth draws it: the kind's glyph in its own colour,
 * in a square tile, with the status dot on its corner.
 */
export function KindTile(props: {
  readonly kind: InstanceKind
  readonly state?: string
  readonly size?: number
}) {
  const size = props.size ?? 36
  const icon = KIND_ICONS[props.kind]
  return (
    <View
      className="bg-screen items-center justify-center border border-border"
      style={{ width: size, height: size }}
    >
      <Icon
        name={icon.name}
        size={Math.round(size * 0.47)}
        color={icon.color}
      />
      {props.state ? (
        <View
          className={cn(
            "absolute -right-[3px] -bottom-[3px] size-2.5 rounded-full border-2 border-card",
            DOT[stateTone(props.state)]
          )}
        />
      ) : null}
    </View>
  )
}

/** The page title, under the area it belongs to, as Hearth's breadcrumb. */
export function PageHeading(props: {
  readonly eyebrow: string
  readonly title: string
  readonly trailing?: ReactNode
}) {
  return (
    <View className="flex-row items-end justify-between pt-1 pb-5">
      <View accessibilityRole="header" accessible>
        <MonoText className="text-2xs text-foreground-muted tracking-widest uppercase">
          {props.eyebrow}
        </MonoText>
        <AppText className="mt-1 text-3xl font-semibold tracking-tight">
          {props.title}
        </AppText>
      </View>
      {props.trailing}
    </View>
  )
}
