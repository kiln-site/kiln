import * as React from "react"

// Drives the desktop like a laptop's trackpad, as a phone screen's too small to
// point at it directly: the pointer stays where it is until a finger moves it.
// This is a layer over noVNC's canvas that turns gestures into the mouse events
// noVNC already takes from it, so scaling, throttling, and the Mac's own cursor
// all carry on as they are.

const GAIN = { mouse: 1, touch: 1.5 }
// Far enough, in pixels, that a tap with a shaky finger is still a tap.
const TAP_SLOP = 10
const TAP_MS = 300
const LONG_PRESS_MS = 500
const DOUBLE_TAP_MS = 300
const SCROLL_GAIN = 2

const LEFT = { button: 0, buttons: 1 }
const RIGHT = { button: 2, buttons: 2 }

type Button = typeof LEFT | typeof RIGHT

interface Finger {
  x: number
  y: number
}

type Gesture =
  | { kind: "idle" }
  // One finger, which might still be a tap.
  | { kind: "one"; moved: boolean; startedAt: number; startX: number; startY: number }
  // A second tap that stayed down: dragging with the button held.
  | { kind: "held"; moved: boolean; startX: number; startY: number }
  | { kind: "two"; moved: boolean; startedAt: number; x: number; y: number }
  // Finished, waiting for every finger to lift.
  | { kind: "done" }

// noVNC's own test for a device whose cursor it draws.
const drawsCursor = () =>
  "ontouchstart" in document.documentElement || navigator.maxTouchPoints > 0

function middleOf(fingers: ReadonlyMap<number, Finger>) {
  let x = 0
  let y = 0
  for (const finger of fingers.values()) {
    x += finger.x
    y += finger.y
  }
  return { x: x / fingers.size, y: y / fingers.size }
}

export function DesktopTrackpad({
  image,
  onUsed,
}: {
  image: () => HTMLCanvasElement | null
  onUsed: () => void
}) {
  const layer = React.useRef<HTMLDivElement>(null)
  const arrow = React.useRef<SVGSVGElement>(null)
  // A share of the image, so it stays put when the picture's size changes.
  const position = React.useRef({ x: 0.5, y: 0.5 })
  const fingers = React.useRef(new Map<number, Finger>())
  const gesture = React.useRef<Gesture>({ kind: "idle" })
  const lastTapAt = React.useRef(0)
  const longPress = React.useRef<ReturnType<typeof setTimeout>>(undefined)

  const place = React.useCallback(() => {
    const canvas = image()
    const area = layer.current?.getBoundingClientRect()
    const shown = arrow.current
    if (!canvas || !area || !shown) return null
    const box = canvas.getBoundingClientRect()
    const clientX = box.left + position.current.x * box.width
    const clientY = box.top + position.current.y * box.height
    shown.style.transform = `translate(${clientX - area.left}px, ${clientY - area.top}px)`
    // noVNC draws the Mac's cursor on touch screens, but outside the fullscreen
    // element, where it can't be seen.
    shown.style.visibility =
      drawsCursor() && !document.fullscreenElement ? "hidden" : "visible"
    return { canvas, clientX, clientY }
  }, [image])

  const send = React.useCallback(
    (type: string, button: Button | null, buttons = button?.buttons ?? 0) => {
      const point = place()
      if (!point) return
      const event = () =>
        new MouseEvent(type, {
          bubbles: true,
          button: button?.button ?? 0,
          buttons,
          cancelable: true,
          clientX: point.clientX,
          clientY: point.clientY,
        })
      point.canvas.dispatchEvent(event())
      // A press has noVNC cover the page to catch the release, which it hears
      // on the window. It stops events at its canvas, so without this the page
      // stays covered.
      if (type === "mouseup") window.dispatchEvent(event())
    },
    [place]
  )

  const click = React.useCallback(
    (button: Button) => {
      send("mousedown", button)
      send("mouseup", button, 0)
    },
    [send]
  )

  const scroll = React.useCallback(
    (deltaX: number, deltaY: number) => {
      const point = place()
      point?.canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: point.clientX,
          clientY: point.clientY,
          deltaX,
          deltaY,
        })
      )
    },
    [place]
  )

  // Starts in the middle, and stays right as the picture resizes.
  React.useEffect(() => {
    const area = layer.current
    if (!area) return
    send("mousemove", null)
    const observer = new ResizeObserver(() => place())
    observer.observe(area)
    return () => observer.disconnect()
  }, [place, send])

  // Layout, as the canvas and this layer are still there to send it through. A
  // button held as the toggle goes off would otherwise stay down on the Mac.
  React.useLayoutEffect(
    () => () => {
      clearTimeout(longPress.current)
      if (gesture.current.kind === "held") send("mouseup", LEFT, 0)
    },
    [send]
  )

  const moveBy = (dx: number, dy: number, gain: number) => {
    const box = image()?.getBoundingClientRect()
    if (!box?.width || !box.height) return
    const moved = (value: number, delta: number, size: number) =>
      Math.min(Math.max(value + (delta * gain) / size, 0), 1)
    position.current = {
      x: moved(position.current.x, dx, box.width),
      y: moved(position.current.y, dy, box.height),
    }
  }

  const finish = () => {
    clearTimeout(longPress.current)
    const held = gesture.current.kind === "held"
    gesture.current = { kind: "idle" }
    fingers.current.clear()
    if (held) send("mouseup", LEFT, 0)
  }

  return (
    <div
      ref={layer}
      aria-hidden
      className="absolute inset-0 touch-none overflow-hidden"
      onContextMenu={(event) => event.preventDefault()}
      // After an ordinary release, the finger's already gone from the list.
      onLostPointerCapture={(event) => {
        if (fingers.current.has(event.pointerId)) finish()
      }}
      onPointerCancel={finish}
      onPointerDown={(event) => {
        // Keeps a phone's keyboard open, and the browser's selection away.
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        clearTimeout(longPress.current)
        onUsed()
        if (event.pointerType === "mouse" && event.button === 2) {
          click(RIGHT)
          return
        }
        fingers.current.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        })
        const now = event.timeStamp
        if (fingers.current.size === 2) {
          // A held button lets go, and a tap that became two fingers isn't one.
          if (gesture.current.kind === "held") send("mouseup", LEFT, 0)
          gesture.current = {
            kind: "two",
            moved: false,
            startedAt: now,
            ...middleOf(fingers.current),
          }
          return
        }
        if (fingers.current.size > 2) {
          gesture.current = { kind: "done" }
          return
        }
        const startX = event.clientX
        const startY = event.clientY
        if (now - lastTapAt.current < DOUBLE_TAP_MS) {
          gesture.current = { kind: "held", moved: false, startX, startY }
          send("mousedown", LEFT)
          return
        }
        gesture.current = {
          kind: "one",
          moved: false,
          startedAt: now,
          startX,
          startY,
        }
        longPress.current = setTimeout(() => {
          if (gesture.current.kind !== "one" || gesture.current.moved) return
          gesture.current = { kind: "done" }
          click(RIGHT)
        }, LONG_PRESS_MS)
      }}
      onPointerMove={(event) => {
        const finger = fingers.current.get(event.pointerId)
        if (!finger) return
        const current = gesture.current
        if (current.kind === "two") {
          // One's lifted, and the other's on its way: fingers rarely go at once.
          if (fingers.current.size < 2) return
          const before = middleOf(fingers.current)
          finger.x = event.clientX
          finger.y = event.clientY
          const after = middleOf(fingers.current)
          current.moved ||=
            Math.hypot(after.x - current.x, after.y - current.y) > TAP_SLOP
          // As on a laptop: the page follows the fingers.
          if (current.moved) {
            scroll(
              (before.x - after.x) * SCROLL_GAIN,
              (before.y - after.y) * SCROLL_GAIN
            )
          }
          return
        }
        if (current.kind !== "one" && current.kind !== "held") return
        const distance = Math.hypot(
          event.clientX - current.startX,
          event.clientY - current.startY
        )
        if (!current.moved && distance <= TAP_SLOP) return
        // From where the finger started, the first time, so a drag doesn't
        // lose what looked like it might have been a tap.
        const dx = event.clientX - (current.moved ? finger.x : current.startX)
        const dy = event.clientY - (current.moved ? finger.y : current.startY)
        finger.x = event.clientX
        finger.y = event.clientY
        current.moved = true
        clearTimeout(longPress.current)
        const gain = event.pointerType === "mouse" ? GAIN.mouse : GAIN.touch
        moveBy(dx, dy, gain)
        send("mousemove", current.kind === "held" ? LEFT : null)
      }}
      onPointerUp={(event) => {
        clearTimeout(longPress.current)
        fingers.current.delete(event.pointerId)
        const current = gesture.current
        if (fingers.current.size > 0) return
        gesture.current = { kind: "idle" }
        const quick = (startedAt: number) =>
          event.timeStamp - startedAt < TAP_MS
        if (current.kind === "held") {
          send("mouseup", LEFT, 0)
          // A second tap that never moved was a double click: the first of
          // them already went out.
        } else if (current.kind === "one") {
          if (!current.moved && quick(current.startedAt)) {
            click(LEFT)
            lastTapAt.current = event.timeStamp
          }
        } else if (current.kind === "two") {
          if (!current.moved && quick(current.startedAt)) click(RIGHT)
        }
      }}
      onWheel={(event) => scroll(event.deltaX, event.deltaY)}
    >
      <svg
        ref={arrow}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 size-5 drop-shadow"
        viewBox="0 0 20 20"
      >
        <path
          d="M2 1v15l4-3.5 2.5 6 3-1.3-2.5-5.7h5.5z"
          fill="white"
          stroke="black"
          strokeWidth="1"
        />
      </svg>
    </div>
  )
}
