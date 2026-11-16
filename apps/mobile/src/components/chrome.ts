import { useEffect, useState } from "react"
import { Keyboard, Platform } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

export const BAR_HEIGHT = 62

/** Where the floating bar sits: just above the home indicator. */
export function useBarFrame() {
  const insets = useSafeAreaInsets()
  const bottom = insets.bottom > 0 ? Math.max(insets.bottom - 12, 12) : 16
  return { bottom, height: BAR_HEIGHT }
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
    const shown = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", () =>
      setOpen(true)
    )
    const hidden = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () =>
      setOpen(false)
    )
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [])
  return open
}
