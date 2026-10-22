import * as React from "react"
import { useRouter } from "@tanstack/react-router"
import { ChevronRight, LoaderCircle, LogOut, UserRoundPlus } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"

import { UserAvatar } from "@/components/account-avatar"
import {
  addAccountHref,
  signOutAllAccounts,
  switchToAccount,
} from "@/components/account-switcher"
import { AuthBrand, AuthPageShell } from "@/components/auth-page-shell"
import { useFollowActiveAccount } from "@/components/use-follow-active-account"
import { recoverPromise } from "@/effect/promise"
import { clearAppearanceCache } from "@/lib/appearance"
import {
  announceActiveAccount,
  maximumBrowserAccounts,
  type BrowserAccount,
} from "@/lib/browser-accounts"
import { signOutBrowserAccountSession } from "@/server/browser-accounts"

export function BrowserAccountsPage({
  accounts,
}: {
  accounts: ReadonlyArray<BrowserAccount>
}) {
  const router = useRouter()
  const [pending, setPending] = React.useState<string | null>(null)
  const activeUserId =
    accounts.find((account) => account.active)?.userId ?? null
  useFollowActiveAccount(activeUserId)

  async function signOutAccount(account: BrowserAccount) {
    setPending(`sign-out:${account.sessionId}`)
    const signedOut = await recoverPromise(
      async () => {
        await signOutBrowserAccountSession({
          data: { sessionId: account.sessionId },
        })
        return true
      },
      (cause) => {
        showToast({
          type: "error",
          message:
            cause instanceof Error ? cause.message : "Could not sign out",
        })
        return false
      }
    )
    if (!signedOut) {
      setPending(null)
      return
    }
    if (account.active) {
      // Another signed-in account, if any, is active now.
      announceActiveAccount(null)
      clearAppearanceCache()
      window.location.reload()
      return
    }
    setPending(null)
    showToast({ type: "success", message: `Signed out ${account.email}.` })
    await router.invalidate()
  }

  return (
    <AuthPageShell>
      <header className="mb-8 grid justify-items-center gap-3 text-center">
        <AuthBrand />
        <h1 className="mt-2 font-heading text-2xl font-semibold tracking-[-0.04em]">
          Accounts on this browser
        </h1>
        <p className="text-sm text-muted-foreground">
          Choose an account to use in every Kiln tab on this browser.
        </p>
      </header>

      <ul className="divide-y overflow-hidden border bg-card/60">
        {accounts.map((account) => (
          <li key={account.sessionId} className="flex items-center gap-1 pr-2">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60"
              disabled={pending !== null}
              aria-label={
                account.active
                  ? `Continue as ${account.name}`
                  : `Switch to ${account.name} (${account.email})`
              }
              onClick={() => {
                setPending(`switch:${account.sessionId}`)
                void switchToAccount(account).then((switched) => {
                  if (!switched) {
                    setPending(null)
                    void router.invalidate()
                  }
                })
              }}
            >
              <UserAvatar
                name={account.name}
                profileId={account.minecraftProfileId ?? undefined}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {account.name}
                  </span>
                  {account.active ? (
                    <span className="type-technical-label shrink-0 border border-primary/25 bg-primary/8 px-1.5 py-0.5 text-primary-ink">
                      Active
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {account.email}
                </span>
              </span>
              {pending === `switch:${account.sessionId}` ? (
                <LoaderCircle className="size-4 shrink-0 animate-spin" />
              ) : (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              )}
            </button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 text-muted-foreground"
              disabled={pending !== null}
              aria-label={`Sign out ${account.email}`}
              onClick={() => void signOutAccount(account)}
            >
              {pending === `sign-out:${account.sessionId}` ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <LogOut />
              )}
              Sign out
            </Button>
          </li>
        ))}
      </ul>

      <div className="mt-4 grid gap-2">
        {accounts.length < maximumBrowserAccounts ? (
          <Button asChild variant="outline" className="h-11 bg-card/40">
            <a href={addAccountHref}>
              <UserRoundPlus /> Add another account
            </a>
          </Button>
        ) : (
          <p className="text-center text-xs text-muted-foreground">
            Up to {maximumBrowserAccounts} accounts can be signed in on this
            browser. Sign one out to add another.
          </p>
        )}
        <Button
          type="button"
          variant="ghost"
          className="h-10 text-muted-foreground hover:text-foreground"
          disabled={pending !== null}
          onClick={() => {
            setPending("sign-out-all")
            void recoverPromise(signOutAllAccounts, () => {
              setPending(null)
              showToast({ type: "error", message: "Could not sign out" })
            })
          }}
        >
          {pending === "sign-out-all" ? (
            <LoaderCircle className="animate-spin" />
          ) : null}
          {accounts.length > 1 ? "Sign out of all accounts" : "Sign out"}
        </Button>
      </div>
    </AuthPageShell>
  )
}
