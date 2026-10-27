import { Effect } from "effect"
import { Check, Copy } from "lucide-react"
import * as React from "react"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"

// Copies text and says so. The icon turns into a check for a moment too, so
// the button answers where it was pressed.
export function CopyButton({
  label,
  text,
  toast,
  variant = "outline",
}: {
  label: string
  text: string
  toast: string
  variant?: "outline" | "ghost"
}) {
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 1_500)
    return () => window.clearTimeout(timeout)
  }, [copied])

  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      onClick={() => copyText(text, toast, () => setCopied(true))}
    >
      {copied ? <Check /> : <Copy />}
      {label}
    </Button>
  )
}

// Copies text to the clipboard and says so either way.
export function copyText(
  text: string,
  toast: string,
  onCopied?: () => void
): void {
  void Effect.runPromise(
    Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
      Effect.match({
        onFailure: () => showToast({ message: "Couldn't copy", type: "error" }),
        onSuccess: () => {
          onCopied?.()
          showToast({ message: toast, type: "success" })
        },
      })
    )
  )
}

// Saves text as a file in the browser, without a server.
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" })
  )
  const link = document.createElement("a")
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}
