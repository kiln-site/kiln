import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
  MINIMUM_MEMORY_LIMIT_BYTES,
  resourceLimitsEqual,
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
  TriangleAlert,
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
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"

import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import { InstanceCard } from "@/components/instance-card"
import {
  AppKindIcon,
  DatabaseKindIcon,
  VolumeKindIcon,
} from "@/components/instance-kind-icon"
import {
  InstancePickerContent,
  type InstancePickerItem,
} from "@/components/instance-picker"
import { ResourceLimitRows } from "@/components/resource-limits/resource-limit-rows"
import { LiveServerBrickIcon } from "@/components/server-brick-icon"
import { formatBytes } from "@/lib/format-bytes"
import type { MigratedKindName } from "@/lib/resource-migration-input"
import {
  parseResourceLimitsDraft,
  resourceLimitsDraft,
  type ResourceLimitsDraft,
} from "@/lib/resource-limits"
import {
  migrationRoomProblems,
  type MigrationRoomProblem,
} from "@/lib/resource-migration-room"
import {
  resourceMigrationPreviewQueryOptions,
  resourceMigrationsQueryOptions,
} from "@/lib/resource-migration-queries"
import type {
  ResourceMigrationDestination,
  ResourceMigrationPreview,
} from "@/server/resource-migrations.server"
import { startResourceMigration } from "@/server/resource-migrations"

export type ResourceMigrationMode = "duplicate" | "migrate"

/** What is being copied: a game server says which Brick's icon it wears. */
export type MigratedResource = {
  brickId?: string
  brickSource?: string
  id: string
  implementation?: string
  kind: MigratedKindName
  name: string
  relayId: string
}

// What copying each kind while it runs can miss, in its own words.
const liveRisk: Record<MigratedKindName, string> = {
  app: "What it writes while it's copied can be missed.",
  database: "What's written after the copy starts isn't carried.",
  instance: "A running world can be caught mid-save.",
  volume: "What's written while it's copied can be missed.",
}

// "a game server", "an App".
function aNoun(noun: string) {
  return `${/^[aeiou]/iu.test(noun) ? "an" : "a"} ${noun}`
}

type Tone = "error" | "muted" | "warning"
type Status = {
  fix?: { label: string; run: () => void }
  text: string
  tone: Tone
}

const GIBIBYTE = 1024 ** 3

/**
 * Copies a resource to a new one: a duplicate on any Relay the person may
 * create one on, or a move to another Relay. It starts the copy and closes;
 * the copy carries on in the background with a progress toast.
 *
 * It is one dialog for every kind. The resource and its Relay sit beside
 * the copy and where it goes, then the copy's limits and a few choices,
 * each shown only for a kind that has it. Explanations live in tooltips and
 * the metadata checklist; what's wrong takes one line, and what to know
 * first sits above the buttons.
 */
export function ResourceMigrationDialog({
  initialMode,
  onOpenChange,
  open,
  resource,
}: {
  initialMode: ResourceMigrationMode
  onOpenChange: (open: boolean) => void
  open: boolean
  resource: MigratedResource
}) {
  const [mode, setMode] = React.useState(initialMode)
  const preview = useQuery({
    ...resourceMigrationPreviewQueryOptions(resource),
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
            Copy {resource.name} to a new one, here or on another Relay.
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
              title="Keep this one too"
              onSelect={() => setMode("duplicate")}
            />
            <ModeButton
              checked={mode === "migrate"}
              icon={<ArrowRightLeft />}
              label="Move"
              title="Hand its place to the copy"
              onSelect={() => setMode("migrate")}
            />
          </div>
        </div>
        {preview.data ? (
          <MigrationForm
            mode={mode}
            preview={preview.data}
            resource={resource}
            onDone={() => onOpenChange(false)}
          />
        ) : preview.isPending ? (
          <div className="type-support flex h-[25rem] items-center justify-center gap-2 text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Checking where it can go…
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
  resource,
}: {
  mode: ResourceMigrationMode
  onDone: () => void
  preview: ResourceMigrationPreview
  resource: MigratedResource
}) {
  const { noun, offers } = preview
  const queryClient = useQueryClient()
  const moving = mode === "migrate"
  const destinations = React.useMemo(
    () =>
      preview.destinations.filter(
        (destination) => !moving || !destination.current
      ),
    [moving, preview.destinations]
  )

  // The copy's limits start as the old one's, for a kind whose copy can be
  // given its own.
  const sourceLimits = preview.source.limits ?? unlimited
  const sourceDraft = React.useMemo(
    () => resourceLimitsDraft(sourceLimits),
    [sourceLimits]
  )
  const [draft, setDraft] = React.useState(sourceDraft)
  const parsed = parseResourceLimitsDraft(draft, null)
  const limits = "limits" in parsed ? parsed.limits : null
  const limitsChanged =
    offers.limits &&
    limits !== null &&
    !resourceLimitsEqual(limits, sourceLimits)

  // Whether the copy fits there, as the Relays said when the dialog opened.
  // Checked again when it starts and before the old one stops.
  const roomProblemsFor = (
    destination: ResourceMigrationDestination
  ): ReadonlyArray<MigrationRoomProblem> =>
    destination.room && preview.room
      ? migrationRoomProblems({
          destination: destination.room,
          limits: true,
          localBackups: 0,
          noun,
          resource: {
            ...preview.room.resource,
            limits: limits ?? sourceLimits,
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
    name ??
    defaultName(
      resource.name,
      mode,
      selected?.takenNames ?? [],
      offers.nameLimit
    )

  const linkableBackups =
    selected && preview.allowed.linkBackups
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
  // Everything besides its data and settings comes along, or none of it.
  const [copyMetadata, setCopyMetadata] = React.useState(true)
  const copies = (key: MetadataKey) =>
    copyMetadata && metadata.find((item) => item.key === key)?.reason === null

  // Not the same as having none: a move now would leave its domains behind.
  const routesUnread =
    moving &&
    copyMetadata &&
    offers.handOvers.includes("routes") &&
    preview.webRoutes === null

  const [stopSource, setStopSource] = React.useState(
    preview.source.running && preview.allowed.power
  )

  const start = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("Choose a Relay")
      if (!limits) throw new Error("Check the copy's limits")
      return startResourceMigration({
        data: {
          destinationRelayId: selected.id,
          id: resource.id,
          kind: resource.kind,
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
          relayId: resource.relayId,
        },
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: resourceMigrationsQueryOptions().queryKey,
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
    routesUnread ||
    preview.source.provisioning ||
    (moving && offers.power && !preview.allowed.stop)

  const usedBytes =
    preview.room &&
    preview.room.resource.usedFrom !== "limit" &&
    preview.room.resource.usedFrom !== "unknown"
      ? preview.room.resource.usedBytes
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
                  text: `${selected.name} already has ${aNoun(noun)} named ${trimmedName}.`,
                  tone: "error",
                }
              : !trimmedName
                ? { text: "Give the copy a name.", tone: "error" }
                : preview.source.provisioning
                  ? {
                      text: "Still being created; copy it once it's ready.",
                      tone: "warning",
                    }
                  : moving && offers.power && !preview.allowed.stop
                    ? {
                        text: `A move stops this ${noun}, and you can't stop it.`,
                        tone: "error",
                      }
                    : routesUnread
                      ? {
                          text: `${preview.source.relayName} couldn't say which domains it has. Try again.`,
                          tone: "error",
                        }
                      : destinations.length === 0
                        ? {
                            text: moving
                              ? `No other Relay can take ${aNoun(noun)} from you.`
                              : `No Relay can take ${aNoun(noun)} from you.`,
                            tone: "warning",
                          }
                        : archMismatch && selected && resource.kind !== "volume"
                          ? {
                              text: `${selected.name} runs ${selected.nodeArch}; its image must support it.`,
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
          <ResourceCard
            meta={
              usedBytes === null
                ? resource.id.slice(0, 12)
                : `${formatBytes(usedBytes)} of ${resource.kind === "instance" ? "files" : "data"}`
            }
            resource={resource}
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
            <ResourceIcon resource={resource} />
          </span>
          <Input
            aria-invalid={nameTaken || !trimmedName}
            aria-label="The copy's name"
            className="h-8 min-w-0 border-0 bg-transparent px-1 text-xs font-semibold shadow-none focus-visible:ring-0 dark:bg-transparent"
            disabled={pending}
            maxLength={offers.nameLimit}
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

      {offers.limits ? (
        <section className="grid gap-2">
          <div className="flex h-5 items-center justify-between">
            <h3 className="type-technical-label text-muted-foreground">
              Limits
            </h3>
            <Button
              className={cn("h-5 px-1.5", !limitsChanged && "invisible")}
              disabled={pending}
              size="xs"
              title={`Use ${resource.name}'s limits`}
              type="button"
              variant="ghost"
              onClick={() => setDraft(sourceDraft)}
            >
              Reset
            </Button>
          </div>
          <ResourceLimitRows
            capacity={room}
            disabled={pending}
            diskFloorBytes={usedBytes}
            draft={draft}
            invalid={"error" in parsed ? parsed.field : null}
            original={sourceLimits}
            onChange={setDraft}
          />
        </section>
      ) : null}

      {metadata.length > 0 || offers.power ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-2 sm:grid-cols-2">
          {metadata.length > 0 ? (
            <SwitchRow
              checked={copyMetadata}
              disabled={pending}
              label="Copy metadata"
              info={<MetadataCard items={metadata} />}
              onCheckedChange={setCopyMetadata}
            />
          ) : null}
          {!offers.power ? null : offers.copiedRunning ? (
            // It has to run to be copied, so it's never stopped first.
            <SwitchRow
              checked={moving}
              disabled
              label={moving ? "Stop once the copy is ready" : "Keeps running"}
              title={
                moving
                  ? `It runs until its copy is in, then stops and stays stopped. ${liveRisk[resource.kind]}`
                  : `It runs while it's copied. ${liveRisk[resource.kind]}`
              }
              onCheckedChange={() => {}}
            />
          ) : (
            <SwitchRow
              checked={moving || (stopSource && preview.source.running)}
              disabled={
                pending ||
                moving ||
                !preview.allowed.power ||
                !preview.source.running
              }
              label={moving ? `Stop this ${noun}` : "Stop while copying"}
              title={
                moving
                  ? "A move always stops it, and it stays stopped."
                  : preview.source.running
                    ? `It starts again afterwards. ${liveRisk[resource.kind]}`
                    : "It isn't running."
              }
              onCheckedChange={setStopSource}
            />
          )}
        </div>
      ) : null}

      <MigrationWarnings warnings={preview.warnings[mode]} />

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

// Where the copy goes, picked from the Relays the person may create one of
// its kind on with the searchable picker used across Kiln. Each says whether
// the copy fits there.
function RelayPicker({
  destinations,
  disabled,
  onSelect,
  problemsFor,
  selected,
}: {
  destinations: ReadonlyArray<ResourceMigrationDestination>
  disabled: boolean
  onSelect: (relayId: string) => void
  problemsFor: (
    destination: ResourceMigrationDestination
  ) => ReadonlyArray<MigrationRoomProblem>
  selected: ResourceMigrationDestination | undefined
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
          emptyMessage="No Relay can take it from you"
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
  destination: ResourceMigrationDestination,
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
// What to know before copying this one this way: kept apart from what's
// wrong, which blocks it, and never more than its kind has to say.
function MigrationWarnings({ warnings }: { warnings: ReadonlyArray<string> }) {
  if (warnings.length === 0) return null
  return (
    <ul className="type-meta grid gap-1.5 border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-amber-200 light:text-amber-900">
      {warnings.map((warning) => (
        <li className="flex items-start gap-2" key={warning}>
          <TriangleAlert
            aria-hidden="true"
            className="mt-[0.15em] size-3.5 shrink-0"
          />
          <span>{warning}</span>
        </li>
      ))}
    </ul>
  )
}

// The old resource's card: an instance's as it shows everywhere, and a
// volume's, which is no instance, drawn to match.
function ResourceCard({
  meta,
  resource,
}: {
  meta: string
  resource: MigratedResource
}) {
  if (resource.kind === "volume") {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/70 bg-background/35">
          <VolumeKindIcon className="size-4" />
        </span>
        <span className="grid min-w-0">
          <span className="truncate text-xs font-semibold">
            {resource.name}
          </span>
          <span className="type-meta truncate text-muted-foreground">
            {meta}
          </span>
        </span>
      </div>
    )
  }
  return (
    <InstanceCard
      className="min-w-0 flex-1"
      instance={{
        brickId: resource.brickId,
        brickSource: resource.brickSource,
        id: resource.id,
        implementation: resource.implementation,
        kind: instanceKinds[resource.kind],
        relayId: resource.relayId,
      }}
      meta={meta}
      name={resource.name}
      showFavorite={false}
    />
  )
}

// The copy's icon, beside its name: a game server's Brick, else its kind.
function ResourceIcon({ resource }: { resource: MigratedResource }) {
  switch (resource.kind) {
    case "instance":
      return (
        <LiveServerBrickIcon
          brickId={resource.brickId}
          brickSource={resource.brickSource}
          implementation={resource.implementation ?? ""}
        />
      )
    case "database":
      return <DatabaseKindIcon className="size-4" />
    case "app":
      return <AppKindIcon className="size-4" />
    case "volume":
      return <VolumeKindIcon className="size-4" />
  }
}

// What each kind is called where instances are drawn.
const instanceKinds = {
  app: "app",
  database: "database",
  instance: "server",
} as const

const unlimited: ResourceLimits = {
  cpuMillis: null,
  diskBytes: null,
  memoryBytes: null,
}

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

// The suggestion for a limit that won't fit: the nearest that would.
function limitFix(
  problem: MigrationRoomProblem | undefined,
  room: ResourceMigrationDestination["room"] | null,
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

// What a copy can take besides its data and settings, of what its kind has
// at all, and why not when it can't.
function metadataItems({
  linkableBackups,
  moving,
  preview,
  relay,
}: {
  linkableBackups: number
  moving: boolean
  preview: ResourceMigrationPreview
  relay: ResourceMigrationDestination | undefined
}): ReadonlyArray<MetadataItem> {
  const { access, allowed, backups, domains, offers, webRoutes } = preview
  const items: ReadonlyArray<MetadataItem> = [
    {
      detail:
        access === 1
          ? "1 person, with the same permissions"
          : `${access} people, with the same permissions`,
      key: "access",
      label: "User access",
      reason: !allowed.copyAccess
        ? "You can't see who has access"
        : access === 0
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
      detail: `${webRoutes?.join(", ") ?? ""}, once DNS reaches ${relay?.name ?? "the new Relay"}`,
      key: "routes",
      label: "Web routes",
      reason: !moving
        ? "Only a move takes its web routes"
        : webRoutes === null
          ? "They couldn't be read"
          : !webRoutes.length
            ? "It has no web routes"
            : !allowed.network
              ? "Needs permission to change its network"
              : null,
    },
  ]
  return items.filter((item) =>
    item.key === "activity"
      ? offers.activity
      : offers.handOvers.includes(item.key)
  )
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

function defaultDestination(
  destinations: ReadonlyArray<ResourceMigrationDestination>,
  mode: ResourceMigrationMode,
  usable: (destination: ResourceMigrationDestination) => boolean
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

// A move keeps its name; a duplicate takes the first free
// "<name> copy", "<name> copy 2", … on its Relay.
function defaultName(
  name: string,
  mode: ResourceMigrationMode,
  taken: ReadonlyArray<string>,
  limit: number
) {
  if (mode === "migrate") return name.slice(0, limit)
  for (let index = 1; index < 100; index += 1) {
    const suffix = index === 1 ? " copy" : ` copy ${index}`
    const candidate = `${name.slice(0, limit - suffix.length)}${suffix}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${name.slice(0, limit - 5)} copy`
}
