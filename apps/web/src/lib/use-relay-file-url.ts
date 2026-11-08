import * as React from "react"

import { forkPromise } from "@/effect/promise"
import { readRelayFile } from "@/lib/relay-file-transfer"

export type RelayFileUrl =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "failed"; readonly message: string }

/**
 * A file's bytes, read straight from the Relay into the page as an object
 * URL of `type`, for the page to show. Reading again when `revision`
 * changes; the URL is released once it's no longer shown.
 */
export function useRelayFileUrl(input: {
  readonly instanceId: string
  readonly maxBytes: number
  readonly path: string | null
  readonly relayId: string
  readonly revision?: number | string
  readonly type: string
}): RelayFileUrl {
  const { instanceId, maxBytes, path, relayId, revision, type } = input
  const [state, setState] = React.useState<RelayFileUrl>({ status: "loading" })
  React.useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    let url: string | null = null
    setState({ status: "loading" })
    forkPromise(
      async () => {
        const blob = await readRelayFile({
          instanceId,
          maxBytes,
          path,
          relayId,
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        url = URL.createObjectURL(new Blob([blob], { type }))
        setState({ status: "ready", url })
      },
      (cause) => {
        if (controller.signal.aborted) return
        setState({
          status: "failed",
          message:
            cause instanceof Error && cause.message
              ? cause.message
              : "Could not read the file",
        })
      }
    )
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [instanceId, maxBytes, path, relayId, revision, type])
  return state
}
