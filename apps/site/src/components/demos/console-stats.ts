export const historyLines = 100_000

export interface ConsoleStats {
  lines: number
  loadedIn: number | null
  matches: number
  searchedIn: number | null
}

// The demo's numbers live outside React state so updating them repaints only
// the line under the window, never Hearth's viewport.
export function createStatsStore() {
  let stats: ConsoleStats = {
    lines: 0,
    loadedIn: null,
    matches: 0,
    searchedIn: null,
  }
  const listeners = new Set<() => void>()
  return {
    get: () => stats,
    set(next: Partial<ConsoleStats>) {
      stats = { ...stats, ...next }
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export type StatsStore = ReturnType<typeof createStatsStore>
