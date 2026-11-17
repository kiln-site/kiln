import * as React from "react"
import {
  Archive,
  Check,
  Cloud,
  CirclePause,
  HardDrive,
  LoaderCircle,
  Radio,
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
import { cn } from "@workspace/ui/lib/utils"

import {
  TargetPicker,
  TargetPickerList,
  type PickerGroup,
  type PickerTarget,
} from "@/components/target-picker"
import { timestampedBackupName } from "@/lib/backup-name"
import { notALoginField } from "@/lib/not-a-login-field"

export interface BackupConfigurationTarget extends PickerTarget {
  consistencyChoice?: {
    stoppedDescription?: string | undefined
    stoppedUnavailable: string | null
  }
}

export interface BackupConfiguration {
  /** For an App or a volume: taken live, or with what uses it stopped. */
  consistency: "live" | "stopped"
  destinationKeys: ReadonlyArray<string>
  mode: "full" | "incremental"
  name: string
  /** What was chosen to back up, where the dialog offers targets. */
  targetKeys?: ReadonlyArray<string>
}

/** As many targets as one run takes. */
const MAX_TARGETS = 64

interface BackupStorageOption {
  deleting: boolean
  enabled: boolean
  id: string
  name: string
  ownerUserId: string | null
}

export function BackupConfigurationDialog({
  allowIncremental,
  consistencyChoice: fixedConsistencyChoice,
  description = "Relay runs this job in its single durable queue. Servers remain online while their data is archived.",
  error,
  groups = noGroups,
  initialConsistency = "live",
  initialDestinationKeys,
  initialMode = "incremental",
  initialName,
  initialTargetKeys,
  inlineTargets,
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
  allowIncremental?: boolean
  /**
   * An App's or a volume's backup, always a full archive, offers taking it
   * live or with what uses it stopped, in place of the mode.
   */
  consistencyChoice?: ConsistencyChoice
  description?: React.ReactNode
  error?: string
  /** Rows that stand for several of `targets`: Apps and groups. */
  groups?: ReadonlyArray<PickerGroup>
  initialConsistency?: "live" | "stopped"
  initialDestinationKeys?: ReadonlyArray<string>
  initialMode?: "full" | "incremental"
  initialName?: string
  /**
   * The targets chosen as it opens, as what the page is looking at. Left
   * unsaid, the only target there is, if there is only one.
   */
  initialTargetKeys?: ReadonlyArray<string> | undefined
  /**
   * Lists the targets in place, every one shown, for a step of a schedule
   * whose targets are already chosen: it picks which of them it backs up.
   * It may save with none, which its row then warns of. Whether they can be
   * taken stopped is the step's to say, from what is ticked.
   */
  inlineTargets?: {
    /** Every one ticked also takes targets added to the schedule later. */
    coversLater: boolean
    consistencyChoiceFor: (
      chosen: ReadonlyArray<BackupConfigurationTarget>
    ) => ConsistencyChoice | undefined
    /** Beneath the list, as what was left out and why. */
    note?: React.ReactNode
  }
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
  const openingKeys = (): ReadonlyArray<string> =>
    initialTargetKeys ?? (targets.length === 1 ? [targets[0]!.key] : [])
  const [selectedKeys, setSelectedKeys] = React.useState(openingKeys)
  // It stays mounted while closed, so each opening starts from what is
  // chosen then, as a schedule step's targets changed since.
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setSelectedKeys(openingKeys())
  }
  const [destinationKeys, setDestinationKeys] = React.useState<Array<string>>(
    () => [...(initialDestinationKeys ?? ["local"])]
  )
  const [mode, setMode] = React.useState<"full" | "incremental">(initialMode)
  const [consistency, setConsistency] = React.useState<"live" | "stopped">(
    initialConsistency
  )
  const selectedKeySet = React.useMemo(
    () => new Set(selectedKeys),
    [selectedKeys]
  )
  // What is chosen, in the order it is listed.
  const chosen = React.useMemo(
    () =>
      showTarget
        ? targets.filter((candidate) => selectedKeySet.has(candidate.key))
        : noTargets,
    [selectedKeySet, showTarget, targets]
  )
  const toggleTargets = React.useCallback(
    (keys: ReadonlyArray<string>, selected: boolean) =>
      setSelectedKeys((current) => {
        const next = new Set(current)
        for (const key of keys) {
          if (selected) next.add(key)
          else next.delete(key)
        }
        return [...next]
      }),
    []
  )
  const consistencyChoice = inlineTargets
    ? inlineTargets.consistencyChoiceFor(chosen)
    : showTarget
      ? chosenConsistencyChoice(chosen)
      : fixedConsistencyChoice
  const effectiveConsistency =
    consistencyChoice?.stoppedUnavailable === null ? consistency : "live"
  // A game server's choice. Chosen with anything else, each is a full
  // archive, as the rest of them are.
  const onlyInstances =
    chosen.length > 0 && chosen.every(({ kind }) => kind === "instance")
  const incrementalAllowed = showTarget
    ? onlyInstances
    : (allowIncremental ?? false)
  // Kiln's own backup goes only where the platform keeps its own.
  const platformChosen = chosen.some(({ kind }) => kind === "platform")
  const effectiveMode =
    mode === "incremental" && incrementalAllowed ? "incremental" : "full"
  const availableStorage = React.useMemo(
    () =>
      storage.filter(
        (destination) =>
          destination.enabled &&
          !destination.deleting &&
          (!platformChosen || destination.ownerUserId === null)
      ),
    [platformChosen, storage]
  )
  const destinationKeysInUse = React.useMemo(() => {
    const allowed = new Set([
      "local",
      ...availableStorage.map((destination) => destination.id),
    ])
    const next = destinationKeys.filter((destination) =>
      allowed.has(destination)
    )
    const usable = next.length > 0 ? next : ["local"]
    return effectiveMode === "incremental" || singleDestination
      ? usable.slice(0, 1)
      : usable
  }, [availableStorage, destinationKeys, effectiveMode, singleDestination])
  const selectedDestinations = React.useMemo(
    () => new Set(destinationKeysInUse),
    [destinationKeysInUse]
  )
  const showMode = !consistencyChoice && (showTarget ? onlyInstances : true)
  // A schedule's step takes as many as the schedule; one run, MAX_TARGETS.
  const tooMany = !inlineTargets && chosen.length > MAX_TARGETS

  const resetConfiguration = () => {
    setName(initialName ?? timestampedBackupName("manual"))
    setSelectedKeys(openingKeys())
    setDestinationKeys([...(initialDestinationKeys ?? ["local"])])
    setMode(initialMode)
    setConsistency("live")
  }

  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) resetConfiguration()
    onOpenChange(nextOpen)
  }

  const toggleDestination = (destination: string, checked: boolean) => {
    setDestinationKeys((current) => {
      if (effectiveMode === "incremental" || singleDestination) {
        return checked ? [destination] : ["local"]
      }
      const next = checked
        ? [...new Set([...current, destination])]
        : current.filter((key) => key !== destination)
      return next.length > 0 ? next : ["local"]
    })
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        className={cn(
          "sm:max-w-xl",
          // What is chosen adds and removes options below it. Its top stays
          // where it would be at its tallest, so it grows downward and the
          // list of targets, open beneath its field, never moves.
          showTarget &&
            "top-[max(1rem,calc(50dvh-18.25rem))] max-h-[calc(100dvh-1rem-max(1rem,calc(50dvh-18.25rem)))] translate-y-0"
        )}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
          <label className="block">
            <span className="mb-2 block text-xs font-medium">Name</span>
            <Input
              autoFocus
              aria-label="Backup name"
              {...notALoginField}
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          {inlineTargets ? (
            <div>
              <span className="mb-2 block text-xs font-medium">
                Targets{" "}
                <span className="font-normal text-muted-foreground">
                  {chosen.length} of {targets.length}
                </span>
              </span>
              <TargetPickerList
                ariaLabel="Backup targets"
                emptyMessage="No available targets"
                groups={groups}
                selectedKeys={selectedKeySet}
                targets={targets}
                onToggle={toggleTargets}
              />
              {inlineTargets.note}
              <p className="type-meta mt-1.5 text-muted-foreground">
                {!inlineTargets.coversLater
                  ? "It backs up only the ticked targets."
                  : targets.length === 0
                    ? "It backs up targets added to the schedule later, and an App once it uses a volume."
                    : chosen.length === targets.length
                      ? "With every one ticked, it also backs up targets added to the schedule later, and an App once it uses a volume."
                      : "It backs up only the ticked targets."}
              </p>
            </div>
          ) : showTarget ? (
            <div>
              <span className="mb-2 block text-xs font-medium">Targets</span>
              <TargetPicker
                ariaLabel="Backup targets"
                emptyMessage="No targets available"
                groups={groups}
                placeholder="Choose what to back up"
                selectedKeys={selectedKeySet}
                targets={targets}
                onToggle={toggleTargets}
              />
              {tooMany ? (
                <p role="alert" className="mt-1.5 text-xs text-destructive">
                  One backup takes up to {MAX_TARGETS} targets.
                </p>
              ) : null}
            </div>
          ) : null}
          {consistencyChoice ? (
            <BackupConsistencyChoices
              consistency={effectiveConsistency}
              stoppedDescription={
                consistencyChoice.stoppedDescription ??
                (chosen.length > 1
                  ? "Stops the Apps that use the volumes, then starts them again"
                  : undefined)
              }
              stoppedUnavailable={consistencyChoice.stoppedUnavailable}
              onConsistencyChange={setConsistency}
            />
          ) : null}
          {showMode ? (
            <BackupModeChoices
              effectiveMode={effectiveMode}
              incrementalAllowed={incrementalAllowed}
              onModeChange={setMode}
            />
          ) : null}
          <BackupDestinationChoices
            availableStorage={availableStorage}
            effectiveMode={effectiveMode}
            selectedDestinations={selectedDestinations}
            singleDestination={singleDestination}
            targetKind={platformChosen ? "platform" : undefined}
            onToggleDestination={toggleDestination}
          />
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
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
              (showTarget &&
                ((chosen.length === 0 && !inlineTargets) || tooMany))
            }
            type="button"
            onClick={() =>
              onSubmit({
                consistency: effectiveConsistency,
                destinationKeys: destinationKeysInUse,
                mode: effectiveMode,
                name: name.trim(),
                ...(showTarget
                  ? { targetKeys: chosen.map(({ key }) => key) }
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

function BackupConsistencyChoices({
  consistency,
  onConsistencyChange,
  stoppedDescription = "Stops the Apps that use it, then starts them again",
  stoppedUnavailable,
}: {
  consistency: "live" | "stopped"
  onConsistencyChange: (consistency: "live" | "stopped") => void
  stoppedDescription?: string | undefined
  stoppedUnavailable: string | null
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium">While it backs up</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <BackupDestinationChoice
          checked={consistency === "live"}
          description="Keeps running; copied as a crash would leave it"
          icon={Radio}
          label="Live"
          onCheckedChange={(checked) => {
            if (checked) onConsistencyChange("live")
          }}
        />
        <BackupDestinationChoice
          checked={consistency === "stopped"}
          description={stoppedUnavailable ?? stoppedDescription}
          disabled={stoppedUnavailable !== null}
          icon={CirclePause}
          label="Stopped"
          onCheckedChange={(checked) => {
            if (checked && stoppedUnavailable === null) {
              onConsistencyChange("stopped")
            }
          }}
        />
      </div>
      <p className="type-meta mt-2 text-muted-foreground">
        Stop it for data a live copy can’t capture safely, such as a database’s
        files. The backup records which.
      </p>
    </fieldset>
  )
}

function BackupDestinationChoices({
  availableStorage,
  effectiveMode,
  onToggleDestination,
  selectedDestinations,
  singleDestination,
  targetKind,
}: {
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
              : "Choose one or more copies."}
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

interface ConsistencyChoice {
  /** What stopping it does, when it's more than one target's. */
  stoppedDescription?: string | undefined
  /** Why it can't be stopped, as without permission to stop its Apps. */
  stoppedUnavailable: string | null
}

const noTargets: ReadonlyArray<BackupConfigurationTarget> = []
const noGroups: ReadonlyArray<PickerGroup> = []

// Whether what is chosen can be taken stopped: the volumes among it, which
// stop the Apps that use them, and why not when one of them can't be.
function chosenConsistencyChoice(
  chosen: ReadonlyArray<BackupConfigurationTarget>
):
  | {
      stoppedDescription?: string | undefined
      stoppedUnavailable: string | null
    }
  | undefined {
  const choices = chosen.flatMap(({ consistencyChoice }) =>
    consistencyChoice ? [consistencyChoice] : []
  )
  const [first] = choices
  if (!first) return undefined
  return {
    ...(choices.length === 1 ? first : {}),
    stoppedUnavailable:
      choices.find((choice) => choice.stoppedUnavailable !== null)
        ?.stoppedUnavailable ?? null,
  }
}
