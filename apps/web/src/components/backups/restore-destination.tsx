import * as React from "react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

/** A resource a backup can be restored into. */
export interface RestoreDestination {
  id: string
  name: string
  relayId: string
  /** The Relay it's on, when that isn't the backup's. */
  relayName?: string | undefined
}

/**
 * Where a restore goes: the backup's own resource while it exists, or
 * another of its kind, as when its own is gone: on its Relay, or for a backup
 * kept in a bucket, on any. Starts on its own, else the first other one.
 */
export function useRestoreDestination(
  ownId: string,
  destinations: ReadonlyArray<RestoreDestination>
) {
  const [chosen, setChosen] = React.useState<string | null>(null)
  const ownExists = destinations.some((candidate) => candidate.id === ownId)
  const id =
    chosen && destinations.some((candidate) => candidate.id === chosen)
      ? chosen
      : ownExists
        ? ownId
        : (destinations[0]?.id ?? null)
  return {
    destination: destinations.find((candidate) => candidate.id === id) ?? null,
    elsewhere: id !== null && id !== ownId,
    ownExists,
    setDestination: setChosen,
  }
}

export const RestoreDestinationSelect = React.memo(
  function RestoreDestinationSelect({
    destinations,
    disabled,
    kindLabel,
    onChange,
    ownId,
    value,
  }: {
    destinations: ReadonlyArray<RestoreDestination>
    disabled?: boolean
    kindLabel: string
    onChange: (id: string) => void
    ownId: string
    value: string | null
  }) {
    return (
      <label className="grid gap-1.5">
        <span className="text-xs font-semibold">Restore to</span>
        <Select
          disabled={disabled || destinations.length === 0}
          value={value ?? undefined}
          onValueChange={onChange}
        >
          <SelectTrigger
            aria-label="Restore to"
            className="h-8 w-full [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate [&_[data-slot=select-value]]:text-left"
          >
            <SelectValue placeholder={`No ${kindLabel} to restore into`} />
          </SelectTrigger>
          <SelectContent>
            {destinations.map((destination) => (
              <SelectItem key={destination.id} value={destination.id}>
                {destination.id === ownId
                  ? `${destination.name} (backed up from)`
                  : destination.relayName
                    ? `${destination.name} on ${destination.relayName}`
                    : destination.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    )
  }
)
