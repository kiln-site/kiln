import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { Check, LoaderCircle, UserRoundPlus, Users } from "lucide-react"

import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import { AccountAvatar, UserAvatar } from "@/components/account-avatar"
import { recoverPromise } from "@/effect/promise"
import { clearAppearanceCache } from "@/lib/appearance"
import { authClient } from "@/lib/auth-client"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  announceActiveAccount,
  browserAccountsQueryKey,
  maximumBrowserAccounts,
  type BrowserAccount,
} from "@/lib/browser-accounts"
import {
  getBrowserAccounts,
  switchBrowserAccountSession,
} from "@/server/browser-accounts"

export const addAccountHref = "/?addAccount=true"

const browserAccountsQueryOptions = {
  queryKey: browserAccountsQueryKey,
  queryFn: () => getBrowserAccounts(),
  staleTime: 30_000,
}

export function prefetchBrowserAccounts(queryClient: QueryClient) {
  void queryClient.prefetchQuery(browserAccountsQueryOptions)
}

export function useBrowserAccounts(enabled = true) {
  return useQuery({ ...browserAccountsQueryOptions, enabled })
}

/** Makes `account` active for every Kiln tab and opens it here. */
export async function switchToAccount(account: BrowserAccount) {
  // Even the account shown as active is activated again: another tab may
  // have switched since this list loaded.
  const result = await recoverPromise(
    async () => {
      await switchBrowserAccountSession({
        data: { sessionId: account.sessionId },
      })
      return true
    },
    (cause) => {
      showToast({
        type: "error",
        message:
          cause instanceof Error ? cause.message : "Could not switch accounts",
      })
      return false
    }
  )
  if (!result) return false
  announceActiveAccount(account.userId)
  clearAppearanceCache()
  window.location.assign("/")
  return true
}

/** Signs every account out of this browser. */
export async function signOutAllAccounts() {
  await authClient.signOut()
  announceActiveAccount(null)
  clearAppearanceCache()
  window.location.assign("/")
}

const menuRowClassName =
  "flex w-full items-center gap-2.5 px-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45"

/**
 * The account menu's identity section: the active account, the others signed
 * in on this browser, and a way to add another.
 */
export const AccountSwitcherSection = React.memo(
  function AccountSwitcherSection({
    onNavigate,
    user,
  }: {
    onNavigate: () => void
    user: AuthenticatedUser
  }) {
    const accounts = useBrowserAccounts(!user.isDevelopmentBypass)
    const [switchingTo, setSwitchingTo] = React.useState<string | null>(null)
    const others = accounts.data?.filter((account) => !account.active) ?? []
    const atLimit = (accounts.data?.length ?? 0) >= maximumBrowserAccounts

    return (
      <div className="grid gap-0.5">
        <div className="flex items-center gap-2.5 px-2 py-2">
          <AccountAvatar name={user.name} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {user.email}
            </p>
          </div>
          <Check className="size-4 shrink-0 text-primary-ink" aria-hidden />
        </div>
        {user.isDevelopmentBypass ? null : (
          <>
            {accounts.isPending ? (
              <div className="flex h-11 items-center gap-2.5 px-2 text-xs text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                Loading accounts
              </div>
            ) : null}
            {others.map((account) => (
              <button
                key={account.sessionId}
                type="button"
                className={cn(menuRowClassName, "h-11")}
                aria-label={`Switch to ${account.name} (${account.email})`}
                disabled={switchingTo !== null}
                onClick={() => {
                  setSwitchingTo(account.sessionId)
                  void switchToAccount(account).then((switched) => {
                    if (!switched) {
                      setSwitchingTo(null)
                      void accounts.refetch()
                    }
                  })
                }}
              >
                <UserAvatar
                  name={account.name}
                  profileId={account.minecraftProfileId ?? undefined}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{account.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {account.email}
                  </span>
                </span>
                {switchingTo === account.sessionId ? (
                  <LoaderCircle className="size-4 shrink-0 animate-spin" />
                ) : null}
              </button>
            ))}
            {atLimit ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                Up to {maximumBrowserAccounts} accounts can be signed in on this
                browser.
              </p>
            ) : (
              <a
                href={addAccountHref}
                className={cn(menuRowClassName, "h-9")}
                onClick={onNavigate}
              >
                <UserRoundPlus className="size-4" />
                <span>Add another account</span>
              </a>
            )}
            <a
              href="/accounts"
              className={cn(menuRowClassName, "h-9")}
              onClick={onNavigate}
            >
              <Users className="size-4" />
              <span>Manage accounts</span>
            </a>
          </>
        )}
      </div>
    )
  }
)

/** Prefetches the account list when the pointer or focus nears a trigger. */
export function useBrowserAccountsPrefetch(enabled: boolean) {
  const queryClient = useQueryClient()
  return React.useMemo(
    () =>
      enabled
        ? {
            onFocus: () => prefetchBrowserAccounts(queryClient),
            onPointerEnter: () => prefetchBrowserAccounts(queryClient),
          }
        : {},
    [enabled, queryClient]
  )
}
