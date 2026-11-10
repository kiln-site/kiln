import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { Brick } from "@workspace/contracts"
import { CircleAlert } from "lucide-react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

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

const NO_RELAY_OPTION_VALUE = "__no-relay-option__"

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
  const compatibleRelays = relays.filter((relay) =>
    relaySupportsBrick(relay, brick)
  )
  const selected = relays.find((relay) => relay.id === value)

  return (
    <>
      <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
        <span>Relay</span>
        <Select
          value={value}
          onValueChange={(next) => {
            if (next !== NO_RELAY_OPTION_VALUE) onChange(next)
          }}
          disabled={disabled}
          required
        >
          <SelectTrigger className="h-8 w-full [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:flex-1 [&_[data-slot=select-value]]:overflow-hidden [&_[data-slot=select-value]]:text-left [&_[data-slot=select-value]]:text-ellipsis [&_[data-slot=select-value]]:whitespace-nowrap">
            <SelectValue
              placeholder={
                relays.length === 0
                  ? "No Relays available"
                  : compatibleRelays.length === 0
                    ? "No compatible Relays"
                    : "Select a Relay"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {relays.length === 0 ? (
              <SelectItem value={NO_RELAY_OPTION_VALUE} disabled>
                No Relays available
              </SelectItem>
            ) : (
              <>
                {compatibleRelays.length === 0 ? (
                  <SelectItem value={NO_RELAY_OPTION_VALUE} disabled>
                    No compatible Relays
                  </SelectItem>
                ) : null}
                {relays.map((relay) => {
                  const supported = relaySupportsBrick(relay, brick)
                  return (
                    <SelectItem
                      key={relay.id}
                      value={relay.id}
                      disabled={!supported}
                    >
                      {relay.name}
                      {supported
                        ? ""
                        : ` — incompatible (${displayArchitecture(relay.nodeArch)})`}
                    </SelectItem>
                  )
                })}
              </>
            )}
          </SelectContent>
        </Select>
      </label>

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
