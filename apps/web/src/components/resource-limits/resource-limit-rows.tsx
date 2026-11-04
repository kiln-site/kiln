import * as React from "react"
import {
  CPU_LIMIT_MILLIS_PER_CORE,
  type ResourceLimits,
} from "@workspace/contracts"

import {
  ResourceLimitSlider,
  type ResourceLimitUnit,
} from "@/components/resource-limits/resource-limit-slider"
import type {
  ResourceLimitDraft,
  ResourceLimitField,
  ResourceLimitsCapacity,
  ResourceLimitsDraft,
} from "@/lib/resource-limits"

const GIBIBYTE = 1024 ** 3

const MEMORY: ResourceLimitUnit = {
  fallbackMax: 16,
  label: "Memory",
  min: 0.25,
  scale: 1,
  spoken: "GiB",
  step: (value) => (value < 4 ? 0.25 : value < 16 ? 0.5 : 1),
  unit: "GiB",
}

const CPU: ResourceLimitUnit = {
  fallbackMax: 400,
  label: "CPU",
  min: 10,
  scale: 100,
  spoken: "percent",
  step: (value) => (value < 100 ? 5 : value < 400 ? 10 : 25),
  unit: "%",
}

const DISK: ResourceLimitUnit = {
  fallbackMax: 100,
  label: "Disk",
  min: 1,
  scale: 1,
  spoken: "GiB",
  step: (value) => (value < 100 ? 1 : value < 500 ? 5 : 25),
  unit: "GiB",
}

const ALL_FIELDS: ReadonlyArray<ResourceLimitField> = [
  "memoryGiB",
  "cpuCores",
  "diskGiB",
]

const gibibytes = (bytes: number | null | undefined) =>
  bytes === null || bytes === undefined ? null : bytes / GIBIBYTE

// The memory, CPU, and disk sliders every kind of instance is limited with.
// Anything that sets limits renders this; `fields` picks those that apply.
export const ResourceLimitRows = React.memo(function ResourceLimitRows({
  capacity,
  disabled,
  diskFloorBytes = null,
  draft,
  fields = ALL_FIELDS,
  invalid = null,
  loading = false,
  onChange,
  original,
}: {
  capacity: ResourceLimitsCapacity | null
  disabled: boolean
  /** What a disk limit can't go under, such as the files already there. */
  diskFloorBytes?: number | null
  draft: ResourceLimitsDraft
  fields?: ReadonlyArray<ResourceLimitField>
  /** The limit to flag, as the one that can't be saved. */
  invalid?: ResourceLimitField | null
  /** Whether `capacity` is on its way. */
  loading?: boolean
  onChange: React.Dispatch<React.SetStateAction<ResourceLimitsDraft>>
  /** The saved limits, marked on each slider and offered back when changed. */
  original: ResourceLimits
}) {
  const set = React.useMemo(() => {
    const field = (key: ResourceLimitField) => (value: ResourceLimitDraft) =>
      onChange((current) => ({ ...current, [key]: value }))
    return {
      cpuCores: field("cpuCores"),
      diskGiB: field("diskGiB"),
      memoryGiB: field("memoryGiB"),
    }
  }, [onChange])
  const shared = { disabled, loading }
  return (
    <div className="grid gap-y-3">
      {fields.includes("memoryGiB") ? (
        <ResourceLimitSlider
          {...shared}
          assignable={gibibytes(capacity?.assignableMemoryBytes)}
          below={null}
          invalid={invalid === "memoryGiB"}
          original={gibibytes(original.memoryBytes)}
          unit={MEMORY}
          value={draft.memoryGiB}
          onChange={set.memoryGiB}
        />
      ) : null}
      {fields.includes("cpuCores") ? (
        <ResourceLimitSlider
          {...shared}
          assignable={capacity ? capacity.cores * CPU.scale : null}
          below={null}
          invalid={invalid === "cpuCores"}
          original={
            original.cpuMillis === null
              ? null
              : (original.cpuMillis / CPU_LIMIT_MILLIS_PER_CORE) * CPU.scale
          }
          unit={CPU}
          value={draft.cpuCores}
          onChange={set.cpuCores}
        />
      ) : null}
      {fields.includes("diskGiB") ? (
        <ResourceLimitSlider
          {...shared}
          assignable={gibibytes(capacity?.assignableDiskBytes)}
          below={gibibytes(diskFloorBytes)}
          invalid={invalid === "diskGiB"}
          original={gibibytes(original.diskBytes)}
          unit={DISK}
          value={draft.diskGiB}
          onChange={set.diskGiB}
        />
      ) : null}
    </div>
  )
})
