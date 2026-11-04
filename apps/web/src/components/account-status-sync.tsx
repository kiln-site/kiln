import { Result } from "effect"
import { recoverPromise } from "@/effect/promise"
import { withRenderedAccount } from "@/lib/browser-accounts"
import { holdStreamAcrossSessionRotation } from "@/lib/session-rotation"
import { getAuthState } from "@/server/auth"
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
    // Refused outright, the stream never reports the session it found dead.
    // Restricted pages have no other stream to notice.
    const onError = () => {
      const refused = source
      if (refused?.readyState !== EventSource.CLOSED) return
      void recoverPromise(
        async () => {
          const { user } = await getAuthState()
          if (!user && source === refused) window.location.replace("/")
        },
        () => undefined
      )
    }
    return holdStreamAcrossSessionRotation({
      open() {
        source = new EventSource(withRenderedAccount("/api/account-status"))
        source.addEventListener("message", onMessage)
        source.addEventListener("error", onError)
      },
      close() {
        source?.close()
        source = null
      },
    })
  }, [restricted, resumePath])
  return null
})
