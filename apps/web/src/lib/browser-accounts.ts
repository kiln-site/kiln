import { Result } from "effect"

// Accounts signed in on this browser share one active session cookie, so every
// Kiln tab follows the account picked last. Tabs record the account they
// render here; a tab that sees another account become active reloads as it.
export const maximumBrowserAccounts = 5

export const activeAccountStorageKey = "kiln:active-account"

export interface BrowserAccount {
  active: boolean
  email: string
  /** The account's own Minecraft head, if its name is a Minecraft username. */
  minecraftProfileId: string | null
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

// Each tab tells Hearth which account it renders. A request whose shared
// cookie now belongs to another account is refused, so a tab that has not yet
// followed a switch cannot read or change anything as the new account.
export const renderedAccountHeader = "x-kiln-account"
const renderedAccountParam = "kilnAccount"
export const accountChangedMessage = "kiln:account-changed"

let renderedAccount: string | null = null

export function setRenderedAccount(userId: string | null) {
  // Server rendering shares this module across requests.
  if (typeof window === "undefined") return
  renderedAccount = userId
}

export function getRenderedAccount(): string | null {
  return renderedAccount
}

/** Adds the rendered account to a stream URL, which cannot carry headers. */
export function withRenderedAccount(url: string): string {
  if (renderedAccount === null) return url
  const separator = url.includes("?") ? "&" : "?"
  return `${url}${separator}${renderedAccountParam}=${encodeURIComponent(renderedAccount)}`
}

/** Whether a request claims to come from a tab rendering another account. */
export function rendersOtherAccount(
  request: Request,
  userId: string | null
): boolean {
  const claimed =
    request.headers.get(renderedAccountHeader) ??
    new URL(request.url).searchParams.get(renderedAccountParam)
  return claimed !== null && claimed !== (userId ?? "")
}

export function isAccountChangedError(cause: unknown): boolean {
  return cause instanceof Error && cause.message === accountChangedMessage
}
