import * as React from "react"
import {
  Archive,
  Check,
  ChevronsUpDown,
  Cloud,
  CloudCog,
  HardDrive,
  LoaderCircle,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"

import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import {
  InstancePickerContent,
  type InstancePickerItem,
} from "@/components/instance-picker"
import { InstanceCard } from "@/components/instance-card"
import { timestampedBackupName } from "@/lib/backup-name"
import type { ScheduleBackupRetention } from "@workspace/contracts/schedules"

export interface BackupConfigurationTarget {
  id: string
  key: string
  kind: "database" | "instance" | "platform"
  name: string
  relayId: string
  relayName: string
}

export interface BackupConfiguration {
  destinationKeys: ReadonlyArray<string>
  mode: "full" | "incremental"
  name: string
  /** With `showRetention`: how long a schedule keeps these backups. */
  retention?: ScheduleBackupRetention
  targetKey?: string
}

interface BackupStorageOption {
  deleting: boolean
  enabled: boolean
  id: string
  name: string
  ownerUserId: string | null
}

export function BackupConfigurationDialog({
  allowDefaultDestination = true,
  allowIncremental,
  description = "Relay runs this job in its single durable queue. Servers remain online while their data is archived.",
  error,
  initialDestinationKeys,
  initialMode = "incremental",
  initialName,
  initialRetention,
  initialTargetKey,
  onOpenChange,
  onSubmit,
  open,
  pending = false,
  showRetention = false,
  showTarget = true,
  singleDestination = false,
  storage,
  submitLabel,
  targets,
  title,
}: {
  allowDefaultDestination?: boolean
  allowIncremental?: boolean
  description?: React.ReactNode
  error?: string
  initialDestinationKeys?: ReadonlyArray<string>
  initialMode?: "full" | "incremental"
  initialName?: string
  initialRetention?: ScheduleBackupRetention
  initialTargetKey?: string
  onOpenChange: (open: boolean) => void
  onSubmit: (configuration: BackupConfiguration) => void
  open: boolean
  pending?: boolean
  // For a schedule's backups: how many days, and how much, it keeps.
  showRetention?: boolean
  showTarget?: boolean
  singleDestination?: boolean
  storage: ReadonlyArray<BackupStorageOption>
  submitLabel?: string
  targets: ReadonlyArray<BackupConfigurationTarget>
  title: string
}) {
  const [name, setName] = React.useState(
    () => initialName ?? timestampedBackupName("manual")
  )
  const [targetKeyValue, setTargetKeyValue] = React.useState(
    () =>
      targets.find((target) => target.key === initialTargetKey)?.key ??
      targets.at(0)?.key ??
      ""
  )
  const [destinationKeys, setDestinationKeys] = React.useState<Array<string>>(
    () => [
      ...(initialDestinationKeys ?? [
        allowDefaultDestination ? "default" : "local",
      ]),
    ]
  )
  const [mode, setMode] = React.useState<"full" | "incremental">(initialMode)
  const [retentionDays, setRetentionDays] = React.useState(() =>
    retentionInput(initialRetention?.days ?? null)
  )
  const [retentionGiB, setRetentionGiB] = React.useState(() =>
    retentionInput(bytesToGiB(initialRetention?.bytes ?? null))
  )
  const retention = showRetention
    ? parseRetention(retentionDays, retentionGiB)
    : undefined
  const target = showTarget
    ? targets.find((candidate) => candidate.key === targetKeyValue)
    : undefined
  const incrementalAllowed = showTarget
    ? target?.kind === "instance"
    : (allowIncremental ?? false)
  const effectiveMode =
    mode === "incremental" && incrementalAllowed ? "incremental" : "full"
  const availableStorage = React.useMemo(
    () =>
      storage.filter(
        (destination) =>
          destination.enabled &&
          !destination.deleting &&
          (target?.kind !== "platform" || destination.ownerUserId === null)
      ),
    [storage, target?.kind]
  )
  const destinationKeysInUse = React.useMemo(() => {
    const fallbackDestination = allowDefaultDestination ? "default" : "local"
    const allowed = new Set([
      ...(allowDefaultDestination ? ["default"] : []),
      "local",
      ...availableStorage.map((destination) => destination.id),
    ])
    const next = destinationKeys.filter((destination) =>
      allowed.has(destination)
    )
    const usable = next.length > 0 ? next : [fallbackDestination]
    return effectiveMode === "incremental" || singleDestination
      ? [usable[0] ?? fallbackDestination]
      : usable
  }, [
    allowDefaultDestination,
    availableStorage,
    destinationKeys,
    effectiveMode,
    singleDestination,
  ])
  const selectedDestinations = React.useMemo(
    () => new Set(destinationKeysInUse),
    [destinationKeysInUse]
  )
  const showMode = showTarget ? target?.kind === "instance" : true

  const resetConfiguration = () => {
    setName(initialName ?? timestampedBackupName("manual"))
    setTargetKeyValue(
      targets.find((candidate) => candidate.key === initialTargetKey)?.key ??
        targets.at(0)?.key ??
        ""
    )
    setDestinationKeys([
      ...(initialDestinationKeys ?? [
        allowDefaultDestination ? "default" : "local",
      ]),
    ])
    setMode(initialMode)
    setRetentionDays(retentionInput(initialRetention?.days ?? null))
    setRetentionGiB(retentionInput(bytesToGiB(initialRetention?.bytes ?? null)))
  }

  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) resetConfiguration()
    onOpenChange(nextOpen)
  }

  const toggleDestination = (destination: string, checked: boolean) => {
    setDestinationKeys((current) => {
      if (effectiveMode === "incremental" || singleDestination) {
        if (!checked) {
          return [allowDefaultDestination ? "default" : "local"]
        }
        return [destination]
      }
      if (destination === "default") {
        return checked ? ["default"] : ["local"]
      }
      const withoutDefault = current.filter((key) => key !== "default")
      const next = checked
        ? [...new Set([...withoutDefault, destination])]
        : withoutDefault.filter((key) => key !== destination)
      return next.length > 0
        ? next
        : [allowDefaultDestination ? "default" : "local"]
    })
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block">
            <span className="mb-2 block text-xs font-medium">Name</span>
            <Input
              autoFocus
              aria-label="Backup name"
              autoComplete="off"
              data-1p-ignore
              data-bwignore
              data-lpignore="true"
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          {showTarget ? (
            <div>
              <span className="mb-2 block text-xs font-medium">Target</span>
              <BackupTargetPicker
                selected={target}
                targets={targets}
                onSelect={setTargetKeyValue}
              />
            </div>
          ) : null}
          {showMode ? (
            <BackupModeChoices
              effectiveMode={effectiveMode}
              incrementalAllowed={incrementalAllowed}
              onModeChange={setMode}
            />
          ) : null}
          <BackupDestinationChoices
            allowDefaultDestination={allowDefaultDestination}
            availableStorage={availableStorage}
            effectiveMode={effectiveMode}
            selectedDestinations={selectedDestinations}
            singleDestination={singleDestination}
            targetKind={target?.kind}
            onToggleDestination={toggleDestination}
          />
          {showRetention ? (
            <fieldset>
              <legend className="mb-2 text-xs font-medium">Keep</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <RetentionField
                  label="Days"
                  placeholder="Forever"
                  value={retentionDays}
                  onChange={setRetentionDays}
                />
                <RetentionField
                  label="GiB in all"
                  placeholder="No limit"
                  step="any"
                  value={retentionGiB}
                  onChange={setRetentionGiB}
                />
              </div>
              <span
                className={
                  retention === null
                    ? "type-meta mt-1.5 block text-destructive"
                    : "type-meta mt-1.5 block text-muted-foreground"
                }
              >
                {retention === null
                  ? "Use whole days, and a size above zero."
                  : "Older backups past either limit are deleted, oldest first. The newest is always kept."}
              </span>
            </fieldset>
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            type="button"
            onClick={() => changeOpen(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={
              pending ||
              !name.trim() ||
              (showTarget && !target) ||
              retention === null
            }
            type="button"
            onClick={() =>
              onSubmit({
                destinationKeys: destinationKeysInUse,
                mode: effectiveMode,
                name: name.trim(),
                ...(retention ? { retention } : {}),
                ...(showTarget && targetKeyValue
                  ? { targetKey: targetKeyValue }
                  : {}),
              })
            }
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <Archive />}
            {submitLabel ?? "Create backup"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RetentionField({
  label,
  onChange,
  placeholder,
  step = "1",
  value,
}: {
  label: string
  onChange: (value: string) => void
  placeholder: string
  step?: string
  value: string
}) {
  return (
    <label className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/35 px-3 py-2">
      <Input
        aria-label={`Keep, in ${label.toLowerCase()}`}
        className="h-7 w-20 tabular-nums"
        inputMode="decimal"
        min="0"
        placeholder={placeholder}
        step={step}
        type="number"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <span className="text-xs text-muted-foreground">{label}</span>
    </label>
  )
}

const GIB = 1024 ** 3

function retentionInput(value: number | null): string {
  return value === null ? "" : String(value)
}

function bytesToGiB(bytes: number | null): number | null {
  return bytes === null ? null : Math.round((bytes / GIB) * 100) / 100
}

// Blank keeps forever; null when either isn't a usable limit.
function parseRetention(
  days: string,
  gibibytes: string
): ScheduleBackupRetention | null {
  const keepDays = days.trim() === "" ? null : Number(days)
  const keepGiB = gibibytes.trim() === "" ? null : Number(gibibytes)
  if (
    (keepDays !== null && (!Number.isSafeInteger(keepDays) || keepDays < 1)) ||
    (keepGiB !== null && (!Number.isFinite(keepGiB) || keepGiB <= 0))
  ) {
    return null
  }
  return {
    bytes: keepGiB === null ? null : Math.max(1, Math.round(keepGiB * GIB)),
    days: keepDays,
  }
}

function BackupModeChoices({
  effectiveMode,
  incrementalAllowed,
  onModeChange,
}: {
  effectiveMode: "full" | "incremental"
  incrementalAllowed: boolean
  onModeChange: (mode: "full" | "incremental") => void
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium">Mode</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <BackupDestinationChoice
          checked={effectiveMode === "incremental"}
          description="Deduplicated snapshots on this Relay or S3"
          disabled={!incrementalAllowed}
          icon={Archive}
          label="Incremental"
          onCheckedChange={(checked) => {
            if (checked && incrementalAllowed) onModeChange("incremental")
          }}
        />
        <BackupDestinationChoice
          checked={effectiveMode === "full"}
          description="Portable zip archive"
          icon={HardDrive}
          label="Full archive"
          onCheckedChange={(checked) => {
            if (checked) onModeChange("full")
          }}
        />
      </div>
    </fieldset>
  )
}

function BackupDestinationChoices({
  allowDefaultDestination,
  availableStorage,
  effectiveMode,
  onToggleDestination,
  selectedDestinations,
  singleDestination,
  targetKind,
}: {
  allowDefaultDestination: boolean
  availableStorage: ReadonlyArray<BackupStorageOption>
  effectiveMode: "full" | "incremental"
  onToggleDestination: (destination: string, checked: boolean) => void
  selectedDestinations: ReadonlySet<string>
  singleDestination: boolean
  targetKind?: BackupConfigurationTarget["kind"]
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium">Destinations</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {allowDefaultDestination ? (
          <BackupDestinationChoice
            checked={selectedDestinations.has("default")}
            description="Use the target’s preferred destination"
            icon={CloudCog}
            label="Default"
            onCheckedChange={(checked) =>
              onToggleDestination("default", checked)
            }
          />
        ) : null}
        <BackupDestinationChoice
          checked={selectedDestinations.has("local")}
          description="Keep a copy on this Relay"
          icon={HardDrive}
          label="Local"
          onCheckedChange={(checked) => onToggleDestination("local", checked)}
        />
        {availableStorage.map((destination) => (
          <BackupDestinationChoice
            key={destination.id}
            checked={selectedDestinations.has(destination.id)}
            description={destination.name}
            icon={Cloud}
            label="S3"
            onCheckedChange={(checked) =>
              onToggleDestination(destination.id, checked)
            }
          />
        ))}
      </div>
      <span className="type-meta mt-1.5 block text-muted-foreground">
        {effectiveMode === "incremental"
          ? "Choose one destination. Incremental snapshots can stay on this Relay or use S3."
          : singleDestination
            ? "Choose one destination. Full archives can stay on this Relay or use S3."
            : targetKind === "platform"
              ? "Kiln's backups can stay on this Relay or use platform-owned S3."
              : targetKind === "instance"
                ? "Choose one or more copies. Default uses this server’s preferred destination."
                : "Choose one or more copies. Default uses Relay-local storage."}
      </span>
    </fieldset>
  )
}

function BackupDestinationChoice({
  checked,
  description,
  disabled = false,
  icon: Icon,
  label,
  onCheckedChange,
}: {
  checked: boolean
  description: string
  disabled?: boolean
  icon: typeof Cloud
  label: string
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label
      className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      } ${
        checked
          ? "border-primary/45 bg-primary/5"
          : "border-border/80 hover:bg-muted/25"
      }`}
    >
      <input
        checked={checked}
        className="sr-only"
        disabled={disabled}
        type="checkbox"
        onChange={(event) => onCheckedChange(event.currentTarget.checked)}
      />
      <span
        className={`grid size-8 shrink-0 place-items-center rounded-md border ${
          checked
            ? "border-primary/30 bg-primary/10 text-primary-ink"
            : "text-muted-foreground"
        }`}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold">{label}</span>
        <span className="type-meta block truncate text-muted-foreground">
          {description}
        </span>
      </span>
      <span
        className={`grid size-4 place-items-center rounded-sm border ${
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input"
        }`}
      >
        {checked ? <Check className="size-3" /> : null}
      </span>
    </label>
  )
}

const BackupTargetPicker = React.memo(function BackupTargetPicker({
  onSelect,
  selected,
  targets,
}: {
  onSelect: (key: string) => void
  selected: BackupConfigurationTarget | undefined
  targets: ReadonlyArray<BackupConfigurationTarget>
}) {
  const [open, setOpen] = React.useState(false)
  const items = React.useMemo(() => targets.map(backupTargetItem), [targets])
  const selectedItem = React.useMemo(
    () => (selected ? backupTargetItem(selected) : null),
    [selected]
  )
  const selectedKeys = React.useMemo(
    () => new Set(selected ? [selected.key] : []),
    [selected]
  )
  const selectItem = React.useCallback(
    (item: InstancePickerItem) => {
      onSelect(item.key)
      setOpen(false)
    },
    [onSelect]
  )

  return (
    <DrawerPopover open={open} onOpenChange={setOpen}>
      <DrawerPopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Backup target"
          disabled={targets.length === 0}
          className="h-auto min-h-10 w-full justify-between gap-3 px-2 py-1.5 font-normal"
        >
          {selectedItem ? (
            <InstanceCard
              className="min-w-0 flex-1 gap-2 text-left"
              iconClassName="size-7 border-0 bg-muted/55"
              instance={selectedItem.identity}
              meta={selectedItem.meta}
              metaClassName="font-mono"
              name={selectedItem.name}
              nameClassName="type-control-sm"
              statusClassName="ring-background"
            />
          ) : (
            <span className="px-1 text-muted-foreground">
              No targets available
            </span>
          )}
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DrawerPopoverTrigger>
      <DrawerPopoverContent
        title="Backup targets"
        align="start"
        className="z-[70] w-(--radix-popover-trigger-width) min-w-72 overflow-hidden p-0"
      >
        <InstancePickerContent
          ariaLabel="Backup targets"
          emptyMessage="No targets available"
          items={items}
          selectedKeys={selectedKeys}
          onSelect={selectItem}
        />
      </DrawerPopoverContent>
    </DrawerPopover>
  )
})

function backupTargetItem(
  target: BackupConfigurationTarget
): InstancePickerItem {
  if (target.kind === "platform") {
    return {
      identity: {
        id: target.relayId,
        kind: "relay",
        platform: true,
        relayId: target.relayId,
        source: "fleet",
      },
      key: target.key,
      meta: `On ${target.relayName}`,
      name: "Kiln",
      searchText: `kiln hearth platform ${target.relayName} ${target.relayId}`,
    }
  }
  return {
    identity: {
      id: target.id,
      kind: target.kind === "instance" ? "server" : "database",
      relayId: target.relayId,
    },
    key: target.key,
    meta: `${target.relayName} · ${target.id.slice(0, 8)}`,
    name: target.name,
    searchText: `${target.id} ${target.relayName}`,
  }
}
