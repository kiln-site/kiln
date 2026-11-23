import { requireNativeView } from "expo"
import type { ComponentType } from "react"
import {
  Platform,
  type NativeSyntheticEvent,
  type ViewProps,
} from "react-native"

/** A tab: it goes to a page or opens its drawer, as the app decides. */
export interface NavSection {
  readonly id: string
  readonly title: string
  readonly systemImage: string
}

/** The circle beside the tabs, for the pages of what's on screen. */
export interface NavContext {
  readonly title: string
  readonly systemImage: string
}

export type NativeNavBarProps = ViewProps & {
  readonly sections: readonly NavSection[]
  readonly selectedSection: string | null
  readonly context: NavContext | null
  readonly tint: string
  readonly appearance: "light" | "dark"
  /** A tab's ID, or "context" for the circle. */
  readonly onSelect: (event: NativeSyntheticEvent<{ id: string }>) => void
}

/** The UIKit bar; Android draws its own in JS. */
export const NativeNavBar: ComponentType<NativeNavBarProps> | null =
  Platform.OS === "ios" ? requireNativeView("KilnNative", "NavBar") : null
