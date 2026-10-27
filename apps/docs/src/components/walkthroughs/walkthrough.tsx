import * as React from "react"
import { Pause, Play } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

// Plays a walkthrough: a scene drawn at 960 × 600 that a camera pans and
// zooms over, with an oversized cursor that moves and clicks. Each frame names
// what the cursor and camera aim at, by `data-target` in the scene, so they
// follow the UI if it moves. Only this component renders as it plays, and only
// while it's on screen.

const width = 960
const height = 600

export interface Point {
  x: number
  y: number
}

// A point in the scene, or an element marked with data-target="…".
export type Aim = Point | { target: string }

export interface Frame<State> {
  // Which of the scene's steps this frame shows, from 0.
  step: number
  duration: number
  // Which view is showing, such as "app" or "terminal".
  scene: string
  camera: { scale: number; focus?: Aim }
  cursor?: Aim & { click?: boolean }
  // A badge for sped-up parts, such as "8×".
  speed?: string
  // What changes in the scene from this frame on.
  state?: Partial<State>
}

export interface Scene<State> {
  label: string
  steps: Array<string>
  frames: Array<Frame<State>>
  initial: State
  views: Array<string>
  render: (context: { view: string; state: State }) => React.ReactNode
}

export function Walkthrough<State>({ scene }: { scene: Scene<State> }) {
  const states = React.useMemo(() => {
    let state = scene.initial
    return scene.frames.map((frame) => (state = { ...state, ...frame.state }))
  }, [scene])
  const reducedMotion = usePrefersReducedMotion()
  const [index, setIndex] = React.useState(0)
  const [paused, setPaused] = React.useState(false)
  const playing = !paused && !reducedMotion
  const frame = scene.frames[index] ?? scene.frames[0]
  const state = states[index] ?? scene.initial

  const stageRef = React.useRef<HTMLDivElement>(null)
  const cameraRef = React.useRef<HTMLDivElement>(null)
  const visible = useOnScreen(stageRef)
  const fit = useFit(stageRef)

  // Advance while playing and on screen; loop at the end.
  React.useEffect(() => {
    if (!playing || !visible || !frame) return
    const timer = window.setTimeout(
      () => setIndex((current) => (current + 1) % scene.frames.length),
      frame.duration
    )
    return () => window.clearTimeout(timer)
  }, [frame, playing, scene.frames.length, visible])

  // Where the cursor and camera aim, measured from the scene once it renders.
  const [aims, setAims] = React.useState<{ cursor?: Point; focus?: Point }>({})
  React.useLayoutEffect(() => {
    const root = cameraRef.current
    if (!root || !frame) return
    setAims({
      cursor: frame.cursor ? resolve(root, frame.cursor) : undefined,
      focus: frame.camera.focus ? resolve(root, frame.camera.focus) : undefined,
    })
  }, [frame, state])

  if (!frame) return null
  const step = frame.step
  const camera = cameraTransform(frame.camera.scale, aims.focus)
  const jump = (to: number) => {
    const first = scene.frames.findIndex((candidate) => candidate.step === to)
    if (first !== -1) setIndex(first)
  }

  return (
    <div className="overflow-hidden border border-border bg-card">
      <div
        ref={stageRef}
        role="img"
        aria-label={`${scene.label}: ${scene.steps[step] ?? ""}`}
        className="relative aspect-[16/10] overflow-hidden"
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ width, height, transform: `scale(${fit})` }}
        >
          <div
            ref={cameraRef}
            className={cn(
              "relative size-full origin-top-left",
              !reducedMotion &&
                "transition-transform duration-[900ms] ease-[cubic-bezier(0.65,0,0.35,1)]"
            )}
            style={{ transform: camera }}
            aria-hidden="true"
          >
            {scene.views.map((view) => (
              <div
                key={view}
                data-view={view}
                className={cn(
                  "absolute inset-0 transition-opacity duration-500",
                  view === frame.scene
                    ? "opacity-100"
                    : "pointer-events-none opacity-0"
                )}
              >
                {scene.render({ view, state })}
              </div>
            ))}
            <Cursor
              point={aims.cursor}
              clicking={frame.cursor?.click ?? false}
              hidden={!frame.cursor}
            />
          </div>
        </div>
        {frame.speed ? (
          <span className="absolute top-3 right-3 border border-white/15 bg-black/60 px-2 py-0.5 font-mono text-xs text-white/80 backdrop-blur">
            {frame.speed} speed
          </span>
        ) : null}
      </div>
      <div className="flex h-12 items-center gap-3 border-t border-border px-3">
        <button
          type="button"
          onClick={() => setPaused((current) => !current)}
          aria-label={playing ? "Pause" : "Play"}
          className="grid size-7 shrink-0 place-items-center text-muted-foreground transition-colors hover:text-foreground"
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>
        <div role="list" className="flex shrink-0 gap-1.5">
          {scene.steps.map((label, number) => (
            <div key={label} role="listitem">
              <button
                type="button"
                onClick={() => jump(number)}
                aria-label={`Step ${number + 1}: ${label}`}
                aria-current={number === step ? "step" : undefined}
                className="grid size-6 place-items-center border border-border text-xs text-muted-foreground transition-colors hover:text-foreground aria-[current=step]:border-primary aria-[current=step]:bg-primary/15 aria-[current=step]:text-foreground"
              >
                {number + 1}
              </button>
            </div>
          ))}
        </div>
        <div className="line-clamp-2 min-w-0 text-xs leading-snug text-foreground/85 sm:text-sm">
          {scene.steps[step]}
        </div>
      </div>
    </div>
  )
}

function Cursor({
  clicking,
  hidden,
  point,
}: {
  clicking: boolean
  hidden: boolean
  point: Point | undefined
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute top-0 left-0 z-10 transition-[translate,opacity] duration-[900ms] ease-[cubic-bezier(0.65,0,0.35,1)]",
        hidden || !point ? "opacity-0" : "opacity-100"
      )}
      style={{ translate: point ? `${point.x}px ${point.y}px` : undefined }}
    >
      {clicking ? (
        <span className="absolute -top-5 -left-5 size-10 animate-ping rounded-full bg-primary/50" />
      ) : null}
      <svg
        viewBox="0 0 24 24"
        className={cn(
          "relative -mt-0.5 -ml-0.5 size-8 drop-shadow-[0_2px_4px_rgba(0,0,0,0.6)] transition-transform duration-150",
          clicking && "scale-90"
        )}
      >
        <path
          d="M4 2.5 19.5 13l-7 1.2L9.2 21z"
          fill="white"
          stroke="black"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

// The camera moves so the focus sits in the middle, without showing past the
// scene's edges.
function cameraTransform(scale: number, focus: Point | undefined): string {
  if (scale === 1 || !focus) return "translate(0px, 0px) scale(1)"
  const x = clamp(width / 2 - focus.x * scale, width - width * scale, 0)
  const y = clamp(height / 2 - focus.y * scale, height - height * scale, 0)
  return `translate(${x}px, ${y}px) scale(${scale})`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

// An aim's centre in the scene's own coordinates. Offsets ignore the
// camera's transform, so the answer is the same at any zoom.
function resolve(root: HTMLElement, aim: Aim): Point | undefined {
  if ("x" in aim) return aim
  const element = [
    ...root.querySelectorAll<HTMLElement>(`[data-target="${aim.target}"]`),
  ].find((candidate) => candidate.offsetParent !== null)
  if (!element) return undefined
  let x = element.offsetWidth / 2
  let y = element.offsetHeight / 2
  let current: HTMLElement | null = element
  while (current && current !== root) {
    x += current.offsetLeft
    y += current.offsetTop
    current = current.offsetParent as HTMLElement | null
  }
  return { x, y }
}

function useFit(ref: React.RefObject<HTMLDivElement | null>): number {
  const [fit, setFit] = React.useState(1)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setFit(entry.contentRect.width / width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return fit
}

function useOnScreen(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [onScreen, setOnScreen] = React.useState(false)
  React.useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(
      ([entry]) => setOnScreen(entry?.isIntersecting ?? false),
      { threshold: 0.35 }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return onScreen
}

function usePrefersReducedMotion(): boolean {
  return React.useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(prefers-reduced-motion: reduce)")
      query.addEventListener("change", onChange)
      return () => query.removeEventListener("change", onChange)
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false
  )
}
