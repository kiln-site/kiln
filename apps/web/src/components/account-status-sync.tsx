import { Result } from "effect"
import { withRenderedAccount } from "@/lib/browser-accounts"
import { memo, useEffect } from "react"

import { useFollowActiveAccount } from "@/components/use-follow-active-account"

export const AccountStatusSync = memo(function AccountStatusSync({
  restricted = false,
  resumePath = "/",
  userId,
}: {
  restricted?: boolean
  resumePath?: string
  userId: string
}) {
  // Every tab in this browser shares the active account; follow it when
  // another tab switches, adds, or signs out an account.
  useFollowActiveAccount(userId)
  useEffect(() => {
    const source = new EventSource(withRenderedAccount("/api/account-status"))
    let previousVerification: boolean | null = null
    const onMessage = (event: MessageEvent<string>) => {
      Result.try(() => {
        const status = JSON.parse(event.data) as {
          authenticated: boolean
          enabled: boolean
          verified: boolean
        }
        if (!status.authenticated) window.location.replace("/")
        else if (restricted && status.enabled && status.verified)
          window.location.replace(resumePath)
        else if (!restricted && (!status.enabled || !status.verified))
          window.location.replace(
            `/account-status?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`
          )
        else if (
          restricted &&
          previousVerification !== null &&
          previousVerification !== status.verified
        )
          window.location.reload()
        previousVerification = status.verified
      }).pipe(
        Result.match({ onSuccess: () => undefined, onFailure: () => undefined })
      )
    }
    source.addEventListener("message", onMessage)
    return () => source.close()
  }, [restricted, resumePath])
  return null
})
