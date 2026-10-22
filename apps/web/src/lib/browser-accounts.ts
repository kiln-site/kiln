import { Result } from "effect"

// Accounts signed in on this browser share one active session cookie, so every
// Kiln tab follows the account picked last. Tabs record the account they
// render here; a tab that sees another account become active reloads as it.
export const maximumBrowserAccounts = 5

export const activeAccountStorageKey = "kiln:active-account"

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
  // Storage can be unavailable; tabs then catch up when they regain focus.
  Result.try(() =>
    window.localStorage.setItem(activeAccountStorageKey, userId ?? "")
  )
}

export function readActiveAccount(): string | null {
  return Result.getOrElse(
    Result.try(() => window.localStorage.getItem(activeAccountStorageKey)),
    () => null
  )
}
