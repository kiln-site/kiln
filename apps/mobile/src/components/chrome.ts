import { useEffect, useState } from "react"
import { Keyboard, Platform } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

export const BAR_HEIGHT = 62

/**
 * Where the floating bar sits: just above the home indicator. On iOS the
 * tab bar places itself inside a taller host that reaches the screen's edge.
 */
export function useBarFrame() {
  const insets = useSafeAreaInsets()
  const bottom = insets.bottom > 0 ? Math.max(insets.bottom - 12, 12) : 16
  return { bottom, height: BAR_HEIGHT }
}

/**
 * Pull to refresh that shows its spinner only for a pull, not while queries
 * poll in the background.
 */
export function usePullToRefresh(refresh: () => Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false)
  const onRefresh = async () => {
    setRefreshing(true)
    await Promise.allSettled([refresh()])
    setRefreshing(false)
  }
  return { refreshing, onRefresh: () => void onRefresh() }
}

/** Bottom padding that keeps the end of a scroll view clear of the bar. */
export function useBarInset(): number {
  const frame = useBarFrame()
  return frame.bottom + frame.height + 20
}

export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const ios = Platform.OS === "ios"
    const shown = Keyboard.addListener(
      ios ? "keyboardWillShow" : "keyboardDidShow",
      () => setOpen(true)
    )
    const hidden = Keyboard.addListener(
      ios ? "keyboardWillHide" : "keyboardDidHide",
      () => setOpen(false)
    )
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [])
  return open
}
