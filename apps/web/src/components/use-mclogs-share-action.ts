import * as React from "react"
import { Effect } from "effect"

export type MclogsShareState = "idle" | "uploading" | "copied" | "error"

export function useMclogsShareAction(action: () => Promise<void>) {
  const [state, setState] = React.useState<MclogsShareState>("idle")
  const resetTimer = React.useRef<number | null>(null)

  React.useEffect(
    () => () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
    },
    []
  )

  async function share() {
    setState("uploading")
    await Effect.runPromise(
      Effect.tryPromise({
        try: action,
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: () => setState("error"),
          onSuccess: () => setState("copied"),
        })
      )
    )
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setState("idle"), 2800)
  }

  return { share, state }
}

export function mclogsShareTooltip(state: MclogsShareState): string {
  if (state === "uploading") return "Uploading to mclo.gs"
  if (state === "copied") return "Link Copied"
  if (state === "error") return "Retry mclo.gs Upload"
  return "Upload to mclo.gs"
}

export function mclogsShareLabel(state: MclogsShareState): string {
  if (state === "uploading") return "Uploading"
  if (state === "copied") return "Link copied"
  if (state === "error") return "Try again"
  return "mclo.gs"
}
