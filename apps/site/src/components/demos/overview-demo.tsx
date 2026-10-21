import * as React from "react"
import { ArrowLeft } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { TooltipProvider } from "@workspace/ui/components/tooltip"

import { MapLinks, MapViewport } from "@/components/infra-map-canvas"
import {
  buildInfraMapView,
  infraMapScopeKey,
  type InfraMapScope,
} from "@/lib/infra-map-model"

import { demoFleet } from "~/components/demos/overview-data"
import { MapGroup, MapNode } from "~/components/demos/overview-nodes"

// The map from Hearth's infrastructure overview, for a small fleet: Hearth,
// each Relay, and what runs on it. Choosing a Relay or an instance scopes
// the map, as it does in Hearth.
export default function OverviewDemo() {
  const [scope, setScope] = React.useState<InfraMapScope>({ kind: "all" })
  const frameRef = React.useRef<HTMLDivElement>(null)
  // The fleet stays left to right even when narrow: down, Hearth sets its
  // Relays side by side, too small to read in a phone-sized window.
  const narrow = useNarrow(frameRef)
  const direction = narrow && scope.kind !== "all" ? "down" : "right"
  const view = React.useMemo(
    () => buildInfraMapView(demoFleet, scope, direction),
    [direction, scope]
  )
  const { layout } = view

  // Hearth's map pans on every wheel event. On this page a plain scroll
  // should move the page, so only a pinch (ctrl + wheel) reaches the map.
  React.useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const passScroll = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) event.stopPropagation()
    }
    frame.addEventListener("wheel", passScroll, { capture: true })
    return () => frame.removeEventListener("wheel", passScroll, true)
  }, [])

  return (
    <TooltipProvider delayDuration={250}>
      <div
        ref={frameRef}
        className="relative flex h-[30rem] flex-col text-left sm:h-[38rem] [&_[role=region]]:touch-pan-y"
      >
        <MapViewport
          fitKey={`${infraMapScopeKey(scope)}:${direction}`}
          width={layout.width}
          height={layout.height}
        >
          {layout.groups.map((group) => {
            const label = view.groupLabels.get(group.id)
            return group.labelled && label ? (
              <MapGroup
                key={group.id}
                label={label}
                rect={group.rect}
                onSelect={setScope}
              />
            ) : null
          })}
          <MapLinks layout={layout} />
          {[...layout.nodes].map(([id, rect]) => (
            <MapNode
              key={id}
              node={view.nodes.get(id)!}
              rect={rect}
              onSelect={setScope}
            />
          ))}
        </MapViewport>
        {scope.kind === "all" ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="absolute top-3 right-3 bg-card shadow-sm"
            onClick={() => setScope({ kind: "all" })}
          >
            <ArrowLeft />
            All instances
          </Button>
        )}
      </div>
    </TooltipProvider>
  )
}

// Whether the map is phone-sized, where Hearth draws it top to bottom.
function useNarrow(ref: React.RefObject<HTMLElement | null>) {
  const [narrow, setNarrow] = React.useState(false)
  React.useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      setNarrow((entry?.contentRect.width ?? 0) < 640)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return narrow
}
