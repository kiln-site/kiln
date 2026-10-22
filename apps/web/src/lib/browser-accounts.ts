import { Result } from "effect"

// Accounts signed in on this browser share one active session cookie, so every
// Kiln tab follows the account picked last. Tabs record the account they
// render here; a tab that sees another account become active reloads as it.
export const maximumBrowserAccounts = 5

const activeAccountStorageKey = "kiln:active-account"

export interface BrowserAccount {
  active: boolean
  email: string
  name: string
  sessionId: string
  userId: string
}

export const browserAccountsQueryKey = ["auth", "browser-accounts"] as const

/** Records the account this browser now uses, waking other Kiln tabs. */
export function announceActiveAccount(userId: string | null) {
  // Storage can be unavailable in private modes; tabs then catch up through
  // the account-status stream instead.
  Result.try(() =>
    window.localStorage.setItem(activeAccountStorageKey, userId ?? "")
  )
}

function readActiveAccount(): string | null {
  return Result.getOrElse(
    Result.try(() => window.localStorage.getItem(activeAccountStorageKey)),
    () => null
  )
}

/**
 * Keeps a tab rendering `userId` from acting for a different account after
 * another tab switches, signs in, or signs out.
 */
export function followActiveAccount(userId: string): () => void {
  announceActiveAccount(userId)
  const reloadIfChanged = (active: string | null) => {
    if (active !== null && active !== userId) window.location.reload()
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === activeAccountStorageKey) reloadIfChanged(event.newValue)
  }
  // Frozen and back-forward cached tabs miss storage events.
  const onResume = () => {
    if (document.visibilityState === "visible")
      reloadIfChanged(readActiveAccount())
  }
  window.addEventListener("storage", onStorage)
  window.addEventListener("pageshow", onResume)
  document.addEventListener("visibilitychange", onResume)
  return () => {
    window.removeEventListener("storage", onStorage)
    window.removeEventListener("pageshow", onResume)
    document.removeEventListener("visibilitychange", onResume)
  }
}
