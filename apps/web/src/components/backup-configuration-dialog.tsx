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
  TargetChecklist,
  TargetPicker,
  type PickerGroup,
  type PickerTarget,
} from "@/components/target-picker"
import { timestampedBackupName } from "@/lib/backup-name"
import { notALoginField } from "@/lib/not-a-login-field"

export interface BackupConfigurationTarget extends PickerTarget {
  consistencyChoice?: ConsistencyChoice
}

/** Whether a backup offers being taken live or stopped. */
interface ConsistencyChoice {
  /** What stopping it does, when it's more than one target's. */
  stoppedDescription?: string | undefined
  /** Why it can't be stopped, as without permission to stop its Apps. */
  stoppedUnavailable: string | null
}

export interface BackupConfiguration {
  /** For an App or a volume: taken live, or with what uses it stopped. */
  consistency: "live" | "stopped"
  destinationKeys: ReadonlyArray<string>
  mode: "full" | "incremental"
  name: string
  /** What was chosen to back up, where the dialog offers targets. */
  targetKeys: ReadonlyArray<string>
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

interface BackupConfigurationFormProps {
  /**
   * Whether what is chosen is offered live or stopped, in place of the mode:
   * by default, as the volumes among it are.
   */
  consistencyChoiceFor?: (
    chosen: ReadonlyArray<BackupConfigurationTarget>
  ) => ConsistencyChoice | undefined
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
  onSubmit: (configuration: BackupConfiguration) => void
  pending?: boolean
  singleDestination?: boolean
  storage: ReadonlyArray<BackupStorageOption>
  submitLabel?: string
  targets: ReadonlyArray<BackupConfigurationTarget>
  /**
   * How `targets` are chosen: from a field, or from a list in place, for a
   * step of a schedule, which picks which of the schedule's targets it backs
   * up and may back up none of them. `none` leaves it to whoever opened it.
   */
  targetsField?: "list" | "none" | "picker"
  /** Beneath that list, for the keys chosen in it. */
  targetsNote?: (chosen: ReadonlyArray<string>) => React.ReactNode
  title: string
}

export function BackupConfigurationDialog({
  onOpenChange,
  open,
  ...form
}: BackupConfigurationFormProps & {
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "sm:max-w-xl",
          // What is chosen adds and removes options below it. Its top stays
          // where it would be at its tallest, so it grows downward and the
          // list of targets never moves.
          form.targetsField !== "none" &&
            "top-[max(1rem,calc(50dvh-18.25rem))] max-h-[calc(100dvh-1rem-max(1rem,calc(50dvh-18.25rem)))] translate-y-0"
        )}
      >
        <BackupConfigurationForm
          {...form}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

// Mounted only while the dialog is open, so each opening starts afresh.
function BackupConfigurationForm({
  consistencyChoiceFor = chosenConsistencyChoice,
  description = "Relay runs this job in its single durable queue. Servers remain online while their data is archived.",
  error,
  groups = noGroups,
  initialConsistency = "live",
  initialDestinationKeys,
  initialMode = "incremental",
  initialName,
  initialTargetKeys,
  onCancel,
  onSubmit,
  pending = false,
  singleDestination = false,
  storage,
  submitLabel,
  targets,
  targetsField = "picker",
  targetsNote,
  title,
}: BackupConfigurationFormProps & { onCancel: () => void }) {
  const [name, setName] = React.useState(
    () => initialName ?? timestampedBackupName("manual")
  )
  const [selectedKeys, setSelectedKeys] = React.useState(
    (): ReadonlyArray<string> =>
      initialTargetKeys ?? (targets.length === 1 ? [targets[0]!.key] : [])
  )
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
    () => targets.filter((candidate) => selectedKeySet.has(candidate.key)),
    [selectedKeySet, targets]
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
  const consistencyChoice = consistencyChoiceFor(chosen)
  const effectiveConsistency =
    consistencyChoice?.stoppedUnavailable === null ? consistency : "live"
  // A game server's choice. Chosen with anything else, each is a full
  // archive, as the rest of them are.
  const onlyInstances =
    chosen.length > 0 && chosen.every(({ kind }) => kind === "instance")
  // Kiln's own backup goes only where the platform keeps its own.
  const platformChosen = chosen.some(({ kind }) => kind === "platform")
  const effectiveMode =
    mode === "incremental" && onlyInstances ? "incremental" : "full"
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
  // A schedule's step takes as many as the schedule, and may take none.
  const tooMany = targetsField === "picker" && chosen.length > MAX_TARGETS
  const noneChosen = targetsField === "picker" && chosen.length === 0

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
    <>
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
        {targetsField === "none" ? null : (
          <div>
            <span className="mb-2 block text-xs font-medium">Targets</span>
            {targetsField === "list" ? (
              <TargetChecklist
                ariaLabel="Backup targets"
                emptyMessage="Nothing here to back up"
                selectedKeys={selectedKeySet}
                targets={targets}
                onToggle={toggleTargets}
              />
            ) : (
              <TargetPicker
                ariaLabel="Backup targets"
                emptyMessage="No targets available"
                groups={groups}
                placeholder="Choose what to back up"
                selectedKeys={selectedKeySet}
                targets={targets}
                onToggle={toggleTargets}
              />
            )}
            {targetsNote ? (
              <p className="type-meta mt-1.5 text-muted-foreground">
                {targetsNote(selectedKeys)}
              </p>
            ) : null}
            {tooMany ? (
              <p role="alert" className="mt-1.5 text-xs text-destructive">
                One backup takes up to {MAX_TARGETS} targets.
              </p>
            ) : null}
          </div>
        )}
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
        {!consistencyChoice && onlyInstances ? (
          <BackupModeChoices mode={effectiveMode} onModeChange={setMode} />
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
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={pending || !name.trim() || noneChosen || tooMany}
          type="button"
          onClick={() =>
            onSubmit({
              consistency: effectiveConsistency,
              destinationKeys: destinationKeysInUse,
              mode: effectiveMode,
              name: name.trim(),
              targetKeys: chosen.map(({ key }) => key),
            })
          }
        >
          {pending ? <LoaderCircle className="animate-spin" /> : <Archive />}
          {submitLabel ?? "Create backup"}
        </Button>
      </DialogFooter>
    </>
  )
}

function BackupModeChoices({
  mode,
  onModeChange,
}: {
  mode: "full" | "incremental"
  onModeChange: (mode: "full" | "incremental") => void
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-xs font-medium">Mode</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <BackupDestinationChoice
          checked={mode === "incremental"}
          description="Deduplicated snapshots on this Relay or S3"
          icon={Archive}
          label="Incremental"
          onCheckedChange={(checked) => {
            if (checked) onModeChange("incremental")
          }}
        />
        <BackupDestinationChoice
          checked={mode === "full"}
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
    <fieldset className="min-w-0">
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
    <fieldset className="min-w-0">
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
        <span className="type-meta block text-pretty text-muted-foreground">
          {description}
        </span>
      </span>
      <span
        className={`grid size-4 shrink-0 place-items-center rounded-sm border ${
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

const noGroups: ReadonlyArray<PickerGroup> = []

// Whether what is chosen can be taken stopped: the volumes among it, which
// stop the Apps that use them, and why not when one of them can't be.
function chosenConsistencyChoice(
  chosen: ReadonlyArray<BackupConfigurationTarget>
): ConsistencyChoice | undefined {
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
