import * as React from "react"
import { Result } from "effect"

import { PanelResizeHandle } from "@/components/panel-resize-handle"

export interface PanelSize {
  defaultSize: number
  label: string
  // Upper bound for the current layout, given the panel being resized.
  maxSize: (panel: HTMLElement) => number
  minSize: number
  storageKey: string
  variable: string
}

// Mirrors the file tree resize: sizes are written straight to a CSS
// variable during the drag so nothing re-renders, then saved on release.
// "vertical" resizes a panel's width from its right edge, "horizontal" its
// height from its bottom edge.
export function SizedPanelHandle({
  orientation = "vertical",
  panelRef,
  size,
}: {
  orientation?: "horizontal" | "vertical"
  panelRef: React.RefObject<HTMLElement | null>
  size: PanelSize
}) {
  const vertical = orientation === "vertical"
  const handleRef = React.useRef<HTMLDivElement>(null)
  const current = React.useRef(size.defaultSize)
  const session = React.useRef<{
    pointerId: number
    start: number
    startSize: number
  } | null>(null)
  const frame = React.useRef<number | null>(null)

  const apply = React.useCallback(
    (next: number) => {
      const panel = panelRef.current
      const maximum = panel
        ? Math.max(size.minSize, size.maxSize(panel))
        : Number.POSITIVE_INFINITY
      current.current = Math.round(
        Math.min(maximum, Math.max(size.minSize, next))
      )
      panel?.style.setProperty(size.variable, `${current.current}px`)
      handleRef.current?.setAttribute("aria-valuenow", String(current.current))
      return current.current
    },
    [panelRef, size]
  )
  const persist = (value: number) => {
    Result.try(() =>
      window.localStorage.setItem(size.storageKey, String(value))
    )
  }

  React.useLayoutEffect(() => {
    const stored = Result.try(() =>
      Number(window.localStorage.getItem(size.storageKey))
    )
    const saved = Result.isSuccess(stored) ? stored.success : 0
    apply(saved > 0 ? saved : size.defaultSize)
  }, [apply, size])

  function finish(pointerId?: number) {
    if (pointerId !== undefined && session.current?.pointerId !== pointerId) {
      return
    }
    if (frame.current !== null) {
      window.cancelAnimationFrame(frame.current)
      frame.current = null
    }
    session.current = null
    document.documentElement.style.removeProperty("user-select")
    handleRef.current?.removeAttribute("data-resizing")
    persist(current.current)
  }

  return (
    <PanelResizeHandle
      ref={handleRef}
      orientation={orientation}
      aria-label={size.label}
      aria-valuemin={size.minSize}
      aria-valuenow={size.defaultSize}
      className="flex"
      onPointerDown={(event) => {
        if (event.button !== 0 || !panelRef.current) return
        event.preventDefault()
        const rect = panelRef.current.getBoundingClientRect()
        session.current = {
          pointerId: event.pointerId,
          start: vertical ? event.clientX : event.clientY,
          startSize: vertical ? rect.width : rect.height,
        }
        document.documentElement.style.userSelect = "none"
        event.currentTarget.dataset.resizing = "true"
        Result.try(() => event.currentTarget.setPointerCapture(event.pointerId))
      }}
      onPointerMove={(event) => {
        const active = session.current
        if (!active || active.pointerId !== event.pointerId) return
        const next =
          active.startSize +
          (vertical ? event.clientX : event.clientY) -
          active.start
        if (frame.current !== null) window.cancelAnimationFrame(frame.current)
        frame.current = window.requestAnimationFrame(() => {
          frame.current = null
          apply(next)
        })
      }}
      onPointerUp={(event) => finish(event.pointerId)}
      onPointerCancel={(event) => finish(event.pointerId)}
      onLostPointerCapture={() => {
        if (session.current) finish()
      }}
      onDoubleClick={(event) => {
        event.preventDefault()
        persist(apply(size.defaultSize))
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 32 : 16
        const shrink = vertical ? "ArrowLeft" : "ArrowUp"
        const grow = vertical ? "ArrowRight" : "ArrowDown"
        const next =
          event.key === shrink
            ? current.current - step
            : event.key === grow
              ? current.current + step
              : event.key === "Home"
                ? size.minSize
                : event.key === "End"
                  ? Number.POSITIVE_INFINITY
                  : null
        if (next === null) return
        event.preventDefault()
        persist(apply(next))
      }}
    />
  )
}
