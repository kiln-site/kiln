import { Result } from "effect"
import { memo, useEffect } from "react"

export const AccountStatusSync = memo(function AccountStatusSync({
  restricted = false,
  resumePath = "/",
}: {
  restricted?: boolean
  resumePath?: string
}) {
  useEffect(() => {
    const source = new EventSource("/api/account-status")
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
