import * as React from "react"

export const mobileBreakpoint = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(false)

  React.useEffect(() => {
    const mediaQuery = window.matchMedia(
      `(max-width: ${mobileBreakpoint - 1}px)`
    )
    const update = () => setIsMobile(window.innerWidth < mobileBreakpoint)

    mediaQuery.addEventListener("change", update)
    update()
    return () => mediaQuery.removeEventListener("change", update)
  }, [])

  return isMobile
}
