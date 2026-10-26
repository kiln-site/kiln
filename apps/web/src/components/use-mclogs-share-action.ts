import * as React from "react"
import { Effect } from "effect"

export type MclogsShareState = "idle" | "uploading" | "copied" | "error"

// The action uploads and copies the link; the next click opens that same URL.
export function useMclogsShareAction(action: () => Promise<string>) {
  const [state, setState] = React.useState<MclogsShareState>("idle")
  const [canOpen, setCanOpen] = React.useState(false)
  const sharedUrl = React.useRef<string | null>(null)
  const uploading = React.useRef(false)
  const mouseLeft = React.useRef(false)
  const mounted = React.useRef(true)
  const resetTimer = React.useRef<number | null>(null)

  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
    }
  }, [])

  function reset() {
    if (uploading.current) return
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    sharedUrl.current = null
    setCanOpen(false)
    setState("idle")
  }

  function onPointerLeave(event: React.PointerEvent<HTMLElement>) {
    if (event.pointerType !== "mouse") return
    mouseLeft.current = true
    if (sharedUrl.current) reset()
  }

  async function share() {
    if (!mounted.current || uploading.current) return
    if (sharedUrl.current) {
      window.open(sharedUrl.current, "_blank", "noopener,noreferrer")
      reset()
      return
    }
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    mouseLeft.current = false
    uploading.current = true
    setState("uploading")
    await Effect.runPromise(
      Effect.tryPromise({
        try: action,
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: () => {
            if (mounted.current) setState("error")
          },
          onSuccess: (url) => {
            if (!mounted.current) return
            const protocol = URL.canParse(url) ? new URL(url).protocol : null
            if (protocol !== "https:" && protocol !== "http:") {
              setState("error")
              return
            }
            if (!mouseLeft.current) {
              sharedUrl.current = url
              setCanOpen(true)
            }
            setState("copied")
          },
        })
      )
    )
    uploading.current = false
    if (mounted.current) resetTimer.current = window.setTimeout(reset, 4_000)
  }

  return { share, state, canOpen, onPointerLeave }
}

export function mclogsShareTooltip(
  state: MclogsShareState,
  canOpen: boolean
): string {
  if (state === "uploading") return "Uploading to mclo.gs"
  if (state === "copied") return canOpen ? "Click again to open" : "Link copied"
  if (state === "error") return "Retry mclo.gs Upload"
  return "Upload to mclo.gs"
}

export function mclogsShareLabel(state: MclogsShareState): string {
  if (state === "uploading") return "Uploading"
  if (state === "copied") return "Link copied"
  if (state === "error") return "Try again"
  return "mclo.gs"
}
