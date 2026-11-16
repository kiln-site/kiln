import { requireNativeView } from "expo"
import type { ComponentType } from "react"
import {
  Platform,
  type NativeSyntheticEvent,
  type ViewProps,
} from "react-native"

export interface NavItem {
  readonly id: string
  readonly title: string
  readonly systemImage: string
  readonly selected: boolean
}

export interface NavSection {
  readonly id: string
  readonly title: string
  readonly menuTitle: string
  readonly systemImage: string
  readonly items: readonly NavItem[]
}

export interface NavContext {
  readonly title: string
  readonly systemImage: string
  readonly items: readonly NavItem[]
}

export type NativeNavBarProps = ViewProps & {
  readonly sections: readonly NavSection[]
  readonly selectedSection: string | null
  readonly context: NavContext | null
  readonly tint: string
  readonly appearance: "light" | "dark"
  readonly onSelect: (event: NativeSyntheticEvent<{ id: string }>) => void
}

/** The UIKit bar; Android draws its own in JS. */
export const NativeNavBar: ComponentType<NativeNavBarProps> | null =
  Platform.OS === "ios" ? requireNativeView("KilnNative", "NavBar") : null
