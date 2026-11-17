import { Effect, Schema } from "effect"
import * as SecureStore from "expo-secure-store"
import { useSyncExternalStore } from "react"

import type { ContentRoute } from "../menus"

// The device's only key-value store in this app is the Keychain; the list is
// small, and leaves with the session.
const RECENT_KEY = "kiln.recent.v1"
const LIMIT = 6

const RecentPage = Schema.Struct({
  key: Schema.String,
  name: Schema.Literals(["Section", "Server", "Relay"]),
  params: Schema.Unknown,
  at: Schema.Number,
})
export type RecentPage = typeof RecentPage.Type

const decodeRecent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(RecentPage))
)

let pages: readonly RecentPage[] = []
const listeners = new Set<() => void>()

function publish(next: readonly RecentPage[], persist: boolean) {
  pages = next
  for (const listener of listeners) listener()
  if (persist)
    void Effect.runPromise(
      Effect.tryPromise(() =>
        SecureStore.setItemAsync(RECENT_KEY, JSON.stringify(next))
      ).pipe(Effect.ignore)
    )
}

void Effect.runPromise(
  Effect.tryPromise(() => SecureStore.getItemAsync(RECENT_KEY)).pipe(
    Effect.flatMap((raw) => (raw ? decodeRecent(raw) : Effect.succeed([]))),
    Effect.match({
      onFailure: () => undefined,
      // A visit recorded before the stored list loaded comes first.
      onSuccess: (stored) =>
        publish(
          [
            ...pages,
            ...stored.filter((page) => !pages.some((p) => p.key === page.key)),
          ].slice(0, LIMIT),
          false
        ),
    })
  )
)

/** One entry per place: a game server's pages share one, so do a section's. */
function keyOf(route: ContentRoute): string | null {
  if (route.name === "Server") return `server:${route.params.instanceId}`
  if (route.name === "Relay") return `relay:${route.params.relayId}`
  if (route.params.area === "home") return null
  return `section:${route.params.area}:${route.params.page}`
}

/** Remembers a page someone opened, newest first. Home isn't one. */
export function recordVisit(route: ContentRoute) {
  const key = keyOf(route)
  if (!key) return
  if (pages[0]?.key === key && pages[0].params === route.params) return
  const visit: RecentPage = {
    key,
    name: route.name,
    params: route.params,
    at: Date.now(),
  }
  publish(
    [visit, ...pages.filter((page) => page.key !== key)].slice(0, LIMIT),
    true
  )
}

export function clearRecentPages() {
  publish([], false)
  void Effect.runPromise(
    Effect.tryPromise(() => SecureStore.deleteItemAsync(RECENT_KEY)).pipe(
      Effect.ignore
    )
  )
}

export function useRecentPages(): readonly RecentPage[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => pages
  )
}
