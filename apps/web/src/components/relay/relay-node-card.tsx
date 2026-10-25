import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Server } from "lucide-react"

import { InfoCopyValue, InfoFact, InfoRailCard } from "@/components/info-page"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { useUptime } from "@/components/resource-meters"
import { UsageBar } from "@/components/usage-bar"
import { formatBytes } from "@/lib/format-bytes"
import {
  relayNodeReadingsQueryOptions,
  relaySnapshotQueryOptions,
  type RelayNodeReading,
} from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import type { RelayDirectoryEntry } from "@/lib/relay-route"

export interface RelayNodeFacts {
  arch: string
  cpuModel: string | null
  dockerVersion: string
  operatingSystem: string | null
  bootedAt: string | null
  platform: string
  version: string
}

// The node's details change rarely; selecting just these keeps usage samples
// from re-rendering them.
export function useRelayNodeFacts(relayId: string): RelayNodeFacts | null {
  const select = React.useCallback(
    (snapshot: RelayFleetSnapshot): RelayNodeFacts | null => {
      const node = snapshot.nodes.find(
        (candidate) => candidate.relayId === relayId
      )
      if (!node) return null
      return {
        arch: node.arch,
        cpuModel: node.cpu.model ?? null,
        dockerVersion: node.docker.available
          ? (node.docker.version ?? "Available")
          : "Unavailable",
        operatingSystem: node.operatingSystem ?? null,
        bootedAt: node.bootedAt ?? null,
        platform: node.platform,
        version: node.version,
      }
    },
    [relayId]
  )
  const { data = null } = useQuery({ ...relaySnapshotQueryOptions(), select })
  return data
}

// The machine the Relay runs on: its whole usage, not just the Relay's, and
// what it runs.
export function RelayNodeCard({
  facts,
  relay,
}: {
  facts: RelayNodeFacts | null
  relay: RelayDirectoryEntry
}) {
  const { connected } = useRelayLiveStatus(relay)
  return (
    <InfoRailCard
      icon={<Server />}
      title="Node"
      summary={<RelayNodeUsage connected={connected} relayId={relay.id} />}
    >
      {facts ? (
        <>
          {facts.operatingSystem ? (
            <InfoFact label="OS">
              <InfoCopyValue
                label="operating system"
                value={facts.operatingSystem}
              />
            </InfoFact>
          ) : null}
          {facts.cpuModel ? (
            <InfoFact label="Processor">
              <span className="truncate" title={facts.cpuModel}>
                {facts.cpuModel}
              </span>
            </InfoFact>
          ) : null}
          <InfoFact label="System">
            {platformLabel(facts.platform)}, {facts.arch}
          </InfoFact>
          <InfoFact label="Docker">{facts.dockerVersion}</InfoFact>
          {facts.bootedAt ? (
            <InfoFact label="Uptime">
              <NodeUptime bootedAt={facts.bootedAt} connected={connected} />
            </InfoFact>
          ) : null}
        </>
      ) : (
        <p className="py-3 text-[0.8125rem] text-muted-foreground">
          {connected
            ? "Waiting for the Relay to report its node."
            : "Node details appear once Hearth reaches the Relay."}
        </p>
      )}
    </InfoRailCard>
  )
}

// Ticks on its own, so the rest of the card doesn't re-render.
function NodeUptime({
  bootedAt,
  connected,
}: {
  bootedAt: string
  connected: boolean
}) {
  return <>{useUptime(bootedAt, connected) ?? "—"}</>
}

// From the shared node poll; a new sample re-renders only these bars.
const RelayNodeUsage = React.memo(function RelayNodeUsage({
  connected,
  relayId,
}: {
  connected: boolean
  relayId: string
}) {
  const select = React.useCallback(
    (readings: ReadonlyArray<RelayNodeReading>) =>
      readings.find((reading) => reading.relayId === relayId) ?? null,
    [relayId]
  )
  const { data } = useQuery({
    ...relayNodeReadingsQueryOptions(),
    enabled: connected,
    notifyOnChangeProps: ["data"],
    select,
  })
  // A paused or unreachable Relay keeps its last poll in the cache; don't
  // present it as current.
  const reading = connected ? data : null
  // Node load is already normalized by the Relay. Display it in the same
  // units as container CPU (100% per core), then scale against all cores.
  const cpuUsed = reading
    ? reading.cpu.loadPercent * reading.cpu.cores
    : undefined

  return (
    <div className="flex flex-col gap-3 py-3">
      <UsageBar
        label="CPU"
        title="Load over the last minute, against the node's cores"
        value={cpuUsed === undefined ? "—" : `${Math.round(cpuUsed)}%`}
        detail={reading ? `${reading.cpu.cores} cores` : undefined}
        used={cpuUsed}
        total={reading ? reading.cpu.cores * 100 : undefined}
        indicatorClassName="[&_[data-slot=progress-indicator]]:bg-sky-400/85"
      />
      <UsageBar
        label="RAM"
        value={reading ? formatBytes(reading.memory.usedBytes) : "—"}
        detail={
          reading ? `of ${formatBytes(reading.memory.totalBytes)}` : undefined
        }
        used={reading?.memory.usedBytes}
        total={reading?.memory.totalBytes}
        indicatorClassName="[&_[data-slot=progress-indicator]]:bg-violet-400/85"
      />
      <UsageBar
        label="Disk"
        value={reading ? formatBytes(reading.storage.usedBytes) : "—"}
        detail={
          reading ? `of ${formatBytes(reading.storage.totalBytes)}` : undefined
        }
        used={reading?.storage.usedBytes}
        total={reading?.storage.totalBytes}
        indicatorClassName="[&_[data-slot=progress-indicator]]:bg-emerald-400/80"
      />
    </div>
  )
})

function platformLabel(platform: string): string {
  if (platform === "linux") return "Linux"
  if (platform === "darwin") return "macOS"
  if (platform === "win32") return "Windows"
  return platform
}
