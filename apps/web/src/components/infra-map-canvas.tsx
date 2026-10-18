import * as React from "react"
import { Maximize, Minus, Plus } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import type { InfraMapLayout, InfraMapRect } from "@/lib/infra-map-layout"

export function nodeStyle(rect: InfraMapRect): React.CSSProperties {
  return {
    height: rect.height,
    left: rect.x,
    top: rect.y,
    width: rect.width,
  }
}

// Opaque strokes, so lines sharing a track draw as one line.
const linkClasses = {
  uplink: "stroke-[color-mix(in_oklab,var(--muted-foreground)_75%,var(--background))]",
  dns: "stroke-orange-400",
  route: "stroke-violet-400",
  database: "stroke-blue-400",
} as const

export const MapLinks = React.memo(function MapLinks({
  layout,
}: {
  layout: InfraMapLayout
}) {
  return (
    <svg
      aria-hidden="true"
      data-map-links=""
      className="group/links pointer-events-none absolute top-0 left-0 overflow-visible"
      width={layout.width}
      height={layout.height}
      fill="none"
    >
      {layout.links.map((link) => (
        <path
          key={link.id}
          d={link.path}
          data-from={link.from}
          data-to={link.to}
          className={cn(
            linkClasses[link.kind],
            link.muted && "opacity-50",
            // While a node is hovered, its own links stand out.
            "group-data-[highlighting]/links:opacity-15 data-[active]:!opacity-100"
          )}
          strokeDasharray={
            link.kind === "dns" ? "3 5" : link.muted ? "6 6" : undefined
          }
          strokeLinecap="round"
          strokeWidth={1.5}
        />
      ))}
    </svg>
  )
})

const minZoom = 0.1
const maxZoom = 2
const fitPadding = 40
const dotSpacing = 20

/**
 * A pannable, zoomable canvas. The view lives in a ref and is written to the
 * DOM directly, so dragging and zooming never re-render the map.
 */
export function MapViewport({
  children,
  fitKey,
  height,
  width,
}: {
  children: React.ReactNode
  /** Refits the view whenever this changes, as when the scope does. */
  fitKey: string
  height: number
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
      y: Math.max(
        fitPadding,
        (bounds.height - contentHeight * scale) / 2
      ),
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

  // Fit before the first paint, and again whenever the content or the
  // viewport changes size, until the person moves the map themselves.
  const fittedKey = React.useRef(fitKey)
  React.useLayoutEffect(() => {
    if (fittedKey.current !== fitKey) {
      fittedKey.current = fitKey
      moved.current = false
    }
    if (!moved.current) fit()
  }, [fit, fitKey, width, height])

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
    highlight(event.target)
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

  // Hovering or focusing a node lights its links. Written to the DOM, so
  // moving across the map re-renders nothing.
  const highlighted = React.useRef<string | null>(null)
  const highlight = (target: EventTarget | null) => {
    const element =
      target instanceof Element ? target.closest("[data-node-id]") : null
    const id = element?.getAttribute("data-node-id") ?? null
    if (id === highlighted.current) return
    highlighted.current = id
    const links = worldRef.current?.querySelector("[data-map-links]")
    if (!links) return
    for (const path of links.querySelectorAll("path[data-active]"))
      path.removeAttribute("data-active")
    if (!id) {
      links.removeAttribute("data-highlighting")
      return
    }
    let found = false
    for (const path of links.querySelectorAll("path")) {
      if (path.dataset.from === id || path.dataset.to === id) {
        path.setAttribute("data-active", "")
        found = true
      }
    }
    if (found) links.setAttribute("data-highlighting", "")
    else links.removeAttribute("data-highlighting")
  }
  const onPointerOver = (event: React.PointerEvent) => {
    if (!drag.current?.dragging) highlight(event.target)
  }
  const onPointerLeave = () => highlight(null)

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
      onPointerLeave={onPointerLeave}
      onPointerOver={onPointerOver}
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

function preventDefault(event: React.SyntheticEvent) {
  event.preventDefault()
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
