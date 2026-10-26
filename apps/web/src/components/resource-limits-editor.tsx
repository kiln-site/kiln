import * as React from "react"
import { Cpu, HardDrive, MemoryStick } from "lucide-react"

import { Input } from "@workspace/ui/components/input"
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"

import { formatBytes } from "@/lib/format-bytes"
import type {
  ResourceLimitDraft,
  ResourceLimitsCapacity,
  ResourceLimitsDraft,
} from "@/lib/resource-limits"

const GIBIBYTE = 1024 ** 3

export type ResourceLimitKind = "cpu" | "disk" | "memory"

const allFields: ReadonlyArray<ResourceLimitKind> = ["memory", "cpu", "disk"]

const columns = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
} as const

// Memory, CPU, and disk limits for any instance, each of which can be
// turned off. Limits apply to one container; `fields` picks those that
// apply, as an app's services take memory and CPU and the app its disk.
// A field's note, such as why its limit won't fit, takes the place of what
// the node can assign, so the editor keeps its size. `compact` leaves out
// the node's usage, for a dialog.
export const ResourceLimitsEditor = React.memo(function ResourceLimitsEditor({
  capacity,
  compact = false,
  disabled,
  draft,
  fields = allFields,
  notes,
  onChange,
}: {
  capacity: ResourceLimitsCapacity | null
  compact?: boolean
  disabled: boolean
  draft: ResourceLimitsDraft
  fields?: ReadonlyArray<ResourceLimitKind>
  notes?: Partial<Record<ResourceLimitKind, React.ReactNode>>
  onChange: (draft: ResourceLimitsDraft) => void
}) {
  const shown = new Set(fields)
  const usage = (node: React.ReactNode) => (compact ? null : node)
  return (
    <div
      className={`grid divide-y divide-border/65 overflow-hidden rounded-xl border border-border/75 bg-background/45 sm:divide-x sm:divide-y-0 ${columns[Math.max(1, Math.min(fields.length, 3)) as 1 | 2 | 3]}`}
    >
      {shown.has("memory") ? (
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
          note={notes?.memory}
          min={0.0625}
          unit="GiB"
          compact={compact}
          usage={usage(
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
          )}
          value={draft.memoryGiB}
          onChange={(memoryGiB) => onChange({ ...draft, memoryGiB })}
        />
      ) : null}
      {shown.has("cpu") ? (
        <ResourceLimitField
          assignable={
            capacity
              ? `${capacity.cpu.nodeCores} ${capacity.cpu.nodeCores === 1 ? "core" : "cores"} on node`
              : null
          }
          disabled={disabled}
          icon={<Cpu className="size-3.5" />}
          compact={compact}
          label="CPU"
          max={capacity?.cpu.nodeCores}
          note={notes?.cpu}
          min={0.1}
          unit="cores"
          usage={null}
          value={draft.cpuCores}
          onChange={(cpuCores) => onChange({ ...draft, cpuCores })}
        />
      ) : null}
      {shown.has("disk") ? (
        <ResourceLimitField
          assignable={
            capacity
              ? `${formatBytes(capacity.storage.availableBytes)} assignable`
              : null
          }
          disabled={disabled}
          icon={<HardDrive className="size-3.5" />}
          label="Disk"
          max={
            capacity ? capacity.storage.availableBytes / GIBIBYTE : undefined
          }
          note={notes?.disk}
          min={0.1}
          unit="GiB"
          compact={compact}
          usage={usage(
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
          )}
          value={draft.diskGiB}
          onChange={(diskGiB) => onChange({ ...draft, diskGiB })}
        />
      ) : null}
    </div>
  )
})

function ResourceLimitField({
  assignable,
  compact = false,
  disabled,
  icon,
  label,
  max,
  min,
  note,
  unit,
  usage,
  value,
  onChange,
}: {
  assignable: string | null
  compact?: boolean
  disabled: boolean
  icon: React.ReactNode
  label: string
  max: number | undefined
  min: number
  note: React.ReactNode
  unit: string
  usage: React.ReactNode
  value: ResourceLimitDraft
  onChange: (value: ResourceLimitDraft) => void
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", compact ? "p-3" : "p-4")}>
      <div className="flex items-center justify-between gap-3">
        <span className="type-technical-label flex items-center gap-2 text-muted-foreground">
          {icon}
          {label}
        </span>
        <label className="type-meta flex shrink-0 items-center gap-2 whitespace-nowrap text-muted-foreground">
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
        <p
          className={cn(
            "flex h-9 items-center font-mono font-semibold tracking-[-0.04em] text-foreground",
            compact ? "text-sm" : "text-lg"
          )}
        >
          No limit
        </p>
      )}
      {note ? (
        <span className="type-meta flex min-w-0 items-center gap-1.5">
          {note}
        </span>
      ) : assignable || compact ? (
        // Compact, the line stays without a node to describe, so the
        // editor keeps its height.
        <span className="type-meta min-h-[1lh] font-mono text-muted-foreground tabular-nums">
          {assignable}
        </span>
      ) : null}
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
