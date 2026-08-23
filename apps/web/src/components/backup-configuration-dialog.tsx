import * as React from "react"
import {
  Archive,
  Check,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

import { timestampedBackupName } from "@/lib/backup-name"

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
  initialTargetKey,
  onOpenChange,
  onSubmit,
  open,
  pending = false,
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
  initialTargetKey?: string
  onOpenChange: (open: boolean) => void
  onSubmit: (configuration: BackupConfiguration) => void
  open: boolean
  pending?: boolean
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
            <label className="block">
              <span className="mb-2 block text-xs font-medium">Target</span>
              <Select
                disabled={targets.length === 0}
                value={targetKeyValue}
                onValueChange={setTargetKeyValue}
              >
                <SelectTrigger
                  aria-label="Backup target"
                  className="h-8 w-full [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:flex-1 [&_[data-slot=select-value]]:truncate [&_[data-slot=select-value]]:text-left"
                >
                  <SelectValue placeholder="No targets available" />
                </SelectTrigger>
                <SelectContent className="w-max max-w-[calc(100vw-2rem)] min-w-(--radix-select-trigger-width)">
                  {targets.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      {targetKindLabel(option.kind)} · {option.name} ·{" "}
                      {option.relayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
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
            disabled={pending || !name.trim() || (showTarget && !target)}
            type="button"
            onClick={() =>
              onSubmit({
                destinationKeys: destinationKeysInUse,
                mode: effectiveMode,
                name: name.trim(),
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
              ? "Platform bundles can use Relay-local and platform-owned S3 destinations."
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
            ? "border-primary/30 bg-primary/10 text-primary"
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

function targetKindLabel(kind: BackupConfigurationTarget["kind"]): string {
  if (kind === "instance") return "Server"
  if (kind === "database") return "Database"
  return "Relay"
}
