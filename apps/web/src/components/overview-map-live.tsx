import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { TriangleAlert, Unplug } from "lucide-react"

import { nodeStyle } from "@/components/infra-map-canvas"
import {
  Entry,
  Flag,
  FocusRelayContent,
  focusCardClass,
  HearthCard,
  InstanceContent,
  instanceCardClass,
  RelayCard,
  RestrictedFocusRelayCard,
  StatusDot,
  usageWarning,
  type OverviewInstance,
  type OverviewKind,
  type OverviewReadings,
  type OverviewRelay,
  type OverviewServices,
} from "@/components/overview-map-cards"
import { RelativeTime } from "@/components/relative-time"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { useInstanceState } from "@/lib/instance-state"
import { instanceStatePresentation } from "@/lib/instance-state-presentation"
import type { OverviewRect } from "@/lib/overview-map-layout"
import {
  relayNodeReadingsQueryOptions,
  type RelayNodeReading,
} from "@/lib/query-options"

// The overview map's cards fed from Hearth: each Relay's status from the
// shared connection poll, its machine from the shared readings poll, and
// each instance's state from its Relay's inventory.

export const LiveHearthCard = React.memo(function LiveHearthCard({
  host,
  provider,
  rect,
  relays,
}: {
  host: string
  provider: "cloudflare" | "vercel" | null
  rect: OverviewRect
  relays: ReadonlyArray<OverviewRelay>
}) {
  return (
    <HearthCard
      host={host}
      provider={provider}
      rect={rect}
      relayCount={relays.length}
    >
      {relays.map((relay) =>
        relay.restricted ? null : <RelayDot key={relay.id} relay={relay} />
      )}
    </HearthCard>
  )
})

function RelayDot({ relay }: { relay: OverviewRelay }) {
  const { presentation } = useRelayLiveStatus(relay)
  return <StatusDot name={relay.name} status={presentation} />
}

export const LiveRelayCard = React.memo(function LiveRelayCard({
  counts,
  onOpen,
  rect,
  relay,
  services,
  wire,
}: {
  counts: Record<OverviewKind, number>
  onOpen: (relayId: string, rect: OverviewRect) => void
  rect: OverviewRect
  relay: OverviewRelay
  services: OverviewServices | undefined
  wire: string | undefined
}) {
  if (relay.restricted)
    return (
      <RelayCard
        counts={counts}
        rect={rect}
        relay={relay}
        services={undefined}
        status={null}
        wire={wire}
        onOpen={onOpen}
      />
    )
  return (
    <ReadableRelayCard
      counts={counts}
      rect={rect}
      relay={relay}
      services={services}
      wire={wire}
      onOpen={onOpen}
    />
  )
})

function ReadableRelayCard({
  counts,
  onOpen,
  rect,
  relay,
  services,
  wire,
}: {
  counts: Record<OverviewKind, number>
  onOpen: (relayId: string, rect: OverviewRect) => void
  rect: OverviewRect
  relay: OverviewRelay
  services: OverviewServices | undefined
  wire: string | undefined
}) {
  const live = useRelayLiveStatus(relay)
  return (
    <RelayCard
      counts={counts}
      flag={
        live.relayStatus === "unreachable" ? (
          <LastSeen relay={relay} />
        ) : live.connected ? (
          <UsageFlag relayId={relay.id} />
        ) : null
      }
      rect={rect}
      relay={relay}
      services={services}
      status={live.presentation}
      wire={wire}
      onOpen={onOpen}
    />
  )
}

function LastSeen({ relay }: { relay: OverviewRelay }) {
  const seen = relay.lastConnectedAt ? Date.parse(relay.lastConnectedAt) : NaN
  if (!Number.isFinite(seen)) return null
  return (
    <Flag tone="danger">
      <Unplug className="size-3 shrink-0" aria-hidden="true" />
      Seen <RelativeTime timestamp={seen} />
    </Flag>
  )
}

function UsageFlag({ relayId }: { relayId: string }) {
  const select = React.useCallback(
    (readings: ReadonlyArray<RelayNodeReading>) => {
      const reading = readings.find((entry) => entry.relayId === relayId)
      return reading ? usageWarning(overviewReadings(reading)) : null
    },
    [relayId]
  )
  const { data: warning } = useQuery({
    ...relayNodeReadingsQueryOptions(),
    notifyOnChangeProps: ["data"],
    select,
  })
  return warning ? (
    <Flag tone="warning">
      <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />
      {warning}
    </Flag>
  ) : null
}

function overviewReadings(reading: RelayNodeReading): OverviewReadings {
  return {
    cpu: reading.cpu.loadPercent,
    memory: usage(reading.memory),
    disk: usage(reading.storage),
  }
}

function usage(reading: { totalBytes: number; usedBytes: number }) {
  return reading.totalBytes > 0
    ? (reading.usedBytes / reading.totalBytes) * 100
    : null
}

/** The Relay a Relay map is about, on its left. Opens the Relay's page. */
export const LiveFocusRelayCard = React.memo(function LiveFocusRelayCard({
  rect,
  relay,
  services,
}: {
  rect: OverviewRect
  relay: OverviewRelay
  services: OverviewServices | undefined
}) {
  if (relay.restricted)
    return <RestrictedFocusRelayCard rect={rect} relay={relay} />
  return (
    <ReadableFocusRelayCard rect={rect} relay={relay} services={services} />
  )
})

function ReadableFocusRelayCard({
  rect,
  relay,
  services,
}: {
  rect: OverviewRect
  relay: OverviewRelay
  services: OverviewServices | undefined
}) {
  const live = useRelayLiveStatus(relay)
  const select = React.useCallback(
    (readings: ReadonlyArray<RelayNodeReading>) => {
      const reading = readings.find((entry) => entry.relayId === relay.id)
      return reading ? overviewReadings(reading) : null
    },
    [relay.id]
  )
  const { data: readings } = useQuery({
    ...relayNodeReadingsQueryOptions(),
    enabled: live.connected,
    notifyOnChangeProps: ["data"],
    select,
  })
  return (
    <Link
      to="/relay/$relayId"
      params={{ relayId: relay.id }}
      preload="intent"
      className={focusCardClass}
      data-paused={relay.enabled ? undefined : ""}
      style={nodeStyle(rect)}
    >
      <FocusRelayContent
        readings={live.connected ? (readings ?? null) : null}
        relay={relay}
        services={services}
        status={live.presentation}
      />
    </Link>
  )
}

/** A game server, app or database on the Relay in view. Opens its page. */
export const LiveInstanceCard = React.memo(function LiveInstanceCard({
  instance,
  rect,
  services,
  wire,
}: {
  instance: OverviewInstance
  rect: OverviewRect
  services: OverviewServices | undefined
  wire: string | undefined
}) {
  const state = useInstanceState({
    kind: instance.kind,
    id: instance.id,
    relayId: instance.relayId,
  })
  const status = instanceStatePresentation(state)
  const content = (
    <InstanceContent instance={instance} services={services} status={status} />
  )
  const style = nodeStyle(rect)
  return (
    <Entry status={status} wire={wire}>
      {instance.kind === "server" ? (
        <Link
          to="/server/$serverId"
          params={{ serverId: instance.routeId }}
          preload="intent"
          className={instanceCardClass}
          style={style}
        >
          {content}
        </Link>
      ) : instance.kind === "app" ? (
        <Link
          to="/app/$appId"
          params={{ appId: instance.routeId }}
          preload="intent"
          className={instanceCardClass}
          style={style}
        >
          {content}
        </Link>
      ) : (
        <Link
          to="/db/$databaseId"
          params={{ databaseId: instance.routeId }}
          preload="intent"
          className={instanceCardClass}
          style={style}
        >
          {content}
        </Link>
      )}
    </Entry>
  )
})
