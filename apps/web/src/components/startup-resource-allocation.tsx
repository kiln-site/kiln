import * as React from "react"
import { HardDrive, MemoryStick } from "lucide-react"

import { Input } from "@workspace/ui/components/input"

export type StartupResourceAllocation = {
  memory: ResourceCapacity
  storage: ResourceCapacity
}

type ResourceCapacity = {
  availableBytes: number
  nodeTotalBytes: number
  nodeUsedBytes: number
}

export const ResourceAllocationCard = React.memo(
  function ResourceAllocationCard({
    allocation,
    configuredMemoryBytes,
    diskLimitGiB,
    disabled,
    memoryMaxLength,
    memoryPattern,
    memoryRequired,
    memoryValue,
    onDiskLimitChange,
    onMemoryChange,
  }: {
    allocation: StartupResourceAllocation
    configuredMemoryBytes: number
    diskLimitGiB: string
    disabled: boolean
    memoryMaxLength?: number
    memoryPattern?: string
    memoryRequired?: boolean
    memoryValue?: string
    onDiskLimitChange: (value: string) => void
    onMemoryChange?: (value: string) => void
  }) {
    return (
      <div className="grid divide-y divide-border/65 overflow-hidden rounded-xl border border-border/75 bg-background/45 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <ResourceAllocationPanel
          icon={<MemoryStick className="size-3.5" />}
          label="Memory"
          value={formatResourceBytes(configuredMemoryBytes)}
          availableBytes={allocation.memory.availableBytes}
          nodeUsedBytes={allocation.memory.nodeUsedBytes}
          nodeTotalBytes={allocation.memory.nodeTotalBytes}
          warning={configuredMemoryBytes > allocation.memory.availableBytes}
          input={
            memoryValue !== undefined && onMemoryChange ? (
              <Input
                aria-label="Memory limit"
                value={memoryValue}
                disabled={disabled}
                pattern={memoryPattern}
                maxLength={memoryMaxLength}
                required={memoryRequired}
                onBlur={(event) => onMemoryChange(event.currentTarget.value)}
                onChange={(event) => onMemoryChange(event.target.value)}
                className="font-mono tabular-nums"
              />
            ) : null
          }
        />
        <div className="p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="type-technical-label flex items-center gap-2 text-muted-foreground">
              <HardDrive className="size-3.5" />
              Disk quota
            </span>
            <span className="type-meta font-mono text-muted-foreground">
              {formatResourceBytes(allocation.storage.availableBytes)}{" "}
              assignable
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Input
              aria-label="Disk quota in GiB"
              type="number"
              min={0.1}
              max={bytesToGiB(allocation.storage.availableBytes)}
              step={0.1}
              value={diskLimitGiB}
              disabled={disabled}
              onBlur={(event) => onDiskLimitChange(event.currentTarget.value)}
              onChange={(event) => onDiskLimitChange(event.target.value)}
              className="font-mono tabular-nums"
            />
            <span className="type-code text-muted-foreground">GiB</span>
          </div>
          <NodeCapacityBar
            usedBytes={allocation.storage.nodeUsedBytes}
            totalBytes={allocation.storage.nodeTotalBytes}
          />
        </div>
      </div>
    )
  }
)

function ResourceAllocationPanel({
  icon,
  label,
  value,
  availableBytes,
  nodeUsedBytes,
  nodeTotalBytes,
  warning,
  input,
}: {
  icon: React.ReactNode
  label: string
  value: string
  availableBytes: number
  nodeUsedBytes: number
  nodeTotalBytes: number
  warning: boolean
  input: React.ReactNode
}) {
  return (
    <div className="p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="type-technical-label flex items-center gap-2 text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className="type-meta font-mono text-muted-foreground">
          {formatResourceBytes(availableBytes)} assignable
        </span>
      </div>
      {input ? (
        <div className={warning ? "mt-2 [&_input]:text-destructive" : "mt-2"}>
          {input}
        </div>
      ) : (
        <p
          className={`mt-2 font-mono text-lg font-semibold tracking-[-0.04em] tabular-nums ${warning ? "text-destructive" : "text-foreground"}`}
        >
          {value}
        </p>
      )}
      <NodeCapacityBar usedBytes={nodeUsedBytes} totalBytes={nodeTotalBytes} />
    </div>
  )
}

function NodeCapacityBar({
  usedBytes,
  totalBytes,
}: {
  usedBytes: number
  totalBytes: number
}) {
  const percent =
    totalBytes > 0 ? Math.min((usedBytes / totalBytes) * 100, 100) : 0
  return (
    <div className="mt-2">
      <div className="h-1 overflow-hidden bg-muted/60">
        <div
          className="h-full bg-primary/55"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="type-meta mt-1 flex justify-between font-mono text-muted-foreground tabular-nums">
        <span>{formatResourceBytes(usedBytes)} node used</span>
        <span>{formatResourceBytes(totalBytes)} total</span>
      </div>
    </div>
  )
}

function bytesToGiB(bytes: number): number {
  return bytes / 1024 ** 3
}

export function formatResourceBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  )
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}
