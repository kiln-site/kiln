import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { Brick } from "@workspace/contracts"
import { CircleAlert } from "lucide-react"

import { InstanceCard } from "@/components/instance-card"
import { RelayKindIcon } from "@/components/instance-kind-icon"
import {
  InstancePickerContent,
  type InstancePickerItem,
} from "@/components/instance-picker"
import {
  InstancePickerField,
  PickerPlaceholder,
} from "@/components/instance-picker-field"
import { normalizeArchitecture } from "@/lib/architecture"
import { relayConnectionQueryOptions } from "@/lib/query-options"
import { selectRelayConnected } from "@/lib/relay-selectors"

// Which Relay an instance is created on, for any kind of Brick: the Relays
// someone may create it on, less those whose architecture the Brick doesn't
// run on.

export interface BrickRelayOption {
  id: string
  name: string
  /** Unknown for a Relay that hasn't said, which then suits every Brick. */
  nodeArch?: string | null
}

function relaySupportsBrick(
  relay: BrickRelayOption,
  brick: Brick | null
): boolean {
  if (!brick || !relay.nodeArch) return true
  const architectures = brick.metadata.platforms
  if (!architectures || architectures.length === 0) return true
  const relayArchitecture = normalizeArchitecture(relay.nodeArch)
  return architectures.some(
    (architecture) => normalizeArchitecture(architecture) === relayArchitecture
  )
}

function displayArchitecture(architecture: string | null | undefined): string {
  return architecture ? normalizeArchitecture(architecture) : "unknown"
}

/** Whether the chosen Relay can take the Brick right now. */
export function useBrickRelayReady(
  relays: ReadonlyArray<BrickRelayOption>,
  relayId: string,
  brick: Brick | null
): { compatible: boolean; connected: boolean } {
  const queryClient = useQueryClient()
  const selectConnected = React.useMemo(
    () => selectRelayConnected(relayId),
    [relayId]
  )
  const { data: connected = false } = useQuery({
    ...relayConnectionQueryOptions(queryClient),
    select: selectConnected,
  })
  const relay = relays.find((candidate) => candidate.id === relayId)
  return {
    compatible: relay !== undefined && relaySupportsBrick(relay, brick),
    connected,
  }
}

export const BrickRelayField = React.memo(function BrickRelayField({
  brick,
  disabled,
  onChange,
  relays,
  value,
}: {
  /** The Brick chosen, when one is. */
  brick: Brick | null
  disabled: boolean
  onChange: (relayId: string) => void
  relays: ReadonlyArray<BrickRelayOption>
  value: string
}) {
  const { compatible, connected } = useBrickRelayReady(relays, value, brick)
  const items = React.useMemo(
    () => relays.map((relay) => relayItem(relay, brick)),
    [brick, relays]
  )
  const selectedKeys = React.useMemo(
    () => new Set(value ? [value] : []),
    [value]
  )
  const selected = relays.find((relay) => relay.id === value)
  const anyCompatible = items.some((item) => !item.disabled)

  return (
    <>
      <InstancePickerField
        disabled={disabled}
        label="Relay"
        labelClassName="mb-1.5 block text-xs font-medium text-muted-foreground"
        title="Choose a Relay"
        value={
          selected ? (
            <InstanceCard
              className="min-w-0 flex-1 gap-2 text-left"
              iconClassName="size-7 border-0 bg-muted/55"
              instance={{
                id: selected.id,
                kind: "relay",
                relayId: selected.id,
              }}
              meta={relayMeta(selected, brick)}
              name={selected.name}
              nameClassName="type-control-sm"
              showFavorite={false}
            />
          ) : (
            <PickerPlaceholder
              icon={<RelayKindIcon className="size-3.5" />}
              meta={
                relays.length === 0
                  ? "You can't create this on any Relay"
                  : anyCompatible
                    ? "Where it runs"
                    : "None runs this Brick's architecture"
              }
              name={
                relays.length === 0 || !anyCompatible
                  ? "No Relay available"
                  : "Choose a Relay"
              }
            />
          )
        }
      >
        {(close) => (
          <InstancePickerContent
            ariaLabel="Relays"
            emptyMessage="No Relay you can create this on"
            favoritesFilter={false}
            filterBar={false}
            includeKindGroups={false}
            items={items}
            selectedKeys={selectedKeys}
            onSelect={(item) => {
              onChange(item.key)
              close()
            }}
          />
        )}
      </InstancePickerField>

      {compatible && !connected && value ? (
        <p className="text-xs leading-relaxed text-amber-300 light:text-amber-700">
          Selected Relay is not connected.
        </p>
      ) : null}

      {selected && !compatible ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/8 px-3 py-2 text-xs leading-relaxed text-amber-200 light:bg-amber-400/16 light:text-amber-800">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {selected.name} runs {displayArchitecture(selected.nodeArch)}, which
            this Brick does not support. Choose a compatible Relay to provision.
          </span>
        </div>
      ) : null}
    </>
  )
})

// A Relay that can't run the Brick stays listed, disabled, saying why.
function relayItem(
  relay: BrickRelayOption,
  brick: Brick | null
): InstancePickerItem {
  return {
    disabled: !relaySupportsBrick(relay, brick),
    identity: { id: relay.id, kind: "relay", relayId: relay.id },
    key: relay.id,
    meta: relayMeta(relay, brick),
    name: relay.name,
    searchText: relay.id,
  }
}

function relayMeta(relay: BrickRelayOption, brick: Brick | null): string {
  if (!relaySupportsBrick(relay, brick)) {
    return `Runs ${displayArchitecture(relay.nodeArch)}, which this Brick doesn't`
  }
  return relay.nodeArch
    ? `${relay.id} · ${normalizeArchitecture(relay.nodeArch)}`
    : relay.id
}
