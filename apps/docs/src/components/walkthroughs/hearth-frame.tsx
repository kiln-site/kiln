import * as React from "react"
import { createPortal } from "react-dom"

// Draws Hearth's own components at a desktop's size, whatever the reader's
// screen. They lay out by the viewport's width, so they render in an iframe
// as wide as Hearth on a laptop, and the walkthrough scales it down. The
// iframe takes the page's stylesheets, so Hearth looks as it does in Hearth.
export function HearthFrame({
  children,
  height,
  width,
}: {
  children: React.ReactNode
  height: number
  width: number
}) {
  const [body, setBody] = React.useState<HTMLElement | null>(null)
  const ref = React.useCallback((frame: HTMLIFrameElement | null) => {
    const document = frame?.contentDocument
    if (!frame || !document) return
    document.open()
    document.write(
      '<!doctype html><html class="dark"><head></head><body></body></html>'
    )
    document.close()
    for (const sheet of window.document.querySelectorAll(
      'link[rel="stylesheet"], style'
    )) {
      document.head.append(sheet.cloneNode(true))
    }
    // Hearth's document: full height, nothing scrolls.
    document.documentElement.style.height = "100%"
    document.body.className = "h-full overflow-hidden antialiased"
    document.body.style.margin = "0"
    setBody(document.body)
  }, [])

  return (
    <>
      <iframe
        ref={ref}
        title="Hearth"
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none block border-0"
        style={{ width, height }}
      />
      {body ? createPortal(children, body) : null}
    </>
  )
}
