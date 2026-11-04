import { Result } from "effect"
import { withRenderedAccount } from "@/lib/browser-accounts"
import { holdStreamAcrossSessionRotation } from "@/lib/session-rotation"
import { memo, useEffect } from "react"

export const AccountStatusSync = memo(function AccountStatusSync({
  restricted = false,
  resumePath = "/",
}: {
  restricted?: boolean
  resumePath?: string
}) {
  useEffect(() => {
    let source: EventSource | null = null
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
    return holdStreamAcrossSessionRotation({
      open() {
        source = new EventSource(withRenderedAccount("/api/account-status"))
        source.addEventListener("message", onMessage)
      },
      close() {
        source?.close()
        source = null
      },
    })
  }, [restricted, resumePath])
  return null
})
