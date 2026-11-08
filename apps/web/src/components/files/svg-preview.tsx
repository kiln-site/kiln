import * as React from "react"

import { FilePageContent } from "@/components/files/file-page-content"
import type { FileTextViewProps } from "@/components/files/file-text-view"

/**
 * An SVG drawn from the editor's text, unsaved changes included. It's shown
 * as an image, never put in the page, so its scripts don't run and it
 * fetches nothing.
 */
export function SvgPreview({
  displayPath,
  path,
  sessionStore,
}: FileTextViewProps) {
  const value = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getValueSnapshot,
    sessionStore.getValueSnapshot
  )
  const source = React.useDeferredValue(value)
  const [url, setUrl] = React.useState<string | null>(null)
  const [broken, setBroken] = React.useState(false)
  React.useEffect(() => {
    const next = URL.createObjectURL(
      new Blob([source], { type: "image/svg+xml" })
    )
    setUrl(next)
    setBroken(false)
    return () => URL.revokeObjectURL(next)
  }, [source])
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden [background:repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)_0_0/16px_16px]">
      {url && !broken ? (
        <img
          alt={path.split("/").at(-1) ?? path}
          className="absolute inset-0 size-full object-contain p-6"
          draggable={false}
          src={url}
          onError={() => setBroken(true)}
        />
      ) : null}
      {broken ? (
        <div className="absolute inset-0 grid place-items-center bg-card/80 px-6 text-center">
          <div className="max-w-xs">
            <p className="text-sm font-semibold">Can't draw this SVG</p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Its markup isn't a valid SVG yet. Switch to Source to fix it.
            </p>
          </div>
        </div>
      ) : null}
      <FilePageContent path={displayPath} view="svg" />
    </div>
  )
}
