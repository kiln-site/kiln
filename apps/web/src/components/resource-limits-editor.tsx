import * as React from "react"
import { Cpu, HardDrive, MemoryStick } from "lucide-react"

import { Input } from "@workspace/ui/components/input"
import { Switch } from "@workspace/ui/components/switch"

import { formatBytes } from "@/lib/format-bytes"
import type {
  ResourceLimitDraft,
  ResourceLimitsCapacity,
  ResourceLimitsDraft,
} from "@/lib/resource-limits"

const GIBIBYTE = 1024 ** 3

// Memory, CPU, and disk limits for any instance, each of which can be
// turned off. Limits apply to one container.
export const ResourceLimitsEditor = React.memo(function ResourceLimitsEditor({
  capacity,
  disabled,
  draft,
  onChange,
}: {
  capacity: ResourceLimitsCapacity | null
  disabled: boolean
  draft: ResourceLimitsDraft
  onChange: (draft: ResourceLimitsDraft) => void
}) {
  return (
    <div className="grid divide-y divide-border/65 overflow-hidden rounded-xl border border-border/75 bg-background/45 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      <ResourceLimitField
        assignable={
          capacity
            ? `${formatBytes(capacity.memory.availableBytes)} assignable`
            : null
        }
        disabled={disabled}
        icon={<MemoryStick className="size-3.5" />}
        label="Memory"
        max={capacity ? capacity.memory.availableBytes / GIBIBYTE : undefined}
        min={0.0625}
        unit="GiB"
        usage={
          capacity && (
            <NodeCapacityBar
              totalLabel={`${formatBytes(capacity.memory.nodeTotalBytes)} total`}
              usedLabel={`${formatBytes(capacity.memory.nodeUsedBytes)} node used`}
              usedPercent={percent(
                capacity.memory.nodeUsedBytes,
                capacity.memory.nodeTotalBytes
              )}
            />
          )
        }
        value={draft.memoryGiB}
        onChange={(memoryGiB) => onChange({ ...draft, memoryGiB })}
      />
      <ResourceLimitField
        assignable={
          capacity
            ? `${capacity.cpu.nodeCores} ${capacity.cpu.nodeCores === 1 ? "core" : "cores"} on node`
            : null
        }
        disabled={disabled}
        icon={<Cpu className="size-3.5" />}
        label="CPU"
        max={capacity?.cpu.nodeCores}
        min={0.1}
        unit="cores"
        usage={null}
        value={draft.cpuCores}
        onChange={(cpuCores) => onChange({ ...draft, cpuCores })}
      />
      <ResourceLimitField
        assignable={
          capacity
            ? `${formatBytes(capacity.storage.availableBytes)} assignable`
            : null
        }
        disabled={disabled}
        icon={<HardDrive className="size-3.5" />}
        label="Disk"
        max={capacity ? capacity.storage.availableBytes / GIBIBYTE : undefined}
        min={0.1}
        unit="GiB"
        usage={
          capacity && (
            <NodeCapacityBar
              totalLabel={`${formatBytes(capacity.storage.nodeTotalBytes)} total`}
              usedLabel={`${formatBytes(capacity.storage.nodeUsedBytes)} node used`}
              usedPercent={percent(
                capacity.storage.nodeUsedBytes,
                capacity.storage.nodeTotalBytes
              )}
            />
          )
        }
        value={draft.diskGiB}
        onChange={(diskGiB) => onChange({ ...draft, diskGiB })}
      />
    </div>
  )
})

function ResourceLimitField({
  assignable,
  disabled,
  icon,
  label,
  max,
  min,
  unit,
  usage,
  value,
  onChange,
}: {
  assignable: string | null
  disabled: boolean
  icon: React.ReactNode
  label: string
  max: number | undefined
  min: number
  unit: string
  usage: React.ReactNode
  value: ResourceLimitDraft
  onChange: (value: ResourceLimitDraft) => void
}) {
  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="type-technical-label flex items-center gap-2 text-muted-foreground">
          {icon}
          {label}
        </span>
        <label className="type-meta flex items-center gap-2 text-muted-foreground">
          No limit
          <Switch
            aria-label={`No ${label.toLowerCase()} limit`}
            checked={!value.limited}
            disabled={disabled}
            onCheckedChange={(unlimited) =>
              onChange({ ...value, limited: !unlimited })
            }
          />
        </label>
      </div>
      {value.limited ? (
        <div className="flex items-center gap-2">
          <Input
            aria-label={`${label} limit in ${unit}`}
            className="font-mono tabular-nums"
            disabled={disabled}
            max={max}
            min={min}
            // Any value: the editor checks limits itself, and a step would
            // make the browser refuse ones like 0.5 GiB.
            step="any"
            type="number"
            value={value.value}
            onChange={(event) =>
              onChange({ limited: true, value: event.target.value })
            }
          />
          <span className="type-code text-muted-foreground">{unit}</span>
        </div>
      ) : (
        <p className="flex h-9 items-center font-mono text-lg font-semibold tracking-[-0.04em] text-foreground">
          No limit
        </p>
      )}
      {assignable && (
        <span className="type-meta font-mono text-muted-foreground tabular-nums">
          {assignable}
        </span>
      )}
      {usage}
    </div>
  )
}

function NodeCapacityBar({
  totalLabel,
  usedLabel,
  usedPercent,
}: {
  totalLabel: string
  usedLabel: string
  usedPercent: number
}) {
  return (
    <div>
      <div className="h-1 overflow-hidden bg-muted/60">
        <div
          className="h-full bg-primary/55"
          style={{ width: `${usedPercent}%` }}
        />
      </div>
      <div className="type-meta mt-1 flex justify-between font-mono text-muted-foreground tabular-nums">
        <span>{usedLabel}</span>
        <span>{totalLabel}</span>
      </div>
    </div>
  )
}

function percent(used: number, total: number): number {
  return total > 0 ? Math.min((used / total) * 100, 100) : 0
}
