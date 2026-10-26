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
  ArrowRight,
  ArrowRightLeft,
  Copy,
  Cpu,
  Globe,
  HardDrive,
  LoaderCircle,
  MemoryStick,
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
import { Slider, type SliderZone } from "@workspace/ui/components/slider"
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"

import { InstanceCard } from "@/components/instance-card"
import { LiveServerBrickIcon } from "@/components/server-brick-icon"
import { formatBytes } from "@/lib/format-bytes"
import { backupStorageQueryOptions } from "@/lib/query-options"
import {
  parseResourceLimitsDraft,
  resourceLimitsDraft,
  type ResourceLimitDraft,
  type ResourceLimitsDraft,
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

type MigrationServer = {
  brickId?: string
  brickSource?: string
  id: string
  implementation?: string
  name: string
  relayId: string
}

type LimitKind = "cpu" | "disk" | "memory"

type Note = { text: string; tone: "error" | "muted" }

const NO_RELAY = "__none__"
const NAME_LIMIT = 32
const GIBIBYTE = 1024 ** 3

/**
 * Copies a game server to a new one: a duplicate on any Relay the person
 * may create servers on, or a move to another Relay. It starts the copy and
 * closes; the copy carries on in the background with a progress toast.
 *
 * It reads as before and after: the server and its Relay on the left, the
 * copy and where it goes on the right, then the copy's limits beside what
 * comes along. Every row stays in place whatever is chosen, and each
 * message has a line of its own, so the dialog never changes size.
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
  server: MigrationServer
}) {
  const [mode, setMode] = React.useState(initialMode)
  const preview = useQuery({
    ...serverMigrationPreviewQueryOptions({
      instanceId: server.id,
      relayId: server.relayId,
    }),
    enabled: open,
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 sm:max-w-5xl">
        <div className="flex flex-wrap items-center justify-between gap-3 pr-10">
          <DialogTitle>Move or duplicate</DialogTitle>
          <DialogDescription className="sr-only">
            Copy {server.name} to a new game server, here or on another Relay.
          </DialogDescription>
          <div
            aria-label="What to do"
            className="grid grid-cols-2 gap-1 border border-border/75 bg-background/45 p-1"
            role="radiogroup"
          >
            <ModeButton
              checked={mode === "duplicate"}
              icon={<Copy />}
              label="Duplicate"
              title="Keep this server too"
              onSelect={() => setMode("duplicate")}
            />
            <ModeButton
              checked={mode === "migrate"}
              icon={<ArrowRightLeft />}
              label="Move"
              title="Hand this server's place to the copy"
              onSelect={() => setMode("migrate")}
            />
          </div>
        </div>
        {preview.isPending ? (
          <div className="type-support flex h-[36rem] items-center justify-center gap-2 text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Checking where this server can go…
          </div>
        ) : preview.isError ? (
          <p
            className="type-support flex h-[36rem] items-center justify-center text-destructive"
            role="alert"
          >
            {preview.error.message}
          </p>
        ) : (
          <MigrationForm
            mode={mode}
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
  mode,
  onDone,
  preview,
  server,
}: {
  mode: ServerMigrationMode
  onDone: () => void
  preview: ServerMigrationPreview
  server: MigrationServer
}) {
  const queryClient = useQueryClient()
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
  const limitsChanged =
    limits !== null && !sameLimits(limits, preview.source.limits)

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
    defaultDestination(
      destinations,
      mode,
      (destination) => !destination.problems.length
    )
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

  const sourceRoom = preview.room?.source ?? null
  const usedBytes =
    preview.room && preview.room.server.usedFrom !== "limit"
      ? preview.room.server.usedBytes
      : null
  const destinationNote: Note | null = relayProblem
    ? {
        text: `${relayProblem.message}. ${relayProblem.remedy}.`,
        tone: "error",
      }
    : spaceProblems.length
      ? {
          text: spaceProblems.map((problem) => problem.message).join(". "),
          tone: "error",
        }
      : nameTaken && selected
        ? {
            text: `A game server on ${selected.name} already has this name.`,
            tone: "error",
          }
        : !trimmedName
          ? { text: "Give the copy a name.", tone: "error" }
          : null

  return (
    <form
      className="grid grid-cols-[minmax(0,1fr)] gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!blocked) start.mutate()
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <Side label="From">
          <CardBox>
            <InstanceCard
              className="min-w-0 flex-1"
              instance={{
                brickId: server.brickId,
                brickSource: server.brickSource,
                id: server.id,
                implementation: server.implementation,
                kind: "server",
                relayId: server.relayId,
              }}
              meta={
                usedBytes === null
                  ? server.id.slice(0, 8)
                  : `${server.id.slice(0, 8)} · files take ${formatBytes(usedBytes)}`
              }
              metaClassName="font-mono"
              name={server.name}
              showFavorite={false}
            />
          </CardBox>
          <CardBox>
            <RelayCard
              arch={preview.source.nodeArch}
              freeBytes={sourceRoom ? freeBytes(sourceRoom) : null}
              id={preview.source.relayId}
              name={preview.source.relayName}
            />
          </CardBox>
          <Line
            note={{
              text: moving
                ? deleting
                  ? "Stops for the move, then is deleted after a final backup."
                  : "Stops for the move and stays stopped."
                : stopSource && preview.source.running
                  ? "Stops while its files copy, then starts again."
                  : "Stays as it is.",
              tone: "muted",
            }}
          />
        </Side>
        <ArrowRight
          aria-hidden="true"
          className="mt-[2.4rem] hidden size-4 text-muted-foreground md:block"
        />
        <Side label="To">
          <CardBox interactive>
            <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/70 bg-background/35 text-muted-foreground">
              <LiveServerBrickIcon
                brickId={server.brickId}
                brickSource={server.brickSource}
                implementation={server.implementation ?? ""}
              />
            </span>
            <Input
              aria-invalid={nameTaken || !trimmedName}
              aria-label="New server's name"
              className="h-8 min-w-0 border-0 bg-transparent px-1 text-xs font-semibold shadow-none focus-visible:ring-0 dark:bg-transparent"
              disabled={pending}
              maxLength={NAME_LIMIT}
              value={effectiveName}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </CardBox>
          <Select
            disabled={pending || destinations.length === 0}
            value={selected?.id ?? NO_RELAY}
            onValueChange={(value) => {
              if (value && value !== NO_RELAY) setRelayId(value)
            }}
          >
            <SelectTrigger
              aria-label="Relay"
              className="h-12 w-full min-w-0 px-2 text-left *:data-[slot=select-value]:flex *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:flex-1"
            >
              <SelectValue placeholder="No Relay available">
                {selected ? (
                  <RelayCard
                    arch={selected.nodeArch}
                    freeBytes={selected.room ? freeBytes(selected.room) : null}
                    id={selected.id}
                    name={selected.name}
                    tag={relayTag(selected, roomProblemsFor(selected))}
                  />
                ) : null}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="min-w-(--radix-select-trigger-width)">
              {destinations.length === 0 ? (
                <SelectItem disabled value={NO_RELAY}>
                  No Relay available
                </SelectItem>
              ) : (
                destinations.map((destination) => (
                  <SelectItem
                    key={destination.id}
                    className="py-1.5"
                    value={destination.id}
                  >
                    <RelayCard
                      arch={destination.nodeArch}
                      freeBytes={
                        destination.room ? freeBytes(destination.room) : null
                      }
                      id={destination.id}
                      name={destination.name}
                      tag={relayTag(destination, roomProblemsFor(destination))}
                    />
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          <Line
            note={
              destinationNote ??
              (selected
                ? {
                    text: "Made stopped, then filled with this server's files.",
                    tone: "muted",
                  }
                : null)
            }
          />
        </Side>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-5 gap-y-4 md:grid-cols-2">
        <section className="grid grid-cols-[minmax(0,1fr)] content-start gap-2">
          <div className="flex h-5 items-center justify-between gap-3">
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
          <LimitRows
            destination={selected}
            disabled={pending}
            draft={draft}
            original={preview.source.limits}
            problems={fieldProblems}
            usedBytes={usedBytes}
            onChange={setDraft}
          />
          <h3 className="type-label mt-2 flex h-5 items-center">
            Before and after
          </h3>
          <Rows>
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
                  ? "A full backup before anything changes."
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
                  ? "A move always stops it."
                  : preview.source.running
                    ? "Starts again after; a running world can be mid-save."
                    : "It isn't running."
              }
              disabled={
                pending ||
                moving ||
                !preview.allowed.power ||
                !preview.source.running
              }
              icon={<Power />}
              label={moving ? "Stop this server" : "Stop while copying"}
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
                  ? "Only a move can delete it."
                  : preview.allowed.delete
                    ? "Once moved, after a full backup that stays."
                    : "Needs permission to delete and back it up."
              }
              disabled={pending || !moving || !preview.allowed.delete}
              icon={<Trash2 />}
              label="Delete this server"
              onCheckedChange={setDeleteSource}
            />
          </Rows>
        </section>

        <section className="grid grid-cols-[minmax(0,1fr)] content-start gap-2">
          <h3 className="type-label flex h-5 items-center">Bring along</h3>
          <Rows>
            <OptionRow
              checked={copyAccess}
              description={
                !preview.allowed.copyAccess
                  ? "You can't see who has access to this server."
                  : preview.accessCount === 0
                    ? "Only its owner can reach it now."
                    : "The same permissions on the copy."
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
                    ? "1 person with access"
                    : `${preview.accessCount} people with access`
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
              description="The copy's activity includes this server's."
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
                    ? `${preview.webRoutes.join(", ")} point at ${selected?.name ?? "the new Relay"}.`
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
          </Rows>
        </section>
      </div>

      <p
        aria-live="polite"
        className={cn(
          "type-meta -my-2 min-h-[1lh] truncate",
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
        <Button
          className="min-w-36"
          disabled={blocked || pending}
          type="submit"
        >
          {pending ? <LoaderCircle className="animate-spin" /> : null}
          {moving ? "Move server" : "Duplicate server"}
        </Button>
      </DialogFooter>
    </form>
  )
}

function ModeButton({
  checked,
  icon,
  label,
  onSelect,
  title,
}: {
  checked: boolean
  icon: React.ReactNode
  label: string
  onSelect: () => void
  title: string
}) {
  return (
    <Button
      aria-checked={checked}
      className="h-7 px-3 [&_svg]:size-3.5"
      role="radio"
      size="sm"
      title={title}
      type="button"
      variant={checked ? "default" : "ghost"}
      onClick={onSelect}
    >
      {icon}
      {label}
    </Button>
  )
}

// One side of before and after.
function Side({
  children,
  label,
}: {
  children: React.ReactNode
  label: string
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-1.5">
      <span className="type-label">{label}</span>
      {children}
    </div>
  )
}

// A box an identity sits in, as tall as the Relay picker beside it.
function CardBox({
  children,
  interactive = false,
}: {
  children: React.ReactNode
  interactive?: boolean
}) {
  return (
    <div
      className={cn(
        "flex h-12 min-w-0 items-center gap-1.5 rounded-md border px-2",
        interactive
          ? "border-input/90 bg-input/20 focus-within:border-ring/75 focus-within:ring-2 focus-within:ring-ring/40"
          : "border-border/60 bg-background/30"
      )}
    >
      {children}
    </div>
  )
}

function RelayCard({
  arch,
  freeBytes,
  id,
  name,
  tag,
}: {
  arch: string | null
  freeBytes: number | null
  id: string
  name: string
  tag?: Note | null
}) {
  return (
    <InstanceCard
      className="min-w-0 flex-1"
      instance={{ id, kind: "relay", relayId: id }}
      meta={[arch, freeBytes === null ? null : `${formatBytes(freeBytes)} free`]
        .filter(Boolean)
        .join(" · ")}
      metaClassName="font-mono"
      name={name}
      nameAccessory={
        tag ? (
          <span
            className={cn(
              "type-meta shrink-0 font-normal",
              tag.tone === "error"
                ? "text-destructive"
                : "text-muted-foreground"
            )}
          >
            {tag.text}
          </span>
        ) : null
      }
      showFavorite={false}
    />
  )
}

function relayTag(
  destination: ServerMigrationDestination,
  problems: ReadonlyArray<MigrationRoomProblem>
): Note | null {
  if (destination.problems.length) return { text: "Unavailable", tone: "error" }
  if (problems.length) return { text: "Not enough room", tone: "error" }
  if (destination.current) return { text: "This Relay", tone: "muted" }
  return null
}

function freeBytes(room: {
  rootsFreeBytes: number
  transferFreeBytes: number
}): number {
  return Math.min(room.rootsFreeBytes, room.transferFreeBytes)
}

// One line under a field, kept whether or not it has anything to say.
function Line({ note }: { note: Note | null }) {
  return (
    <p
      className={cn(
        "type-meta min-h-[1lh] truncate",
        note?.tone === "error" ? "text-destructive" : "text-muted-foreground"
      )}
      title={note?.text}
    >
      {note?.text}
    </p>
  )
}

// The copy's memory, CPU, and disk, each a slider with its value beside
// it. A stretch of track that won't fit is marked, and a limit that won't
// fit says why under it, with the nearest that would.
function LimitRows({
  destination,
  disabled,
  draft,
  onChange,
  original,
  problems,
  usedBytes,
}: {
  destination: ServerMigrationDestination | undefined
  disabled: boolean
  draft: ResourceLimitsDraft
  onChange: React.Dispatch<React.SetStateAction<ResourceLimitsDraft>>
  original: ResourceLimits
  problems: Partial<Record<LimitKind, MigrationRoomProblem>>
  usedBytes: number | null
}) {
  const room = destination?.room ?? null
  const relayName = destination?.name ?? "the Relay"
  const gib = (bytes: number | null) =>
    bytes === null ? null : bytes / GIBIBYTE
  const assignableMemory = gib(room?.assignableMemoryBytes ?? null)
  const assignableDisk = gib(room?.assignableDiskBytes ?? null)
  const files = gib(usedBytes)
  const cores = room?.cores ?? null

  const memoryMax = sliderMax(gib(original.memoryBytes), assignableMemory, 4)
  const diskMax = sliderMax(
    Math.max(gib(original.diskBytes) ?? 0, files ?? 0),
    assignableDisk,
    10
  )
  const cpuMax =
    cores ?? Math.max((original.cpuMillis ?? 0) / CPU_LIMIT_MILLIS_PER_CORE, 1)

  const set = (key: keyof ResourceLimitsDraft) => (value: ResourceLimitDraft) =>
    onChange((current) => ({ ...current, [key]: value }))
  const fit = (key: keyof ResourceLimitsDraft, value: number | null) =>
    value === null
      ? undefined
      : () => set(key)({ limited: true, value: String(value) })

  const memorySuggestion =
    room &&
    roundDown(room.assignableMemoryBytes, GIBIBYTE / 4) >=
      MINIMUM_MEMORY_LIMIT_BYTES
      ? roundDown(room.assignableMemoryBytes, GIBIBYTE / 4) / GIBIBYTE
      : null
  const smallestDisk = Math.max(
    usedBytes ?? 0,
    MINIMUM_INSTANCE_DISK_LIMIT_BYTES
  )
  const diskSuggestion = !room
    ? null
    : problems.disk?.code === "disk_files"
      ? roundUp(smallestDisk, GIBIBYTE) <= room.assignableDiskBytes
        ? roundUp(smallestDisk, GIBIBYTE) / GIBIBYTE
        : null
      : roundDown(room.assignableDiskBytes, GIBIBYTE) >= smallestDisk
        ? roundDown(room.assignableDiskBytes, GIBIBYTE) / GIBIBYTE
        : null
  const unknown = `${relayName} didn't say what it can assign`

  return (
    <Rows>
      <LimitRow
        disabled={disabled}
        fix={
          problems.memory && memorySuggestion !== null
            ? {
                label: `Use ${formatBytes(memorySuggestion * GIBIBYTE)}`,
                run: fit("memoryGiB", memorySuggestion),
              }
            : null
        }
        icon={<MemoryStick />}
        label="Memory"
        max={memoryMax}
        min={0.25}
        note={{
          text: room
            ? `${formatBytes(room.assignableMemoryBytes)} assignable on ${relayName}`
            : unknown,
          tone: problems.memory ? "error" : "muted",
          title: problems.memory?.message,
        }}
        step={0.25}
        unit="GiB"
        value={draft.memoryGiB}
        zones={
          assignableMemory === null
            ? []
            : [{ from: assignableMemory, to: Number.POSITIVE_INFINITY }]
        }
        onChange={set("memoryGiB")}
      />
      <LimitRow
        disabled={disabled}
        fix={
          problems.cpu && cores !== null
            ? { label: `Use ${cores}`, run: fit("cpuCores", cores) }
            : null
        }
        icon={<Cpu />}
        label="CPU"
        max={cpuMax}
        min={0.1}
        note={{
          text:
            cores === null
              ? unknown
              : `${cores} ${cores === 1 ? "core" : "cores"} on ${relayName}`,
          tone: problems.cpu ? "error" : "muted",
          title: problems.cpu?.message,
        }}
        step={0.1}
        unit="cores"
        value={draft.cpuCores}
        zones={[]}
        onChange={set("cpuCores")}
      />
      <LimitRow
        disabled={disabled}
        fix={
          problems.disk && diskSuggestion !== null
            ? {
                label: `Use ${formatBytes(diskSuggestion * GIBIBYTE)}`,
                run: fit("diskGiB", diskSuggestion),
              }
            : null
        }
        icon={<HardDrive />}
        label="Disk"
        max={diskMax}
        min={0.1}
        note={{
          text:
            problems.disk?.code === "disk_files" && usedBytes !== null
              ? `Its files take ${formatBytes(usedBytes)}`
              : room
                ? `${formatBytes(room.assignableDiskBytes)} assignable on ${relayName}`
                : unknown,
          tone: problems.disk ? "error" : "muted",
          title: problems.disk?.message,
        }}
        step={1}
        unit="GiB"
        value={draft.diskGiB}
        zones={[
          ...(files !== null && files > 0.1 ? [{ from: 0.1, to: files }] : []),
          ...(assignableDisk === null
            ? []
            : [{ from: assignableDisk, to: Number.POSITIVE_INFINITY }]),
        ]}
        onChange={set("diskGiB")}
      />
    </Rows>
  )
}

function LimitRow({
  disabled,
  fix,
  icon,
  label,
  max,
  min,
  note,
  onChange,
  step,
  unit,
  value,
  zones,
}: {
  disabled: boolean
  fix: { label: string; run: (() => void) | undefined } | null
  icon: React.ReactNode
  label: string
  max: number
  min: number
  note: Note & { title?: string | undefined }
  onChange: (value: ResourceLimitDraft) => void
  step: number
  unit: string
  value: ResourceLimitDraft
  zones: ReadonlyArray<SliderZone>
}) {
  const number = Number(value.value)
  const sliderValue =
    value.limited && Number.isFinite(number) ? Math.max(number, min) : max
  return (
    <div className="grid gap-0.5 px-3 py-1.5">
      <div className="flex items-center gap-3">
        <span className="type-label flex w-20 shrink-0 items-center gap-2 [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
          {icon}
          {label}
        </span>
        <Slider
          aria-label={`${label} limit`}
          className="min-w-0 flex-1"
          disabled={disabled || !value.limited}
          max={Math.max(max, sliderValue)}
          min={min}
          step={step}
          value={sliderValue}
          zones={zones}
          onValueChange={(next) =>
            onChange({ limited: true, value: String(Number(next.toFixed(2))) })
          }
        />
        <span className="flex w-24 shrink-0 items-center gap-1.5">
          <Input
            aria-label={`${label} limit in ${unit}`}
            className="h-8 w-14 px-2 text-right font-mono tabular-nums"
            disabled={disabled || !value.limited}
            inputMode="decimal"
            placeholder="∞"
            value={value.limited ? value.value : ""}
            onChange={(event) =>
              onChange({
                limited: true,
                value: event.currentTarget.value.replace(/[^\d.]/gu, ""),
              })
            }
          />
          <span className="type-meta text-muted-foreground">{unit}</span>
        </span>
        <Button
          aria-pressed={!value.limited}
          className="w-[4.75rem] shrink-0"
          disabled={disabled}
          size="xs"
          type="button"
          variant={value.limited ? "outline" : "default"}
          onClick={() => onChange({ ...value, limited: !value.limited })}
        >
          No limit
        </Button>
      </div>
      <p className="type-meta flex min-h-[1lh] min-w-0 items-center gap-2 pl-[5.75rem]">
        <span
          className={cn(
            "truncate",
            note.tone === "error" ? "text-destructive" : "text-muted-foreground"
          )}
          title={note.title ?? note.text}
        >
          {note.text}
        </span>
        {fix?.run ? (
          <button
            className="shrink-0 font-medium text-primary-ink underline-offset-2 hover:underline disabled:opacity-50"
            disabled={disabled}
            type="button"
            onClick={fix.run}
          >
            {fix.label}
          </button>
        ) : null}
      </p>
    </div>
  )
}

// Rows in one bordered list.
function Rows({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] divide-y divide-border/65 rounded-md border border-border/75 bg-background/45">
      {children}
    </div>
  )
}

// An option with a switch, and room for a control of its own beside it.
// It keeps to one line; its description is whole in its tooltip.
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
        "flex h-10 items-center gap-3 px-3",
        disabled && !checked && "opacity-60"
      )}
    >
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span
        className="flex min-w-0 flex-1 items-baseline gap-2"
        title={description}
      >
        <span className="type-label shrink-0">{label}</span>
        <span className="type-meta min-w-0 truncate text-muted-foreground">
          {description}
        </span>
      </span>
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
        className="h-7 w-32 shrink-0 *:data-[slot=select-value]:truncate"
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
              ? "Its backups are incremental, so they stay."
              : "Its backups are on this Relay or incremental, so they stay."
            : `They restore to the copy too.${
                staying > 0
                  ? ` ${staying} ${staying === 1 ? "stays" : "stay"} here.`
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
      ? `Kiln doesn't manage DNS; point yours at ${relayName}.`
      : "Kiln doesn't manage DNS here."
    : !names.length
      ? "This server has no managed domain."
      : !moving
        ? `${names.join(", ")} stays; the copy gets its own.`
        : `${names.join(", ")} points at ${relayName}.`
  return (
    <OptionRow
      checked={checked && preview.domains.managed && names.length > 0}
      description={description}
      disabled={disabled || !preview.domains.managed || !names.length}
      icon={<Globe />}
      label={names.length > 1 ? "Domains" : "Domain"}
      onCheckedChange={onCheckedChange}
    />
  )
}

function limitProblemsByField(
  problems: ReadonlyArray<MigrationRoomProblem>
): Partial<Record<LimitKind, MigrationRoomProblem>> {
  const byField: Partial<Record<LimitKind, MigrationRoomProblem>> = {}
  for (const problem of problems) {
    if (problem.code === "cpu") byField.cpu ??= problem
    if (problem.code === "memory") byField.memory ??= problem
    if (problem.code === "disk_limit" || problem.code === "disk_files") {
      byField.disk ??= problem
    }
  }
  return byField
}

// How far a slider reaches: twice the server's own value, or what the
// Relay can assign when that's further, rounded up to a whole number.
function sliderMax(
  value: number | null,
  assignable: number | null,
  floor: number
): number {
  const largest = Math.max(value ?? 0, floor / 2)
  const reach =
    assignable === null
      ? largest * 2
      : Math.max(Math.min(largest * 2, Math.max(assignable, largest)), largest)
  return Math.max(Math.ceil(reach), 1)
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
