import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CPU_LIMIT_MILLIS_PER_CORE,
  MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
  MINIMUM_MEMORY_LIMIT_BYTES,
  type ResourceLimits,
} from "@workspace/contracts"
import {
  ArrowRight,
  ArrowRightLeft,
  Check,
  ChevronsUpDown,
  Copy,
  Info,
  LoaderCircle,
  Minus,
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
import { Slider } from "@workspace/ui/components/slider"
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"

import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import { InstanceCard } from "@/components/instance-card"
import {
  InstancePickerContent,
  type InstancePickerItem,
} from "@/components/instance-picker"
import { LiveServerBrickIcon } from "@/components/server-brick-icon"
import { formatBytes } from "@/lib/format-bytes"
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

type Tone = "error" | "muted" | "warning"
type Status = {
  fix?: { label: string; run: () => void }
  text: string
  tone: Tone
}

const NAME_LIMIT = 32
const GIBIBYTE = 1024 ** 3

/**
 * Copies a game server to a new one: a duplicate on any Relay the person
 * may create servers on, or a move to another Relay. It starts the copy and
 * closes; the copy carries on in the background with a progress toast.
 *
 * The server and its Relay sit beside the copy and where it goes, then the
 * copy's limits and a few choices. Explanations live in tooltips and the
 * metadata checklist; what's wrong takes one line, so the dialog keeps its
 * size whatever is chosen.
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
    // Opened once the preview settled, it stays as it was while open: a
    // failure isn't asked again and grown into the form, nor a form swapped
    // for a failed refresh. Reopening asks again; starting checks it all.
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retryOnMount: false,
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-2xl">
        <div className="flex flex-wrap items-center justify-between gap-3 pr-10">
          <DialogTitle>Move or duplicate</DialogTitle>
          <DialogDescription className="sr-only">
            Copy {server.name} to a new game server, here or on another Relay.
          </DialogDescription>
          <div
            aria-label="What to do"
            className="grid grid-cols-2 gap-1 border border-border/75 bg-background/45 p-0.5"
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
        {preview.data ? (
          <MigrationForm
            mode={mode}
            preview={preview.data}
            server={server}
            onDone={() => onOpenChange(false)}
          />
        ) : preview.isPending ? (
          <div className="type-support flex h-[25rem] items-center justify-center gap-2 text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Checking where this server can go…
          </div>
        ) : (
          <p
            className="type-support flex h-[25rem] items-center justify-center text-destructive"
            role="alert"
          >
            {preview.error?.message}
          </p>
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

  // Whether the copy fits there, as the Relays said when the dialog opened.
  // Checked again when it starts and before the server stops.
  const roomProblemsFor = (
    destination: ServerMigrationDestination
  ): ReadonlyArray<MigrationRoomProblem> =>
    destination.room && preview.room
      ? migrationRoomProblems({
          destination: destination.room,
          limits: true,
          localBackups: 0,
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

  const linkableBackups =
    selected && selected.linksBackups && preview.allowed.linkBackups
      ? selected.current
        ? preview.backups.here
        : preview.backups.anywhere
      : 0
  const metadata = metadataItems({
    linkableBackups,
    moving,
    preview,
    relay: selected,
  })
  // Everything besides files and settings comes along, or none of it.
  const [copyMetadata, setCopyMetadata] = React.useState(true)
  const copies = (key: MetadataKey) =>
    copyMetadata && metadata.find((item) => item.key === key)?.reason === null

  const [stopSource, setStopSource] = React.useState(
    preview.source.running && preview.allowed.power
  )

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
            backup: null,
            copyAccess: copies("access"),
            deleteSource: null,
            keepActivity: copies("activity"),
            limits: limitsChanged ? limits : null,
            linkBackups: copies("backups"),
            moveDomain: copies("domains"),
            moveWebRoutes: copies("routes"),
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
  const limitProblem = roomProblems.find((problem) => problem.code !== "space")
  const spaceProblem = roomProblems.find((problem) => problem.code === "space")
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

  const usedBytes =
    preview.room && preview.room.server.usedFrom !== "limit"
      ? preview.room.server.usedBytes
      : null
  const room = selected?.room ?? null
  const fitFix = limitFix(limitProblem, room, usedBytes, (key, value) =>
    setDraft((current) => ({
      ...current,
      [key]: { limited: true, value: String(value) },
    }))
  )
  // Why the copy can't start, or what to know before it does.
  const status: Status | null = start.isError
    ? { text: start.error.message, tone: "error" }
    : "error" in parsed
      ? { text: parsed.error, tone: "error" }
      : limitProblem
        ? { fix: fitFix, text: limitProblem.message, tone: "error" }
        : relayProblem
          ? {
              text: `${relayProblem.message}. ${relayProblem.remedy}.`,
              tone: "error",
            }
          : spaceProblem
            ? { text: spaceProblem.message, tone: "error" }
            : nameTaken && selected
              ? {
                  text: `${selected.name} already has a ${trimmedName}.`,
                  tone: "error",
                }
              : !trimmedName
                ? { text: "Give the copy a name.", tone: "error" }
                : preview.source.provisioning
                  ? {
                      text: "Still being created; copy it once it's ready.",
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
                            ? "No other Relay can take game servers from you."
                            : "No Relay can take game servers from you.",
                          tone: "warning",
                        }
                      : archMismatch && selected
                        ? {
                            text: `${selected.name} runs ${selected.nodeArch}; the Brick's image must support it.`,
                            tone: "warning",
                          }
                        : null

  return (
    <form
      className="grid grid-cols-[minmax(0,1fr)] gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!blocked) start.mutate()
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
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
                : `${formatBytes(usedBytes)} of files`
            }
            name={server.name}
            showFavorite={false}
          />
        </CardBox>
        {/* A duplicate shows a copy above the arrow, which stays put. */}
        <span
          aria-hidden="true"
          className="relative hidden self-center text-muted-foreground sm:row-span-2 sm:block"
        >
          {moving ? null : (
            <Copy className="absolute bottom-full left-1/2 mb-1.5 size-3.5 -translate-x-1/2 text-primary-ink" />
          )}
          <ArrowRight className="size-4" />
        </span>
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
        <CardBox>
          <RelayCard
            arch={preview.source.nodeArch}
            freeBytes={preview.room ? freeBytes(preview.room.source) : null}
            id={preview.source.relayId}
            name={preview.source.relayName}
          />
        </CardBox>
        <RelayPicker
          destinations={destinations}
          disabled={pending || destinations.length === 0}
          problemsFor={roomProblemsFor}
          selected={selected}
          onSelect={setRelayId}
        />
      </div>

      <section className="grid gap-2">
        <div className="flex h-5 items-center justify-between">
          <h3 className="type-technical-label text-muted-foreground">Limits</h3>
          <Button
            className={cn("h-5 px-1.5", !limitsChanged && "invisible")}
            disabled={pending}
            size="xs"
            title={`Use ${server.name}'s limits`}
            type="button"
            variant="ghost"
            onClick={() => setDraft(sourceDraft)}
          >
            Reset
          </Button>
        </div>
        <LimitRows
          destination={selected}
          disabled={pending}
          draft={draft}
          original={preview.source.limits}
          usedBytes={usedBytes}
          onChange={setDraft}
        />
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-2 sm:grid-cols-2">
        <SwitchRow
          checked={copyMetadata}
          disabled={pending}
          label="Copy metadata"
          info={<MetadataCard items={metadata} />}
          onCheckedChange={setCopyMetadata}
        />
        <SwitchRow
          checked={moving || (stopSource && preview.source.running)}
          disabled={
            pending ||
            moving ||
            !preview.allowed.power ||
            !preview.source.running
          }
          label={moving ? "Stop this server" : "Stop while copying"}
          title={
            moving
              ? "A move always stops it, and it stays stopped."
              : preview.source.running
                ? "It starts again afterwards. A running world can be caught mid-save."
                : "It isn't running."
          }
          onCheckedChange={setStopSource}
        />
      </div>

      <DialogFooter className="items-center">
        <div className="min-w-0 sm:mr-auto">
          <StatusLine status={status} />
        </div>
        <Button
          disabled={pending}
          type="button"
          variant="outline"
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button
          className="min-w-32"
          disabled={blocked || pending}
          type="submit"
        >
          {pending ? <LoaderCircle className="animate-spin" /> : null}
          {moving ? "Move" : "Duplicate"}
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

// A box an identity sits in, as tall as the Relay picker.
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
        "flex h-11 min-w-0 items-center gap-1.5 rounded-md border px-2",
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
  tag?: { text: string; tone: Tone } | null
}) {
  return (
    <InstanceCard
      className="min-w-0 flex-1"
      instance={{ id, kind: "relay", relayId: id }}
      meta={[arch, freeBytes === null ? null : `${formatBytes(freeBytes)} free`]
        .filter(Boolean)
        .join(" · ")}
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

// Where the copy goes, picked from the Relays the person may create game
// servers on with the searchable picker used across Kiln. Each says whether
// the copy fits there.
function RelayPicker({
  destinations,
  disabled,
  onSelect,
  problemsFor,
  selected,
}: {
  destinations: ReadonlyArray<ServerMigrationDestination>
  disabled: boolean
  onSelect: (relayId: string) => void
  problemsFor: (
    destination: ServerMigrationDestination
  ) => ReadonlyArray<MigrationRoomProblem>
  selected: ServerMigrationDestination | undefined
}) {
  const [open, setOpen] = React.useState(false)
  const items: Array<InstancePickerItem> = destinations.map((destination) => {
    const tag = relayTag(destination, problemsFor(destination))
    return {
      identity: { id: destination.id, kind: "relay", relayId: destination.id },
      key: destination.id,
      meta: [
        destination.nodeArch,
        destination.room
          ? `${formatBytes(freeBytes(destination.room))} free`
          : null,
        tag?.text,
      ]
        .filter(Boolean)
        .join(" · "),
      name: destination.name,
      searchText: destination.id,
    }
  })
  const selectedKeys = React.useMemo(
    () => new Set(selected ? [selected.id] : []),
    [selected]
  )
  return (
    <DrawerPopover open={open} onOpenChange={setOpen}>
      <DrawerPopoverTrigger asChild>
        <button
          aria-expanded={open}
          aria-label="Relay"
          className="flex h-11 w-full min-w-0 items-center gap-2 rounded-md border border-input/90 bg-input/20 px-2 text-left transition-colors outline-none hover:bg-input/35 focus-visible:border-ring/75 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50"
          disabled={disabled}
          type="button"
        >
          {selected ? (
            <RelayCard
              arch={selected.nodeArch}
              freeBytes={selected.room ? freeBytes(selected.room) : null}
              id={selected.id}
              name={selected.name}
              tag={relayTag(selected, problemsFor(selected))}
            />
          ) : (
            <span className="type-label flex-1 text-muted-foreground">
              No Relay available
            </span>
          )}
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DrawerPopoverTrigger>
      <DrawerPopoverContent
        align="start"
        className="w-[min(26rem,calc(100vw-2rem))] overflow-hidden p-0"
        title="Choose a Relay"
      >
        <InstancePickerContent
          ariaLabel="Relays"
          emptyMessage="No Relay can take game servers from you"
          includeKindGroups={false}
          items={items}
          selectedKeys={selectedKeys}
          onSelect={(item) => {
            onSelect(item.key)
            setOpen(false)
          }}
        />
      </DrawerPopoverContent>
    </DrawerPopover>
  )
}

function relayTag(
  destination: ServerMigrationDestination,
  problems: ReadonlyArray<MigrationRoomProblem>
): { text: string; tone: Tone } | null {
  if (destination.problems.length) return { text: "Unavailable", tone: "error" }
  if (problems.length) return { text: "Won't fit", tone: "error" }
  if (destination.current) return { text: "This Relay", tone: "muted" }
  return null
}

function freeBytes(room: {
  rootsFreeBytes: number
  transferFreeBytes: number
}): number {
  return Math.min(room.rootsFreeBytes, room.transferFreeBytes)
}

// One line, kept whether or not it has anything to say.
function StatusLine({ status }: { status: Status | null }) {
  return (
    <p className="type-meta flex min-h-[1lh] min-w-0 items-center gap-2">
      <span
        className={cn(
          "truncate",
          status?.tone === "error"
            ? "text-destructive"
            : status?.tone === "warning"
              ? "text-amber-300 light:text-amber-800"
              : "text-muted-foreground"
        )}
        role={status?.tone === "error" ? "alert" : undefined}
        title={status?.text}
      >
        {status?.text}
      </span>
      {status?.fix ? (
        <button
          className="shrink-0 font-medium text-primary-ink underline-offset-2 hover:underline"
          type="button"
          onClick={status.fix.run}
        >
          {status.fix.label}
        </button>
      ) : null}
    </p>
  )
}

// The copy's memory, CPU, and disk: a slider each, on a log scale from the
// smallest useful limit to what the Relay can assign, notched and labeled
// along its axis, with a last stop past the end for no limit. The old
// server's limit is marked, and what the Relay can't follow is shaded red.
function LimitRows({
  destination,
  disabled,
  draft,
  onChange,
  original,
  usedBytes,
}: {
  destination: ServerMigrationDestination | undefined
  disabled: boolean
  draft: ResourceLimitsDraft
  onChange: React.Dispatch<React.SetStateAction<ResourceLimitsDraft>>
  original: ResourceLimits
  usedBytes: number | null
}) {
  const room = destination?.room ?? null
  const gib = (bytes: number | null) =>
    bytes === null ? null : bytes / GIBIBYTE
  const set = (key: keyof ResourceLimitsDraft) => (value: ResourceLimitDraft) =>
    onChange((current) => ({ ...current, [key]: value }))
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)_5.5rem] items-start gap-x-3 gap-y-3">
      <LimitRow
        assignable={gib(room?.assignableMemoryBytes ?? null)}
        disabled={disabled}
        fallbackMax={16}
        label="Memory"
        min={0.25}
        original={gib(original.memoryBytes)}
        scale={1}
        step={(value) => (value < 4 ? 0.25 : value < 16 ? 0.5 : 1)}
        unit="GiB"
        value={draft.memoryGiB}
        onChange={set("memoryGiB")}
      />
      <LimitRow
        assignable={room ? room.cores * 100 : null}
        disabled={disabled}
        fallbackMax={400}
        label="CPU"
        decimals={false}
        min={10}
        original={
          original.cpuMillis === null
            ? null
            : (original.cpuMillis / CPU_LIMIT_MILLIS_PER_CORE) * 100
        }
        scale={100}
        step={(value) => (value < 100 ? 5 : value < 400 ? 10 : 25)}
        unit="%"
        value={draft.cpuCores}
        onChange={set("cpuCores")}
      />
      <LimitRow
        assignable={gib(room?.assignableDiskBytes ?? null)}
        below={gib(usedBytes)}
        disabled={disabled}
        fallbackMax={100}
        decimals={false}
        label="Disk"
        min={1}
        original={gib(original.diskBytes)}
        scale={1}
        step={() => 1}
        unit="GiB"
        value={draft.diskGiB}
        onChange={set("diskGiB")}
      />
    </div>
  )
}

// Slider positions: the axis runs 0 to AXIS, and NO_LIMIT is the stop past
// its end; anything past halfway to it snaps there.
const AXIS = 1000
const NO_LIMIT = 1200

function LimitRow({
  assignable,
  below = null,
  decimals = true,
  disabled,
  fallbackMax,
  label,
  min,
  onChange,
  original,
  scale,
  step,
  unit,
  value,
}: {
  /** What the Relay can give, shown as the axis's end; null if unknown. */
  assignable: number | null
  /** A value the limit can't go under, shaded red, such as the files. */
  below?: number | null
  /** Whether the limit takes fractions, as memory does; else whole units. */
  decimals?: boolean
  disabled: boolean
  fallbackMax: number
  label: string
  min: number
  onChange: (value: ResourceLimitDraft) => void
  original: number | null
  /** Shown units per stored unit, as percent per core. */
  scale: number
  step: (value: number) => number
  unit: string
  value: ResourceLimitDraft
}) {
  const stored = Number(value.value)
  const current =
    value.limited && value.value.trim() !== "" && Number.isFinite(stored)
      ? stored * scale
      : null
  // The axis ends at what the Relay can assign, or further when the old
  // server's limit or the value already does.
  const max = Math.max(
    assignable ?? fallbackMax,
    original ?? 0,
    current ?? 0,
    min * 2
  )
  const span = Math.log(max / min)
  const position = (shown: number) =>
    (AXIS * Math.log(Math.max(shown, min) / min)) / span
  const snap = (shown: number) => {
    const size = step(shown)
    const near = Math.round(shown / size) * size
    return Number(
      (near > max ? Math.floor(shown / size) * size : near).toFixed(4)
    )
  }
  const ticks = [
    ...axisTicks(min, max).map((tick) => ({
      label: formatAxis(tick, unit),
      value: position(tick),
    })),
    { label: "No limit", value: NO_LIMIT },
  ]
  const zones = [
    ...(below !== null && below > min
      ? [{ from: 0, to: position(below) }]
      : []),
    ...(assignable !== null && assignable < max
      ? [{ from: position(assignable), to: AXIS }]
      : []),
  ]
  return (
    <>
      <span className="type-label flex h-7 items-center">{label}</span>
      <Slider
        aria-label={`${label} limit`}
        disabled={disabled}
        valueText={() =>
          !value.limited
            ? "No limit"
            : current === null
              ? "Not set"
              : `${decimals ? Number(current.toFixed(2)) : Math.round(current)} ${unit === "%" ? "percent" : unit}`
        }
        marks={[original === null ? NO_LIMIT : position(original)]}
        max={NO_LIMIT}
        min={0}
        step={1}
        ticks={ticks}
        value={
          !value.limited
            ? NO_LIMIT
            : current === null
              ? 0
              : Math.min(position(current), AXIS)
        }
        zones={zones}
        className="pt-1.5"
        onValueChange={(next, reason) => {
          const limitTo = (shown: number) =>
            onChange({
              limited: true,
              value: String(Number((shown / scale).toFixed(4))),
            })
          if (reason === "keyboard") {
            // A key moves one snapped value, and past the axis's end, or
            // back from it, to no limit and the largest limit.
            const sliderAt = !value.limited
              ? NO_LIMIT
              : current === null
                ? 0
                : position(current)
            if (next <= 0) return limitTo(min)
            if (next >= NO_LIMIT && next > sliderAt) {
              return onChange({ ...value, limited: false })
            }
            if (!value.limited) {
              const largest = Math.floor(max / step(max)) * step(max)
              return limitTo(Number(largest.toFixed(4)))
            }
            const at = current ?? min
            const up = next > sliderAt
            // Going down from a tier's first value takes the tier below.
            const size = step(up ? at : at * (1 - 1e-9))
            const stepped = Number(
              (up
                ? Math.floor(at / size + 1e-9) * size + size
                : Math.ceil(at / size - 1e-9) * size - size
              ).toFixed(4)
            )
            if (stepped > max) return onChange({ ...value, limited: false })
            return limitTo(Math.max(stepped, min))
          }
          if (next > (AXIS + NO_LIMIT) / 2) {
            return onChange({ ...value, limited: false })
          }
          limitTo(snap(min * Math.exp((Math.min(next, AXIS) / AXIS) * span)))
        }}
      />
      <label className="relative">
        <Input
          aria-label={`${label} limit in ${unit}`}
          className={cn(
            "h-7 pl-2 text-right font-mono text-xs tabular-nums",
            value.limited ? "pr-9" : "pr-2"
          )}
          disabled={disabled}
          inputMode={decimals ? "decimal" : "numeric"}
          value={
            !value.limited
              ? "No limit"
              : scale === 1 || current === null
                ? value.value
                : // A whole-number limit shows whole, so typing into a
                  // fraction like 123.4% can't run its digits together.
                  String(
                    decimals ? Number(current.toFixed(2)) : Math.round(current)
                  )
          }
          onChange={(event) => {
            const typed = event.currentTarget.value.replace(
              decimals ? /[^\d.]/gu : /\D/gu,
              ""
            )
            onChange({
              limited: true,
              value:
                typed === "" || scale === 1
                  ? typed
                  : String(Number(typed) / scale),
            })
          }}
        />
        {value.limited ? (
          <span className="type-meta pointer-events-none absolute inset-y-0 right-2 flex items-center text-muted-foreground">
            {unit}
          </span>
        ) : null}
      </label>
    </>
  )
}

// Round values along a log axis: 1, 2, and 5 of each power of ten, or only
// the powers when that's too many, with both ends, dropping any too close
// to a neighbour to label.
function axisTicks(min: number, max: number): Array<number> {
  const candidates: Array<number> = []
  for (
    let exponent = Math.floor(Math.log10(min));
    10 ** exponent <= max;
    exponent += 1
  ) {
    for (const factor of [1, 2, 5]) {
      const value = Number((factor * 10 ** exponent).toPrecision(3))
      if (value > min && value < max) candidates.push(value)
    }
  }
  const round =
    candidates.length > 4
      ? candidates.filter((value) => Number.isInteger(Math.log10(value)))
      : candidates
  const span = Math.log(max / min)
  const ticks = [min]
  for (const value of [...round, max]) {
    const previous = ticks[ticks.length - 1] ?? min
    if (Math.log(value / previous) / span >= 0.12) ticks.push(value)
    else if (value === max) ticks[ticks.length - 1] = max
  }
  return ticks
}

function formatAxis(value: number, unit: string): string {
  const number = Number(value.toFixed(value < 1 ? 2 : value < 10 ? 1 : 0))
  return unit === "%" ? `${number}%` : String(number)
}

// The suggestion for a limit that won't fit: the nearest that would.
function limitFix(
  problem: MigrationRoomProblem | undefined,
  room: ServerMigrationDestination["room"] | null,
  usedBytes: number | null,
  set: (key: keyof ResourceLimitsDraft, value: number) => void
): Status["fix"] {
  if (!problem || !room) return undefined
  if (problem.code === "cpu") {
    return {
      label: `Use ${room.cores * 100}%`,
      run: () => set("cpuCores", room.cores),
    }
  }
  if (problem.code === "memory") {
    const bytes = roundDown(room.assignableMemoryBytes, GIBIBYTE / 4)
    return bytes >= MINIMUM_MEMORY_LIMIT_BYTES
      ? {
          label: `Use ${formatBytes(bytes)}`,
          run: () => set("memoryGiB", bytes / GIBIBYTE),
        }
      : undefined
  }
  const smallest = Math.max(usedBytes ?? 0, MINIMUM_INSTANCE_DISK_LIMIT_BYTES)
  const bytes =
    problem.code === "disk_files"
      ? roundUp(smallest, GIBIBYTE)
      : roundDown(room.assignableDiskBytes, GIBIBYTE)
  return bytes >= smallest && bytes <= room.assignableDiskBytes
    ? {
        label: `Use ${formatBytes(bytes)}`,
        run: () => set("diskGiB", bytes / GIBIBYTE),
      }
    : undefined
}

type MetadataKey = "access" | "activity" | "backups" | "domains" | "routes"

type MetadataItem = {
  detail: string
  key: MetadataKey
  label: string
  /** Why it can't come along; null when it can. */
  reason: string | null
}

// What a copy can take besides its files and settings, and why not when
// it can't.
function metadataItems({
  linkableBackups,
  moving,
  preview,
  relay,
}: {
  linkableBackups: number
  moving: boolean
  preview: ServerMigrationPreview
  relay: ServerMigrationDestination | undefined
}): ReadonlyArray<MetadataItem> {
  const { allowed, backups, domains, webRoutes } = preview
  return [
    {
      detail:
        preview.accessCount === 1
          ? "1 person, with the same permissions"
          : `${preview.accessCount} people, with the same permissions`,
      key: "access",
      label: "User access",
      reason: !allowed.copyAccess
        ? "You can't see who has access"
        : preview.accessCount === 0
          ? "Only its owner has access"
          : null,
    },
    {
      detail:
        linkableBackups === 1
          ? "1 full backup, linked to the copy"
          : `${linkableBackups} full backups, linked to the copy`,
      key: "backups",
      label: "Backups",
      reason:
        backups.total === 0
          ? "It has no backups"
          : !allowed.linkBackups
            ? "Needs permission to download its backups"
            : relay && !relay.linksBackups
              ? `Update ${relay.name} to link backups`
              : linkableBackups === 0
                ? relay?.current
                  ? "Its backups are incremental"
                  : "Its backups are on this Relay or incremental"
                : null,
    },
    {
      detail: "Its history, up to the copy",
      key: "activity",
      label: "Activity history",
      reason: null,
    },
    {
      detail: `${domains.names.join(", ")}, pointed at ${relay?.name ?? "the new Relay"}`,
      key: "domains",
      label: "Domains",
      reason: !moving
        ? "Only a move takes its domains"
        : !domains.managed
          ? "Kiln doesn't manage DNS without Cloudflare"
          : !domains.names.length
            ? "It has no managed domain"
            : !allowed.network
              ? "Needs permission to change its network"
              : null,
    },
    {
      detail: `${webRoutes.join(", ")}, once DNS reaches ${relay?.name ?? "the new Relay"}`,
      key: "routes",
      label: "Web routes",
      reason: !moving
        ? "Only a move takes its web routes"
        : !webRoutes.length
          ? "It has no web routes"
          : !allowed.network
            ? "Needs permission to change its network"
            : null,
    },
  ]
}

// A label and its switch, the label's explanation in a tooltip or, with
// `info`, in a card behind an info button.
function SwitchRow({
  checked,
  disabled,
  info,
  label,
  onCheckedChange,
  title,
}: {
  checked: boolean
  disabled: boolean
  info?: React.ReactNode
  label: string
  onCheckedChange: (checked: boolean) => void
  title?: string
}) {
  const [infoOpen, setInfoOpen] = React.useState(false)
  return (
    <div
      className={cn(
        "flex h-8 min-w-0 items-center justify-between gap-3",
        disabled && !checked && "opacity-60"
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5" title={title}>
        <span className="type-label truncate">{label}</span>
        {info ? (
          <DrawerPopover open={infoOpen} onOpenChange={setInfoOpen}>
            <DrawerPopoverTrigger asChild>
              <button
                aria-label={`What ${label.toLowerCase()} includes`}
                className="grid size-5 place-items-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                type="button"
              >
                <Info className="size-3.5" />
              </button>
            </DrawerPopoverTrigger>
            <DrawerPopoverContent
              align="start"
              className="w-80 p-0"
              title={`What ${label.toLowerCase()} includes`}
            >
              {info}
            </DrawerPopoverContent>
          </DrawerPopover>
        ) : null}
      </span>
      <Switch
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  )
}

// What copying metadata takes along: a check for each part that comes, and
// why not for each that can't.
function MetadataCard({ items }: { items: ReadonlyArray<MetadataItem> }) {
  return (
    <div className="py-1.5">
      <p className="type-technical-label px-3 pb-1 text-[0.6875rem] text-muted-foreground">
        Comes along
      </p>
      {items.map((item) => (
        <div key={item.key} className="flex items-start gap-2.5 px-3 py-1.5">
          {item.reason === null ? (
            <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-400 light:text-emerald-700" />
          ) : (
            <Minus className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0">
            <span
              className={cn(
                "type-label block",
                item.reason !== null && "text-muted-foreground"
              )}
            >
              {item.label}
            </span>
            <span className="type-meta block text-muted-foreground">
              {item.reason ?? item.detail}
            </span>
          </span>
        </div>
      ))}
    </div>
  )
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
