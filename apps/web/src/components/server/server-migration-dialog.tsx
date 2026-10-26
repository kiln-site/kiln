import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CPU_LIMIT_MILLIS_PER_CORE,
  MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
  MINIMUM_MEMORY_LIMIT_BYTES,
  type ResourceLimits,
} from "@workspace/contracts"
import {
  Activity,
  Archive,
  ArrowRightLeft,
  Copy,
  Globe,
  LoaderCircle,
  Power,
  Route,
  Trash2,
  Users,
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
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"

import { Field, ModeButton } from "@/components/dialog-fields"
import {
  ResourceLimitsEditor,
  type ResourceLimitKind,
} from "@/components/resource-limits-editor"
import { formatBytes } from "@/lib/format-bytes"
import { backupStorageQueryOptions } from "@/lib/query-options"
import {
  parseResourceLimitsDraft,
  resourceLimitsDraft,
} from "@/lib/resource-limits"
import {
  migrationRoomProblems,
  type MigrationRoomProblem,
} from "@/lib/server-migration-room"
import {
  serverMigrationPreviewQueryOptions,
  serverMigrationsQueryOptions,
} from "@/lib/server-migration-queries"
import type {
  ServerMigrationDestination,
  ServerMigrationPreview,
} from "@/server/server-migrations.server"
import { startServerMigration } from "@/server/server-migrations"

export type ServerMigrationMode = "duplicate" | "migrate"

const NO_RELAY = "__none__"
const NAME_LIMIT = 32
const GIBIBYTE = 1024 ** 3

/**
 * Copies a game server to a new one: a duplicate on any Relay the person
 * may create servers on, or a move to another Relay. It starts the copy and
 * closes; the copy carries on in the background with a progress toast.
 *
 * Every row stays in place whatever is chosen, and each message has a line
 * of its own, so the dialog never changes size under the pointer.
 */
export function ServerMigrationDialog({
  initialMode,
  onOpenChange,
  open,
  server,
}: {
  initialMode: ServerMigrationMode
  onOpenChange: (open: boolean) => void
  open: boolean
  server: { id: string; name: string; relayId: string }
}) {
  const preview = useQuery({
    ...serverMigrationPreviewQueryOptions({
      instanceId: server.id,
      relayId: server.relayId,
    }),
    enabled: open,
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <p className="type-technical-label text-primary-ink">Game server</p>
          <DialogTitle>Move or duplicate {server.name}</DialogTitle>
          <DialogDescription>
            The copy is a new game server with its own ID, files, and settings.
          </DialogDescription>
        </DialogHeader>
        {preview.isPending ? (
          <div className="type-support flex min-h-96 items-center justify-center gap-2 text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Checking where this server can go…
          </div>
        ) : preview.isError ? (
          <p
            className="type-support flex min-h-96 items-center justify-center text-destructive"
            role="alert"
          >
            {preview.error.message}
          </p>
        ) : (
          <MigrationForm
            initialMode={initialMode}
            preview={preview.data}
            server={server}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MigrationForm({
  initialMode,
  onDone,
  preview,
  server,
}: {
  initialMode: ServerMigrationMode
  onDone: () => void
  preview: ServerMigrationPreview
  server: { id: string; name: string; relayId: string }
}) {
  const queryClient = useQueryClient()
  const [mode, setMode] = React.useState(initialMode)
  const moving = mode === "migrate"
  const destinations = React.useMemo(
    () =>
      preview.destinations.filter(
        (destination) => !moving || !destination.current
      ),
    [moving, preview.destinations]
  )

  // The copy's limits start as the old server's.
  const sourceDraft = React.useMemo(
    () => resourceLimitsDraft(preview.source.limits),
    [preview.source.limits]
  )
  const [draft, setDraft] = React.useState(sourceDraft)
  const parsed = parseResourceLimitsDraft(draft, null)
  const limits = "limits" in parsed ? parsed.limits : null
  const limitsChanged = limits !== null && !sameLimits(limits, preview.source.limits)

  const [backup, setBackup] = React.useState(false)
  const [backupDestination, setBackupDestination] = React.useState("default")
  // Whether the copy fits there, as the Relays said when the dialog opened.
  // Checked again when it starts and before the server stops.
  const roomProblemsFor = (
    destination: ServerMigrationDestination
  ): ReadonlyArray<MigrationRoomProblem> =>
    destination.room && preview.room
      ? migrationRoomProblems({
          destination: destination.room,
          limits: true,
          localBackups:
            backup &&
            (backupDestination === "local" ||
              (backupDestination === "default" &&
                preview.room.defaultBackupLocal))
              ? 1
              : 0,
          server: {
            ...preview.room.server,
            limits: limits ?? preview.source.limits,
          },
          source: preview.room.source,
        })
      : []
  // The Relay picked when the dialog opened, so editing the limits never
  // moves the choice under the person.
  const [relayId, setRelayId] = React.useState<string | null>(
    () =>
      defaultDestination(
        destinations,
        mode,
        (destination) =>
          !destination.problems.length && !roomProblemsFor(destination).length
      )?.id ?? null
  )
  const selected =
    destinations.find((destination) => destination.id === relayId) ??
    defaultDestination(destinations, mode, (destination) => {
      return !destination.problems.length
    })
  const [name, setName] = React.useState<string | null>(null)
  const effectiveName =
    name ?? defaultName(server.name, mode, selected?.takenNames ?? [])

  const [copyAccess, setCopyAccess] = React.useState(
    preview.allowed.copyAccess && preview.accessCount > 0
  )
  const [keepActivity, setKeepActivity] = React.useState(true)
  const [linkBackups, setLinkBackups] = React.useState(true)
  const [moveDomain, setMoveDomain] = React.useState(
    preview.domains.managed && preview.domains.names.length > 0
  )
  const [moveWebRoutes, setMoveWebRoutes] = React.useState(
    preview.webRoutes.length > 0 && preview.allowed.network
  )
  const [stopSource, setStopSource] = React.useState(
    preview.source.running && preview.allowed.power
  )
  const [deleteSource, setDeleteSource] = React.useState(false)
  const [deleteDestination, setDeleteDestination] = React.useState("default")
  const deleting = moving && deleteSource && preview.allowed.delete
  const backupStorage = useQuery({
    ...backupStorageQueryOptions(),
    enabled: preview.allowed.backup,
  })

  const linkableBackups =
    selected && selected.linksBackups && preview.allowed.linkBackups
      ? selected.current
        ? preview.backups.here
        : preview.backups.anywhere
      : 0
  const start = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("Choose a Relay")
      if (!limits) throw new Error("Check the copy's limits")
      return startServerMigration({
        data: {
          destinationRelayId: selected.id,
          instanceId: server.id,
          mode,
          name: effectiveName.trim(),
          options: {
            backup: backup ? storageChoice(backupDestination) : null,
            copyAccess,
            deleteSource: deleting ? storageChoice(deleteDestination) : null,
            keepActivity,
            limits: limitsChanged ? limits : null,
            linkBackups: linkBackups && linkableBackups > 0,
            moveDomain: moving && moveDomain,
            moveWebRoutes: moving && moveWebRoutes,
            stopSource: moving || stopSource,
          },
          relayId: server.relayId,
        },
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: serverMigrationsQueryOptions().queryKey,
      })
      onDone()
    },
  })
  const pending = start.isPending

  const trimmedName = effectiveName.trim()
  const nameTaken = selected?.takenNames.includes(trimmedName) ?? false
  const roomProblems = selected ? roomProblemsFor(selected) : []
  const fieldProblems = limitProblemsByField(roomProblems)
  const spaceProblems = roomProblems.filter(
    (problem) => problem.code === "space"
  )
  const relayProblem = selected?.problems[0]
  const archMismatch =
    selected?.nodeArch &&
    preview.source.nodeArch &&
    selected.nodeArch !== preview.source.nodeArch
  const blocked =
    !selected ||
    !limits ||
    selected.problems.length > 0 ||
    roomProblems.length > 0 ||
    !trimmedName ||
    nameTaken ||
    preview.source.provisioning ||
    (moving && !preview.allowed.stop)

  // Why the copy can't start, or what to know before it does; one line.
  const notice: { text: string; tone: "error" | "warning" } | null =
    start.isError
      ? { text: start.error.message, tone: "error" }
      : "error" in parsed
        ? { text: parsed.error, tone: "error" }
        : preview.source.provisioning
          ? {
              text: "This server is still being created; copy it once it's ready.",
              tone: "warning",
            }
          : moving && !preview.allowed.stop
            ? {
                text: "A move stops this server, and you can't stop it.",
                tone: "error",
              }
            : destinations.length === 0
              ? {
                  text: moving
                    ? "There's no other Relay you can create game servers on."
                    : "There's no Relay you can create game servers on.",
                  tone: "warning",
                }
              : archMismatch && selected
                ? {
                    text: `${selected.name} runs ${selected.nodeArch} and this server ${preview.source.nodeArch}; its Brick's image must support both.`,
                    tone: "warning",
                  }
                : null

  const capacity = selected?.capacity ?? null
  const fit = (kind: ResourceLimitKind, bytesOrMillis: number | null) => {
    if (bytesOrMillis === null) return
    setDraft((current) => ({
      ...current,
      ...(kind === "cpu"
        ? {
            cpuCores: {
              limited: true,
              value: String(bytesOrMillis / CPU_LIMIT_MILLIS_PER_CORE),
            },
          }
        : kind === "memory"
          ? {
              memoryGiB: {
                limited: true,
                value: String(bytesOrMillis / GIBIBYTE),
              },
            }
          : {
              diskGiB: {
                limited: true,
                value: String(bytesOrMillis / GIBIBYTE),
              },
            }),
    }))
  }
  const notes = limitNotes({
    disabled: pending,
    fit,
    problems: fieldProblems,
    relay: selected,
    usedBytes: preview.room?.server.usedBytes ?? null,
  })

  return (
    <form
      className="grid grid-cols-[minmax(0,1fr)] gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        if (!blocked) start.mutate()
      }}
    >
      <div
        aria-label="What to do"
        className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2"
        role="radiogroup"
      >
        <ModeButton
          checked={!moving}
          description="Keep this server too"
          disabled={pending}
          icon={<Copy />}
          label="Duplicate"
          onSelect={() => setMode("duplicate")}
        />
        <ModeButton
          checked={moving}
          description="Hand its place to the copy"
          disabled={pending}
          icon={<ArrowRightLeft />}
          label="Move"
          onSelect={() => setMode("migrate")}
        />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[repeat(2,minmax(0,1fr))]">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
          <Field label={moving ? "Move to" : "Copy to"}>
            <Select
              disabled={pending || destinations.length === 0}
              value={selected?.id ?? NO_RELAY}
              onValueChange={(value) => {
                if (value && value !== NO_RELAY) setRelayId(value)
              }}
            >
              <SelectTrigger
                aria-label="Relay"
                className="w-full *:data-[slot=select-value]:truncate"
              >
                <SelectValue placeholder="Choose a Relay" />
              </SelectTrigger>
              <SelectContent className="min-w-(--radix-select-trigger-width)">
                {destinations.length === 0 ? (
                  <SelectItem disabled value={NO_RELAY}>
                    No Relay available
                  </SelectItem>
                ) : (
                  destinations.map((destination) => (
                    <SelectItem key={destination.id} value={destination.id}>
                      {destination.name}
                      {destination.current ? " · this Relay" : ""}
                      {destination.problems.length
                        ? " · unavailable"
                        : roomProblemsFor(destination).length
                          ? " · not enough room"
                          : ""}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </Field>
          <Line
            text={
              relayProblem
                ? `${relayProblem.message}. ${relayProblem.remedy}.`
                : spaceProblems[0]
                  ? spaceProblems.map((problem) => problem.message).join(". ")
                  : selected
                    ? relaySummary(selected)
                    : null
            }
            tone={relayProblem || spaceProblems.length ? "error" : "muted"}
          />
        </div>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
          <Field label="Name">
            <Input
              aria-invalid={nameTaken || !trimmedName}
              disabled={pending}
              maxLength={NAME_LIMIT}
              value={effectiveName}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </Field>
          <Line
            text={
              nameTaken && selected
                ? `A game server on ${selected.name} already has this name.`
                : !trimmedName
                  ? "Give the copy a name."
                  : null
            }
            tone="error"
          />
        </div>
      </div>

      <section className="grid grid-cols-[minmax(0,1fr)] gap-2">
        <div className="flex h-6 items-center justify-between gap-3">
          <h3 className="type-label">Limits</h3>
          <Button
            className={cn(!limitsChanged && "invisible")}
            disabled={pending}
            size="xs"
            type="button"
            variant="ghost"
            onClick={() => setDraft(sourceDraft)}
          >
            Use {server.name}'s
          </Button>
        </div>
        <ResourceLimitsEditor
          capacity={capacity}
          compact
          disabled={pending}
          draft={draft}
          notes={notes}
          onChange={setDraft}
        />
      </section>

      <section className="grid grid-cols-[minmax(0,1fr)] gap-2">
        <h3 className="type-label">Bring along</h3>
        <div className="grid grid-cols-[minmax(0,1fr)] divide-y divide-border/65 rounded-xl border border-border/75 bg-background/45">
          <OptionRow
            checked={copyAccess}
            description={
              !preview.allowed.copyAccess
                ? "You can't see who has access to this server."
                : preview.accessCount === 0
                  ? "Only its owner can reach it now."
                  : "They get the same permissions on the copy."
            }
            disabled={
              pending ||
              !preview.allowed.copyAccess ||
              preview.accessCount === 0
            }
            icon={<Users />}
            label={
              preview.accessCount === 0
                ? "People with access"
                : preview.accessCount === 1
                  ? "The person with access"
                  : `The ${preview.accessCount} people with access`
            }
            onCheckedChange={setCopyAccess}
          />
          <BackupsOption
            allowed={preview.allowed.linkBackups}
            checked={linkBackups && linkableBackups > 0}
            destination={selected}
            disabled={pending}
            linkable={linkableBackups}
            total={preview.backups.total}
            onCheckedChange={setLinkBackups}
          />
          <OptionRow
            checked={keepActivity}
            description="The copy's activity includes this server's history."
            disabled={pending}
            icon={<Activity />}
            label="Activity history"
            onCheckedChange={setKeepActivity}
          />
          <DomainOption
            checked={moving && moveDomain}
            destination={selected}
            disabled={pending || !moving || !preview.allowed.network}
            moving={moving}
            preview={preview}
            onCheckedChange={setMoveDomain}
          />
          <OptionRow
            checked={moving && moveWebRoutes && preview.webRoutes.length > 0}
            description={
              preview.webRoutes.length === 0
                ? "This server has no web routes."
                : moving
                  ? `${preview.webRoutes.join(", ")} point at ${selected?.name ?? "the new Relay"}; HTTPS works once DNS reaches it.`
                  : `${preview.webRoutes.join(", ")} stay with this server.`
            }
            disabled={
              pending ||
              !moving ||
              !preview.allowed.network ||
              preview.webRoutes.length === 0
            }
            icon={<Route />}
            label="Web routes"
            onCheckedChange={setMoveWebRoutes}
          />
        </div>
      </section>

      <section className="grid grid-cols-[minmax(0,1fr)] gap-2">
        <h3 className="type-label">Before and after</h3>
        <div className="grid grid-cols-[minmax(0,1fr)] divide-y divide-border/65 rounded-xl border border-border/75 bg-background/45">
          <OptionRow
            checked={backup}
            control={
              <BackupDestinationSelect
                disabled={pending || !backup}
                label="Backup destination"
                storage={backupStorage.data}
                value={backupDestination}
                onChange={setBackupDestination}
              />
            }
            description={
              preview.allowed.backup
                ? "A full backup, finished before anything changes."
                : "You can't back up this server."
            }
            disabled={pending || !preview.allowed.backup}
            icon={<Archive />}
            label="Back up first"
            onCheckedChange={setBackup}
          />
          <OptionRow
            checked={moving || (stopSource && preview.source.running)}
            description={
              moving
                ? deleting
                  ? "It stops for the move and stays stopped until it's deleted."
                  : "It stops for the move and stays stopped."
                : preview.source.running
                  ? "It starts again afterwards; a running world can be caught mid-save."
                  : "It isn't running."
            }
            disabled={
              pending ||
              moving ||
              !preview.allowed.power ||
              !preview.source.running
            }
            icon={<Power />}
            label={moving ? "Stop this server" : "Stop it while copying"}
            onCheckedChange={setStopSource}
          />
          <OptionRow
            checked={deleting}
            control={
              <BackupDestinationSelect
                disabled={pending || !deleting}
                label="Final backup destination"
                storage={backupStorage.data}
                value={deleteDestination}
                onChange={setDeleteDestination}
              />
            }
            description={
              !moving
                ? "Only a move can delete this server."
                : preview.allowed.delete
                  ? "Once moved, after a full backup of it that stays."
                  : "Deleting it needs permission to delete and back it up."
            }
            disabled={pending || !moving || !preview.allowed.delete}
            icon={<Trash2 />}
            label="Delete this server"
            onCheckedChange={setDeleteSource}
          />
        </div>
      </section>

      <p
        aria-live="polite"
        className={cn(
          "type-meta -my-1 line-clamp-2 min-h-[2lh]",
          notice?.tone === "warning"
            ? "text-amber-300 light:text-amber-800"
            : "text-destructive"
        )}
        role={notice?.tone === "error" ? "alert" : undefined}
        title={notice?.text}
      >
        {notice?.text}
      </p>

      <DialogFooter>
        <Button
          disabled={pending}
          type="button"
          variant="outline"
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button className="min-w-36" disabled={blocked || pending} type="submit">
          {pending ? <LoaderCircle className="animate-spin" /> : null}
          {moving ? "Move server" : "Duplicate server"}
        </Button>
      </DialogFooter>
    </form>
  )
}

// One line under a field, kept whether or not it has anything to say.
function Line({
  text,
  tone,
}: {
  text: string | null
  tone: "error" | "muted"
}) {
  return (
    <p
      className={cn(
        "type-meta min-h-[1lh] truncate",
        tone === "error" ? "text-destructive" : "text-muted-foreground"
      )}
      title={text ?? undefined}
    >
      {text}
    </p>
  )
}

// An option with a switch, and room for a control of its own beside it.
// Its description keeps to one line, whole in its tooltip.
function OptionRow({
  checked,
  control,
  description,
  disabled = false,
  icon,
  label,
  onCheckedChange,
}: {
  checked: boolean
  control?: React.ReactNode
  description: string
  disabled?: boolean
  icon: React.ReactNode
  label: string
  onCheckedChange?: (checked: boolean) => void
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2",
        disabled && !checked && "opacity-60"
      )}
    >
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      <label className="min-w-0 flex-1">
        <span className="type-label block truncate">{label}</span>
        <span
          className="type-meta block truncate text-muted-foreground"
          title={description}
        >
          {description}
        </span>
      </label>
      {control}
      <Switch
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange?.(next)}
      />
    </div>
  )
}

// Where a backup goes: wherever this server's backups go by default, the
// Relay itself, or an S3 destination.
function BackupDestinationSelect({
  disabled,
  label,
  onChange,
  storage,
  value,
}: {
  disabled: boolean
  label: string
  onChange: (value: string) => void
  storage:
    | ReadonlyArray<{
        deleting: boolean
        enabled: boolean
        id: string
        name: string
      }>
    | undefined
  value: string
}) {
  return (
    <Select
      disabled={disabled}
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next)
      }}
    >
      <SelectTrigger
        aria-label={label}
        className="w-36 shrink-0 *:data-[slot=select-value]:truncate"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="min-w-(--radix-select-trigger-width)">
        <SelectItem value="default">Default storage</SelectItem>
        <SelectItem value="local">This Relay</SelectItem>
        {(storage ?? [])
          .filter((item) => item.enabled && !item.deleting)
          .map((item) => (
            <SelectItem key={item.id} value={item.id}>
              S3 · {item.name}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  )
}

function storageChoice(value: string): { storageId?: string | null } {
  if (value === "default") return {}
  return { storageId: value === "local" ? null : value }
}

// Full backups restore to the copy as linked backups. Ones kept on this
// Relay can't follow a copy to another, and incremental ones belong to this
// server's repository.
function BackupsOption({
  allowed,
  checked,
  destination,
  disabled,
  linkable,
  onCheckedChange,
  total,
}: {
  allowed: boolean
  checked: boolean
  destination: ServerMigrationDestination | undefined
  disabled: boolean
  linkable: number
  onCheckedChange: (checked: boolean) => void
  total: number
}) {
  const staying = total - linkable
  const description =
    total === 0
      ? "This server has no backups."
      : !allowed
        ? "Linking backups needs permission to download them."
        : destination && !destination.linksBackups
          ? `Update ${destination.name} to link backups to a copy there.`
          : linkable === 0
            ? destination?.current
              ? "Its backups are incremental, so they stay with this server."
              : "Its backups are on this Relay or incremental, so they stay; back up to S3 first to bring one."
            : `They restore to the copy too.${
                staying > 0
                  ? ` ${staying} ${staying === 1 ? "stays" : "stay"} with this server.`
                  : ""
              }`
  return (
    <OptionRow
      checked={checked}
      description={description}
      disabled={disabled || linkable === 0}
      icon={<Archive />}
      label={
        linkable === 0
          ? "Backups"
          : linkable === 1
            ? "Link 1 backup"
            : `Link ${linkable} backups`
      }
      onCheckedChange={onCheckedChange}
    />
  )
}

// A move takes managed domains along and points them at the new Relay;
// without Cloudflare, Kiln manages no DNS, so the person updates their own.
function DomainOption({
  checked,
  destination,
  disabled,
  moving,
  onCheckedChange,
  preview,
}: {
  checked: boolean
  destination: ServerMigrationDestination | undefined
  disabled: boolean
  moving: boolean
  onCheckedChange: (checked: boolean) => void
  preview: ServerMigrationPreview
}) {
  const relayName = destination?.name ?? "the new Relay"
  const names = preview.domains.names
  const description = !preview.domains.managed
    ? moving
      ? `Kiln doesn't manage DNS; point your domain at ${relayName} once it's moved.`
      : "Kiln doesn't manage DNS, so there's no domain to bring."
    : !names.length
      ? "This server has no managed domain."
      : !moving
        ? `${names.join(", ")} stays with this server; the copy gets its own.`
        : `Kiln points ${names.join(", ")} at ${relayName}, so players join the same way.`
  return (
    <OptionRow
      checked={checked && preview.domains.managed && names.length > 0}
      description={description}
      disabled={disabled || !preview.domains.managed || !names.length}
      icon={<Globe />}
      label={names.length === 1 ? "Domain" : "Domains"}
      onCheckedChange={onCheckedChange}
    />
  )
}

function relaySummary(destination: ServerMigrationDestination): string {
  const room = destination.room
  return [
    destination.nodeArch,
    room
      ? `${formatBytes(Math.min(room.rootsFreeBytes, room.transferFreeBytes))} free`
      : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

function limitProblemsByField(
  problems: ReadonlyArray<MigrationRoomProblem>
): Partial<Record<ResourceLimitKind, MigrationRoomProblem>> {
  const byField: Partial<Record<ResourceLimitKind, MigrationRoomProblem>> = {}
  for (const problem of problems) {
    if (problem.code === "cpu") byField.cpu ??= problem
    if (problem.code === "memory") byField.memory ??= problem
    if (problem.code === "disk_limit" || problem.code === "disk_files") {
      byField.disk ??= problem
    }
  }
  return byField
}

// Why a limit won't fit, in place of what the Relay can assign, with the
// nearest one that would.
function limitNotes({
  disabled,
  fit,
  problems,
  relay,
  usedBytes,
}: {
  disabled: boolean
  fit: (kind: ResourceLimitKind, value: number | null) => void
  problems: Partial<Record<ResourceLimitKind, MigrationRoomProblem>>
  relay: ServerMigrationDestination | undefined
  usedBytes: number | null
}): Partial<Record<ResourceLimitKind, React.ReactNode>> {
  const room = relay?.room
  if (!room) return {}
  const disk = problems.disk
  const smallestDisk = Math.max(
    usedBytes ?? 0,
    MINIMUM_INSTANCE_DISK_LIMIT_BYTES
  )
  const suggestions: Record<ResourceLimitKind, number | null> = {
    cpu: room.cores * CPU_LIMIT_MILLIS_PER_CORE,
    // Room for its files, or as much as the Relay can give.
    disk:
      disk?.code === "disk_files"
        ? roundUp(smallestDisk, GIBIBYTE) <= room.assignableDiskBytes
          ? roundUp(smallestDisk, GIBIBYTE)
          : null
        : roundDown(room.assignableDiskBytes, GIBIBYTE) >= smallestDisk
          ? roundDown(room.assignableDiskBytes, GIBIBYTE)
          : null,
    memory:
      roundDown(room.assignableMemoryBytes, GIBIBYTE / 4) >=
      MINIMUM_MEMORY_LIMIT_BYTES
        ? roundDown(room.assignableMemoryBytes, GIBIBYTE / 4)
        : null,
  }
  const notes: Partial<Record<ResourceLimitKind, React.ReactNode>> = {}
  for (const kind of ["memory", "cpu", "disk"] as const) {
    const problem = problems[kind]
    if (!problem) continue
    const suggestion = suggestions[kind]
    notes[kind] = (
      <>
        <span className="truncate text-destructive" title={problem.message}>
          {kind === "cpu"
            ? `${room.cores} ${room.cores === 1 ? "core" : "cores"} on ${room.name}`
            : kind === "memory"
              ? `${formatBytes(room.assignableMemoryBytes)} assignable`
              : problem.code === "disk_files"
                ? `Its files take ${formatBytes(usedBytes ?? 0)}`
                : `${formatBytes(room.assignableDiskBytes)} assignable`}
        </span>
        {suggestion !== null ? (
          <button
            className="shrink-0 font-medium text-primary-ink underline-offset-2 hover:underline disabled:opacity-50"
            disabled={disabled}
            type="button"
            onClick={() => fit(kind, suggestion)}
          >
            Use{" "}
            {kind === "cpu"
              ? `${suggestion / CPU_LIMIT_MILLIS_PER_CORE}`
              : formatBytes(suggestion)}
          </button>
        ) : null}
      </>
    )
  }
  return notes
}

function roundDown(value: number, step: number): number {
  return Math.floor(value / step) * step
}

function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step
}

function sameLimits(left: ResourceLimits, right: ResourceLimits): boolean {
  return (
    left.cpuMillis === right.cpuMillis &&
    left.diskBytes === right.diskBytes &&
    left.memoryBytes === right.memoryBytes
  )
}

function defaultDestination(
  destinations: ReadonlyArray<ServerMigrationDestination>,
  mode: ServerMigrationMode,
  usable: (destination: ServerMigrationDestination) => boolean
) {
  const candidates = destinations.filter(usable)
  return (
    (mode === "duplicate"
      ? candidates.find((destination) => destination.current)
      : null) ??
    candidates[0] ??
    destinations[0]
  )
}

// A move keeps the server's name; a duplicate takes the first free
// "<name> copy", "<name> copy 2", … on its Relay.
function defaultName(
  name: string,
  mode: ServerMigrationMode,
  taken: ReadonlyArray<string>
) {
  if (mode === "migrate") return name.slice(0, NAME_LIMIT)
  for (let index = 1; index < 100; index += 1) {
    const suffix = index === 1 ? " copy" : ` copy ${index}`
    const candidate = `${name.slice(0, NAME_LIMIT - suffix.length)}${suffix}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${name.slice(0, NAME_LIMIT - 5)} copy`
}
