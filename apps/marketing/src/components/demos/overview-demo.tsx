import * as React from "react"
import { TriangleAlert } from "lucide-react"

import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import {
  MapViewport,
  nodeStyle,
  type MapViewportHandle,
} from "@/components/infra-map-canvas"
import {
  BackToFleet,
  Entry,
  Flag,
  fleetGroups,
  FocusRelayContent,
  focusCardClass,
  GroupHeadings,
  HearthCard,
  InstanceContent,
  instanceCardClass,
  layoutFleet,
  layoutRelay,
  overviewWorldClass,
  RelayCard,
  relayGroups,
  StatusDot,
  Trunk,
  usageWarning,
  type OverviewKind,
} from "@/components/overview-map-cards"
import type { OverviewRect } from "@/lib/overview-map-layout"

import {
  demoInstances,
  demoRelays,
  instanceServices,
  instanceStatus,
  relayReadings,
  relayServices,
  relayStatus,
} from "~/components/demos/overview-data"

// Hearth's overview map, for a small fleet: Hearth and each Relay, grouped
// by whether Hearth can reach it. Opening a Relay zooms into its map, as it
// does in Hearth; its instances stay put here.
export default function OverviewDemo() {
  const [relayId, setRelayId] = React.useState<string | null>(null)
  const frameRef = React.useRef<HTMLDivElement>(null)
  const viewport = React.useRef<MapViewportHandle>(null)
  // Phone-sized, the map flows down, as Hearth's does.
  const direction = useNarrow(frameRef) ? "down" : "right"

  const fleet = React.useMemo(() => fleetGroups(demoRelays), [])
  const fleetLayout = React.useMemo(
    () => layoutFleet(fleet, direction),
    [direction, fleet]
  )
  const focus = demoRelays.find((relay) => relay.id === relayId)
  const relay = React.useMemo(
    () => (focus ? relayGroups(demoInstances, focus.id) : null),
    [focus]
  )
  const relayLayout = React.useMemo(
    () => (relay ? layoutRelay(relay, direction) : null),
    [direction, relay]
  )
  const layout = relayLayout ?? fleetLayout

  const open = React.useCallback(
    (id: string, rect: OverviewRect) =>
      viewport.current
        ? viewport.current.leave(rect, () => setRelayId(id))
        : setRelayId(id),
    []
  )
  const back = React.useCallback(
    () =>
      viewport.current
        ? viewport.current.leave(null, () => setRelayId(null))
        : setRelayId(null),
    []
  )

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
          controller={viewport}
          fitKey={`${relayId ?? "all"}:${direction}`}
          width={layout.width}
          height={layout.height}
          overlay={
            focus ? <BackToFleet name={focus.name} onBack={back} /> : null
          }
        >
          {focus && relay && relayLayout ? (
            <div className={overviewWorldClass}>
              <Trunk path={relayLayout.trunk} />
              <div
                className={focusCardClass}
                style={nodeStyle(relayLayout.root)}
              >
                <FocusRelayContent
                  readings={relayReadings[focus.id] ?? null}
                  relay={focus}
                  services={relayServices[focus.id]}
                  status={relayStatus[focus.id]!}
                />
              </div>
              <GroupHeadings groups={relay} layout={relayLayout} />
              {relay.flatMap((group) =>
                group.instances.map((instance) => {
                  const status = instanceStatus(instance)
                  return (
                    <Entry
                      key={instance.key}
                      status={status}
                      wire={relayLayout.wires.get(instance.key)}
                    >
                      <div
                        className={cn(instanceCardClass, "cursor-default")}
                        style={nodeStyle(relayLayout.cards.get(instance.key)!)}
                      >
                        <InstanceContent
                          instance={instance}
                          services={instanceServices[instance.key]}
                          status={status}
                        />
                      </div>
                    </Entry>
                  )
                })
              )}
            </div>
          ) : (
            <div className={overviewWorldClass}>
              <Trunk path={fleetLayout.trunk} />
              <HearthCard
                host="panel.kiln.site"
                provider="cloudflare"
                rect={fleetLayout.root}
                relayCount={demoRelays.length}
              >
                {demoRelays.map((relay) => (
                  <StatusDot
                    key={relay.id}
                    name={relay.name}
                    status={relayStatus[relay.id]!}
                  />
                ))}
              </HearthCard>
              <GroupHeadings groups={fleet} layout={fleetLayout} />
              {fleet.flatMap((group) =>
                group.relays.map((relay) => {
                  const warning = usageWarning(relayReadings[relay.id]!)
                  return (
                    <RelayCard
                      key={relay.id}
                      counts={countFor(relay.id)}
                      flag={
                        warning ? (
                          <Flag tone="warning">
                            <TriangleAlert
                              className="size-3 shrink-0"
                              aria-hidden="true"
                            />
                            {warning}
                          </Flag>
                        ) : null
                      }
                      rect={fleetLayout.cards.get(relay.id)!}
                      relay={relay}
                      services={relayServices[relay.id]}
                      status={relayStatus[relay.id]!}
                      wire={fleetLayout.wires.get(relay.id)}
                      onOpen={open}
                    />
                  )
                })
              )}
            </div>
          )}
        </MapViewport>
      </div>
    </TooltipProvider>
  )
}

function countFor(relayId: string): Record<OverviewKind, number> {
  const counts = { server: 0, app: 0, database: 0 }
  for (const instance of demoInstances)
    if (instance.relayId === relayId) counts[instance.kind] += 1
  return counts
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
