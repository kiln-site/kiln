import * as React from "react"

import { forkPromise } from "@/effect/promise"

/** Reveal an on-demand module without a Suspense reveal delay. */
export function usePreloadedModule<TModule>(
  load: () => Promise<TModule>,
  loaded: () => TModule | undefined
): TModule | undefined {
  const [module, setModule] = React.useState(loaded)
  const [failure, setFailure] = React.useState<{ cause: unknown } | null>(null)
  React.useEffect(() => {
    if (module) return
    let active = true
    forkPromise(
      async () => {
        const value = await load()
        if (active) setModule(() => value)
      },
      (cause) => {
        if (active) setFailure({ cause })
      }
    )
    return () => {
      active = false
    }
  }, [load, module])
  if (failure) throw failure.cause
  return module
}
