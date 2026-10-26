export function createHearthUpdateReload() {
  let deadline: number | null = null
  let seconds: number | null = null
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => seconds,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start: () => {
      const reloadAt = (deadline ??= Date.now() + 5_000)
      const tick = () => {
        const remaining = Math.max(
          0,
          Math.ceil((reloadAt - Date.now()) / 1_000)
        )
        if (remaining === seconds) return
        seconds = remaining
        for (const listener of listeners) listener()
      }
      tick()
      const timer = window.setInterval(tick, 1_000)
      return () => window.clearInterval(timer)
    },
  }
}

export type HearthUpdateReloadStore = ReturnType<
  typeof createHearthUpdateReload
>
