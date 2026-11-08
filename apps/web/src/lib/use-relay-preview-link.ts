import * as React from "react"

import { forkPromise } from "@/effect/promise"
import { relayFilePreviewLink } from "@/lib/relay-file-transfer"

export type RelayPreviewLink =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "failed"; readonly message: string }

/**
 * A preview link for a file, for the browser's own player to follow. The
 * link stays the same while the file plays, since a new one restarts the
 * player; `renew` asks for a fresh one, as when the old one has expired.
 */
export function useRelayPreviewLink(input: {
  readonly instanceId: string
  readonly path: string
  readonly relayId: string
  readonly revision: number
}) {
  const { instanceId, path, relayId, revision } = input
  const [link, setLink] = React.useState<RelayPreviewLink>({
    status: "loading",
  })
  const [request, setRequest] = React.useState(0)
  React.useEffect(() => {
    const controller = new AbortController()
    forkPromise(
      async () => {
        const issued = await relayFilePreviewLink({
          instanceId,
          path,
          relayId,
          signal: controller.signal,
        })
        if (!controller.signal.aborted) {
          setLink({ status: "ready", url: issued.url })
        }
      },
      (cause) => {
        if (controller.signal.aborted) return
        setLink({
          status: "failed",
          message:
            cause instanceof Error && cause.message
              ? cause.message
              : "Could not open the file",
        })
      }
    )
    return () => controller.abort()
  }, [instanceId, path, relayId, revision, request])
  const renew = React.useCallback(() => setRequest((count) => count + 1), [])
  return { link, renew }
}
