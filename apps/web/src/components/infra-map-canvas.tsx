import * as React from "react"
import { Maximize, Minus, Plus } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import type { OverviewRect } from "@/lib/overview-map-layout"

export function nodeStyle(rect: OverviewRect): React.CSSProperties {
  return {
    height: rect.height,
    left: rect.x,
    top: rect.y,
    width: rect.width,
  }
}

const minZoom = 0.1
const maxZoom = 2
const fitPadding = 40
const dotSpacing = 20
const exitMs = 200
const enterMs = 260

export interface MapViewportHandle {
  /**
   * Leaves the current map: toward a rect in map coordinates, as when
   * opening it, or back out when there's none. The next map fitted comes in
   * from the same direction. Calls `done` once the old map is gone.
   */
  leave(toward: OverviewRect | null, done: () => void): void
}

/**
 * A pannable, zoomable canvas. The view lives in a ref and is written to the
 * DOM directly, so dragging and zooming never re-render the map.
 */
export function MapViewport({
  children,
  controller,
  fitKey,
  height,
  overlay,
  width,
}: {
  children: React.ReactNode
  controller?: React.Ref<MapViewportHandle>
  /** Refits the view whenever this changes, as when the scope does. */
  fitKey: string
  height: number
  /** Drawn over the map beside the zoom controls. */
  overlay?: React.ReactNode
  width: number
}) {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const worldRef = React.useRef<HTMLDivElement>(null)
  const zoomLabelRef = React.useRef<HTMLSpanElement>(null)
  const view = React.useRef({ x: 0, y: 0, scale: 1 })
  const moved = React.useRef(false)
  const size = React.useRef({ width, height })
  size.current = { width, height }

  const apply = React.useCallback(() => {
    const viewport = viewportRef.current
    const world = worldRef.current
    if (!viewport || !world) return
    const { x, y, scale } = view.current
    world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
    world.style.visibility = "visible"
    const spacing = dotSpacing * scale
    viewport.style.backgroundSize = `${spacing}px ${spacing}px`
    viewport.style.backgroundPosition = `${x}px ${y}px`
    if (zoomLabelRef.current)
      zoomLabelRef.current.textContent = `${Math.round(scale * 100)}%`
  }, [])

  const fit = React.useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const { width: contentWidth, height: contentHeight } = size.current
    const bounds = viewport.getBoundingClientRect()
    const scale = clamp(
      Math.min(
        1,
        (bounds.width - fitPadding * 2) / Math.max(contentWidth, 1),
        (bounds.height - fitPadding * 2) / Math.max(contentHeight, 1)
      ),
      minZoom,
      maxZoom
    )
    view.current = {
      scale,
      x: (bounds.width - contentWidth * scale) / 2,
      y: Math.max(fitPadding, (bounds.height - contentHeight * scale) / 2),
    }
    apply()
  }, [apply])

  const zoomAt = React.useCallback(
    (factor: number, pointX?: number, pointY?: number) => {
      const viewport = viewportRef.current
      if (!viewport) return
      const bounds = viewport.getBoundingClientRect()
      const originX = pointX ?? bounds.width / 2
      const originY = pointY ?? bounds.height / 2
      const current = view.current
      const scale = clamp(current.scale * factor, minZoom, maxZoom)
      const ratio = scale / current.scale
      view.current = {
        scale,
        x: originX - (originX - current.x) * ratio,
        y: originY - (originY - current.y) * ratio,
      }
      moved.current = true
      apply()
    },
    [apply]
  )

  // Set once the old map has left: the next map fitted arrives from that
  // direction. Leaving, arriving, and their fallback each keep their own
  // timer, so a refit mid-way (as on a resize) can't cancel the navigation.
  const arriving = React.useRef<"in" | "out" | null>(null)
  const settle = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  const leaving = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  const unclaimed = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  React.useEffect(
    () => () => {
      clearTimeout(settle.current)
      clearTimeout(leaving.current)
      clearTimeout(unclaimed.current)
    },
    []
  )

  // Animates the next transform and opacity written to the map.
  const transition = React.useCallback((ms: number, easing: string) => {
    const world = worldRef.current
    if (!world) return
    world.style.transition = `transform ${ms}ms ${easing}, opacity ${ms}ms ${easing}`
    clearTimeout(settle.current)
    settle.current = setTimeout(() => {
      world.style.transition = ""
    }, ms)
  }, [])

  React.useImperativeHandle(
    controller,
    () => ({
      leave(toward, done) {
        const viewport = viewportRef.current
        const world = worldRef.current
        if (!viewport || !world || prefersReducedMotion()) return done()
        const bounds = viewport.getBoundingClientRect()
        const current = view.current
        // Opening grows the map around the card; going back shrinks it.
        const scale = current.scale * (toward ? 1.6 : 0.85)
        const centreX = toward
          ? toward.x + toward.width / 2
          : (bounds.width / 2 - current.x) / current.scale
        const centreY = toward
          ? toward.y + toward.height / 2
          : (bounds.height / 2 - current.y) / current.scale
        clearTimeout(leaving.current)
        clearTimeout(unclaimed.current)
        transition(exitMs, "cubic-bezier(0.4, 0, 1, 1)")
        world.style.transform = `translate(${bounds.width / 2 - centreX * scale}px, ${bounds.height / 2 - centreY * scale}px) scale(${scale})`
        world.style.opacity = "0"
        leaving.current = setTimeout(() => {
          arriving.current = toward ? "in" : "out"
          done()
          // No new map came, so bring the old one back.
          unclaimed.current = setTimeout(() => {
            if (!arriving.current) return
            arriving.current = null
            world.style.opacity = "1"
            fit()
          }, 400)
        }, exitMs)
      },
    }),
    [fit, transition]
  )

  // Fit before the first paint, and again whenever the content or the
  // viewport changes size, until the person moves the map themselves.
  const fittedKey = React.useRef(fitKey)
  React.useLayoutEffect(() => {
    let changed = false
    if (fittedKey.current !== fitKey) {
      fittedKey.current = fitKey
      moved.current = false
      changed = true
    }
    if (!moved.current) fit()
    const from = arriving.current
    const world = worldRef.current
    if (!changed || !from || !world) return
    arriving.current = null
    clearTimeout(unclaimed.current)
    // Start a little closer, or a little further, then settle into place.
    const viewport = viewportRef.current!
    const bounds = viewport.getBoundingClientRect()
    const target = { ...view.current }
    const factor = from === "in" ? 0.9 : 1.08
    const scale = target.scale * factor
    world.style.transition = ""
    world.style.transform = `translate(${bounds.width / 2 - ((bounds.width / 2 - target.x) / target.scale) * scale}px, ${bounds.height / 2 - ((bounds.height / 2 - target.y) / target.scale) * scale}px) scale(${scale})`
    world.style.opacity = "0"
    void world.offsetWidth
    transition(enterMs, "cubic-bezier(0, 0, 0.2, 1)")
    apply()
    world.style.opacity = "1"
  }, [apply, fit, fitKey, transition, width, height])

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(() => {
      if (!moved.current) fit()
    })
    observer.observe(viewport)
    // Trackpad pinches arrive as wheel events with ctrlKey. Plain wheel and
    // two-finger scrolls pan, as in other canvases.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const bounds = viewport.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) {
        zoomAt(
          Math.exp(-event.deltaY * 0.01),
          event.clientX - bounds.left,
          event.clientY - bounds.top
        )
        return
      }
      view.current = {
        ...view.current,
        x: view.current.x - event.deltaX,
        y: view.current.y - event.deltaY,
      }
      moved.current = true
      apply()
    }
    viewport.addEventListener("wheel", onWheel, { passive: false })
    return () => {
      observer.disconnect()
      viewport.removeEventListener("wheel", onWheel)
    }
  }, [apply, fit, zoomAt])

  const drag = React.useRef<{
    pointerId: number
    startX: number
    startY: number
    viewX: number
    viewY: number
    dragging: boolean
  } | null>(null)
  const suppressClick = React.useRef(false)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    suppressClick.current = false
    if (event.button !== 0) return
    if ((event.target as Element).closest("[data-map-control]")) return
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewX: view.current.x,
      viewY: view.current.y,
      dragging: false,
    }
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    if (!current.dragging) {
      if (Math.hypot(dx, dy) < 4) return
      current.dragging = true
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.dataset.dragging = ""
    }
    view.current = {
      ...view.current,
      x: current.viewX + dx,
      y: current.viewY + dy,
    }
    moved.current = true
    apply()
  }
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    if (current.dragging) {
      suppressClick.current = true
      delete event.currentTarget.dataset.dragging
    }
    drag.current = null
  }
  // A drag that starts on a card must not open it.
  const onClickCapture = (event: React.MouseEvent) => {
    if (!suppressClick.current) return
    suppressClick.current = false
    event.preventDefault()
    event.stopPropagation()
  }
  // Keep keyboard focus in view. The viewport clips its content, so the
  // browser would otherwise scroll it and desync the view.
  const onFocus = (event: React.FocusEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current
    if (!viewport || event.target === viewport) return
    viewport.scrollTo(0, 0)
    const bounds = viewport.getBoundingClientRect()
    const target = event.target.getBoundingClientRect()
    let dx = 0
    let dy = 0
    if (target.left < bounds.left + 16) dx = bounds.left + 16 - target.left
    else if (target.right > bounds.right - 16)
      dx = bounds.right - 16 - target.right
    if (target.top < bounds.top + 16) dy = bounds.top + 16 - target.top
    else if (target.bottom > bounds.bottom - 16)
      dy = bounds.bottom - 16 - target.bottom
    if (dx === 0 && dy === 0) return
    view.current = {
      ...view.current,
      x: view.current.x + dx,
      y: view.current.y + dy,
    }
    moved.current = true
    apply()
  }

  const resetView = React.useCallback(() => {
    moved.current = false
    fit()
  }, [fit])

  return (
    <div
      ref={viewportRef}
      role="region"
      aria-label="Infrastructure map"
      className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden rounded-xl border border-border/75 bg-card/25 select-none data-[dragging]:cursor-grabbing"
      style={{
        backgroundImage:
          "radial-gradient(circle, color-mix(in oklab, var(--muted-foreground) 22%, transparent) 1px, transparent 1.2px)",
        backgroundSize: `${dotSpacing}px ${dotSpacing}px`,
      }}
      onClickCapture={onClickCapture}
      // Cards are links; a native link drag would cancel the pan.
      onDragStart={preventDefault}
      onFocus={onFocus}
      onPointerCancel={endDrag}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
    >
      <div
        ref={worldRef}
        className="absolute top-0 left-0 origin-top-left"
        style={{ height, visibility: "hidden", width }}
      >
        {children}
      </div>
      <div
        data-map-control=""
        className="absolute top-3 left-3 flex flex-col overflow-hidden rounded-lg border border-border/80 bg-card shadow-sm"
      >
        <MapControl label="Zoom in" onClick={() => zoomAt(1.2)}>
          <Plus />
        </MapControl>
        <MapControl label="Zoom out" onClick={() => zoomAt(1 / 1.2)}>
          <Minus />
        </MapControl>
        <MapControl label="Fit to view" onClick={resetView}>
          <Maximize />
        </MapControl>
      </div>
      {overlay ? (
        <div data-map-control="" className="absolute top-3 left-14">
          {overlay}
        </div>
      ) : null}
      <span
        ref={zoomLabelRef}
        data-map-control=""
        aria-hidden="true"
        className="type-meta absolute bottom-3 left-3 rounded-md border border-border/80 bg-card px-1.5 py-0.5 font-mono text-muted-foreground tabular-nums"
      >
        100%
      </span>
    </div>
  )
}

function MapControl({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className="size-8 rounded-none text-muted-foreground shadow-none hover:text-foreground"
          size="icon"
          type="button"
          variant="ghost"
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function preventDefault(event: React.SyntheticEvent) {
  event.preventDefault()
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
