import { Effect } from "effect"

export async function copyTextToClipboard(value: string): Promise<boolean> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: () => navigator.clipboard.writeText(value),
      catch: (cause) => cause,
    }).pipe(
      Effect.as(true),
      Effect.catch(() => copyTextWithSelection(value))
    )
  )
}

function copyTextWithSelection(value: string): Effect.Effect<boolean> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const textarea = document.createElement("textarea")
      const activeElement = document.activeElement
      textarea.value = value
      textarea.readOnly = true
      textarea.style.position = "fixed"
      textarea.style.inset = "0"
      textarea.style.opacity = "0"
      document.body.append(textarea)
      textarea.focus()
      textarea.select()
      return { activeElement, textarea }
    }),
    () =>
      Effect.try({
        try: () => document.execCommand("copy"),
        catch: () => false,
      }).pipe(
        Effect.match({
          onFailure: () => false,
          onSuccess: (copied) => copied,
        })
      ),
    ({ activeElement, textarea }) =>
      Effect.sync(() => {
        textarea.remove()
        if (activeElement instanceof HTMLElement) activeElement.focus()
      })
  )
}
