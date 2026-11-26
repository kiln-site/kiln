import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
  MINIMUM_MEMORY_LIMIT_BYTES,
  resourceLimitsEqual,
  type ResourceLimits,
} from "@workspace/contracts"
import {
  Archive,
  ArrowRight,
  ArrowRightLeft,
  ChevronsUpDown,
  Copy,
  Globe2,
  HardDrive,
  History,
  Info,
  LoaderCircle,
  TriangleAlert,
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
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"

import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import { SubjectIcon } from "@/components/icon-image"
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
  resourceMigrationServingQueryOptions,
  resourceMigrationsQueryOptions,
} from "@/lib/resource-migration-queries"
import type { MigrationNote } from "@/lib/resource-migration-kinds/kind.server"
import type { RelayWebServing } from "@/server/relay-web-serving.server"
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

const undeployedNote: MigrationNote = {
  text: "The copy isn't deployed: deploy it once you've checked its settings. Domains that move with it don't answer until then.",
  warns: true,
}

// They name the old one, which stays where it is, stopped.
const schedulesNote = (schedules: ReadonlyArray<string>): MigrationNote => ({
  text:
    schedules.length === 1
      ? `The schedule “${schedules[0]}” still runs on the old one. Point it at the copy.`
      : `${schedules.length} schedules still run on the old one: ${schedules.join(", ")}. Point them at the copy.`,
  warns: true,
})

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
 * the copy and where it goes, with what that Relay can't do under it; then
 * the copy's limits, what comes along, each with its own switch and each
 * domain with what becomes of it, and a few choices, each shown only for a
 * kind that has it. What's wrong takes one line, and what to know first sits
 * above the buttons, only what bites standing out.
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
  const carried = carriedItems({ linkableBackups, moving, preview })
  // Everything that can come along does, unless it's turned off.
  const [left, setLeft] = React.useState<ReadonlySet<CarriedKey>>(new Set())
  const takes = (key: CarriedKey) =>
    !left.has(key) && carried.find((item) => item.key === key)?.reason === null
  const toggle = React.useCallback((key: CarriedKey, taken: boolean) => {
    setLeft((current) => {
      const next = new Set(current)
      if (taken) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // Not the same as having none: a move now would leave its domains behind.
  const routesUnread =
    moving &&
    !left.has("domains") &&
    offers.handOvers.includes("routes") &&
    preview.webRoutes === null
  const takesDomains = moving && takes("domains")
  // Whether they'd work there takes reaching it from outside, so it's asked
  // of the Relay chosen, and nothing waits for it.
  const serving = useQuery({
    ...resourceMigrationServingQueryOptions(resource, selected?.id ?? ""),
    enabled: takesDomains && selected !== undefined && webNames(preview) > 0,
  })

  const [stopSource, setStopSource] = React.useState(
    preview.source.running && preview.allowed.power
  )

  // A move deploys the copy first, so what's handed over goes to one that
  // runs. One that isn't running isn't deployed.
  const offersDeploy = moving && offers.deploy
  const [deployCopy, setDeployCopy] = React.useState(preview.source.deploys)
  const notes: ReadonlyArray<MigrationNote> = [
    ...(offersDeploy && !deployCopy ? [undeployedNote] : []),
    ...(moving && preview.schedules.length > 0
      ? [schedulesNote(preview.schedules)]
      : []),
    ...preview.warnings[mode],
  ]

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
            copyAccess: takes("access"),
            deleteSource: null,
            deployCopy: offersDeploy && deployCopy,
            keepActivity: takes("activity"),
            limits: limitsChanged ? limits : null,
            linkBackups: takes("backups"),
            moveDomain: takesDomains && gameNames(preview).length > 0,
            moveWebRoutes: takesDomains && webNames(preview) > 0,
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
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-flow-col sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:grid-rows-[auto_auto]">
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
        <CardBox>
          <RelayCard
            arch={preview.source.nodeArch}
            freeBytes={preview.room ? freeBytes(preview.room.source) : null}
            id={preview.source.relayId}
            name={preview.source.relayName}
          />
        </CardBox>
        {/* A duplicate shows a copy above the arrow, which stays put. */}
        <span
          aria-hidden="true"
          className="relative place-self-center text-muted-foreground max-sm:rotate-90 sm:row-span-2"
        >
          {moving ? null : (
            <Copy className="absolute bottom-full left-1/2 mb-1.5 size-3.5 -translate-x-1/2 text-primary-ink max-sm:hidden" />
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
        <RelayPicker
          destinations={destinations}
          disabled={pending || destinations.length === 0}
          problemsFor={roomProblemsFor}
          selected={selected}
          onSelect={setRelayId}
        />
        {takesDomains && selected && webNames(preview) > 0 ? (
          <RelayNotice
            checking={serving.isFetching && !serving.data}
            relayName={selected.name}
            serving={serving.data}
          />
        ) : null}
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

      <CarriedList
        domains={
          takesDomains
            ? domainFates({
                deploys: offersDeploy && deployCopy,
                preview,
                relayName: selected?.name ?? "the new Relay",
                serving: serving.data,
              })
            : []
        }
        items={carried}
        left={left}
        moving={moving}
        pending={pending}
        usedBytes={usedBytes}
        onToggle={toggle}
      />

      {offers.power ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-2 sm:grid-cols-2">
          {offers.copiedRunning ? (
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
          {offersDeploy ? (
            <SwitchRow
              checked={deployCopy}
              disabled={pending || !preview.source.running}
              label="Deploy the copy"
              title={
                preview.source.running
                  ? `It runs on the new Relay before anything is handed to it. If it doesn't start, this ${noun} starts again and nothing moves.`
                  : "It isn't running."
              }
              onCheckedChange={setDeployCopy}
            />
          ) : null}
        </div>
      ) : null}

      <MigrationNotes notes={notes} />

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

// What to know before copying this one this way, kept apart from what's wrong,
// which blocks it. What bites stands out from what's only worth knowing.
function MigrationNotes({ notes }: { notes: ReadonlyArray<MigrationNote> }) {
  const warnings = notes.filter((note) => typeof note !== "string")
  const asides = notes.filter((note) => typeof note === "string")
  if (notes.length === 0) return null
  return (
    <div className="grid gap-2">
      {warnings.length > 0 ? (
        <ul className="type-meta grid gap-1.5 border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-amber-200 light:text-amber-900">
          {warnings.map((note) => (
            <li className="flex items-start gap-2" key={note.text}>
              <TriangleAlert
                aria-hidden="true"
                className="mt-[0.15em] size-3.5 shrink-0"
              />
              <span>{note.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {asides.length > 0 ? (
        <ul className="type-meta grid gap-1 px-0.5 text-muted-foreground">
          {asides.map((note) => (
            <li className="flex items-start gap-2" key={note}>
              <Info
                aria-hidden="true"
                className="mt-[0.15em] size-3.5 shrink-0"
              />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

// Under the Relay chosen: what becomes of domains there, when not simply
// that they work. Its line stays while it's checked, so nothing moves.
function RelayNotice({
  checking,
  relayName,
  serving,
}: {
  checking: boolean
  relayName: string
  serving: RelayWebServing | undefined
}) {
  const bad = serving?.state === "cant" || serving?.state === "unreachable"
  const text = checking
    ? `Checking whether ${relayName} can serve its domains…`
    : serving?.state === "serves"
      ? `${relayName} answers at ${serving.host}`
      : serving?.state === "cant"
        ? `${serving.reason}. Its domains are set up there, and their DNS stays where it is until it can.`
        : serving?.state === "unreachable"
          ? `${serving.reason}. Its domains won't work there until something does.`
          : serving?.reason
            ? `${serving.reason}.`
            : null
  return (
    <p
      aria-live="polite"
      className={cn(
        "type-meta flex min-h-[1lh] items-start gap-2 sm:col-span-3 sm:col-start-1 sm:row-start-3",
        bad ? "text-amber-300 light:text-amber-800" : "text-muted-foreground"
      )}
    >
      {checking ? (
        <LoaderCircle
          aria-hidden="true"
          className="mt-[0.15em] size-3.5 shrink-0 animate-spin"
        />
      ) : bad ? (
        <TriangleAlert
          aria-hidden="true"
          className="mt-[0.15em] size-3.5 shrink-0"
        />
      ) : text ? (
        <Globe2 aria-hidden="true" className="mt-[0.15em] size-3.5 shrink-0" />
      ) : null}
      <span>{text}</span>
    </p>
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
      return (
        <SubjectIcon
          fallback={<AppKindIcon className="size-4" />}
          subject={{ id: resource.id, kind: "app", relayId: resource.relayId }}
        />
      )
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

type CarriedKey = "access" | "activity" | "backups" | "domains"

type CarriedItem = {
  detail: string
  icon: React.ReactNode
  key: CarriedKey
  label: string
  /** Why it can't come along; null when it can. */
  reason: string | null
}

/** A domain, and what becomes of it. */
type DomainFate = { name: string; text: string; warns: boolean }

// A game server's join addresses, which Kiln moves only where it keeps DNS.
const gameNames = (preview: ResourceMigrationPreview) =>
  preview.domains.managed ? preview.domains.names : []

const webNames = (preview: ResourceMigrationPreview) =>
  preview.webRoutes?.length ?? 0

// What a copy can take besides its data and settings, of what this one has,
// and why not when it can't. What it has none of isn't listed.
function carriedItems({
  linkableBackups,
  moving,
  preview,
}: {
  linkableBackups: number
  moving: boolean
  preview: ResourceMigrationPreview
}): ReadonlyArray<CarriedItem> {
  const { access, allowed, backups, offers } = preview
  const names = gameNames(preview).length + webNames(preview)
  const items: Array<CarriedItem> = []
  if (
    moving &&
    (offers.handOvers.includes("routes") ||
      offers.handOvers.includes("domains")) &&
    (names > 0 || preview.webRoutes === null)
  ) {
    items.push({
      detail: names === 1 ? "1 domain" : `${names} domains`,
      icon: <Globe2 />,
      key: "domains",
      label: "Domains",
      reason:
        preview.webRoutes === null
          ? "They couldn't be read"
          : !allowed.network
            ? "Needs permission to change its network"
            : null,
    })
  }
  if (offers.handOvers.includes("access") && access > 0) {
    items.push({
      detail:
        access === 1
          ? "1 person, with the same permissions"
          : `${access} people, with the same permissions`,
      icon: <Users />,
      key: "access",
      label: "User access",
      reason: allowed.copyAccess ? null : "You can't see who has access",
    })
  }
  if (offers.handOvers.includes("backups") && backups.total > 0) {
    items.push({
      detail:
        linkableBackups === 1
          ? "1 full backup, linked to the copy"
          : `${linkableBackups} full backups, linked to the copy`,
      icon: <Archive />,
      key: "backups",
      label: "Backups",
      reason: !allowed.linkBackups
        ? "Needs permission to download its backups"
        : linkableBackups === 0
          ? "Its backups are incremental, or on its own Relay"
          : null,
    })
  }
  if (offers.activity) {
    items.push({
      detail: "Its history, up to the copy",
      icon: <History />,
      key: "activity",
      label: "Activity history",
      reason: null,
    })
  }
  return items
}

// What becomes of each domain: where its DNS goes by itself, and when, or
// what's left for someone to do.
function domainFates({
  deploys,
  preview,
  relayName,
  serving,
}: {
  deploys: boolean
  preview: ResourceMigrationPreview
  relayName: string
  serving: RelayWebServing | undefined
}): ReadonlyArray<DomainFate> {
  const manual = new Set(preview.manualDns)
  const web = (preview.webRoutes ?? []).map((name): DomainFate => {
    if (manual.has(name)) {
      return {
        name,
        text: `You point it at ${serving?.host ?? relayName}`,
        warns: false,
      }
    }
    switch (serving?.state) {
      case "cant":
        return { name, text: "DNS waits", warns: true }
      case "unreachable":
        return { name, text: "Won't answer yet", warns: true }
      default:
        return {
          name,
          text: deploys
            ? serving?.state === "unchecked"
              ? "DNS switches once the copy runs"
              : "DNS switches once the copy answers"
            : "DNS switches when it's moved",
          warns: false,
        }
    }
  })
  const game = gameNames(preview).map((name): DomainFate => ({
    name,
    text: "DNS switches when it's moved",
    warns: false,
  }))
  return [
    ...game,
    ...web.filter(({ name }) => !game.some((g) => g.name === name)),
  ]
}

// What comes along: its data and settings always, and each other thing it
// has with a switch of its own. A domain says what becomes of it.
function CarriedList({
  domains,
  items,
  left,
  moving,
  onToggle,
  pending,
  usedBytes,
}: {
  domains: ReadonlyArray<DomainFate>
  items: ReadonlyArray<CarriedItem>
  left: ReadonlySet<CarriedKey>
  moving: boolean
  onToggle: (key: CarriedKey, taken: boolean) => void
  pending: boolean
  usedBytes: number | null
}) {
  return (
    <section className="grid gap-2">
      <h3 className="type-technical-label text-muted-foreground">
        {moving ? "Moves with it" : "Copies with it"}
      </h3>
      <div className="rounded-md border border-border/60 bg-background/30">
        <CarriedRow
          detail={usedBytes === null ? null : formatBytes(usedBytes)}
          icon={<HardDrive />}
          label="Data and settings"
        >
          <span className="type-meta text-muted-foreground">Always</span>
        </CarriedRow>
        {items.map((item) => (
          <React.Fragment key={item.key}>
            <CarriedRow
              detail={item.reason ?? item.detail}
              icon={item.icon}
              label={item.label}
              muted={item.reason !== null}
            >
              <Switch
                aria-label={item.label}
                checked={item.reason === null && !left.has(item.key)}
                disabled={pending || item.reason !== null}
                onCheckedChange={(taken) => onToggle(item.key, taken)}
              />
            </CarriedRow>
            {item.key === "domains" && domains.length > 0 ? (
              <ul className="max-h-32 overflow-y-auto border-t border-border/50 py-1">
                {domains.map((domain) => (
                  <li
                    className="type-meta flex min-h-6 flex-wrap items-center justify-between gap-x-3 py-0.5 pr-3 pl-9"
                    key={domain.name}
                  >
                    <span className="min-w-0 truncate font-mono text-foreground">
                      {domain.name}
                    </span>
                    <span
                      className={cn(
                        "flex items-center gap-1.5",
                        domain.warns
                          ? "text-amber-300 light:text-amber-800"
                          : "text-muted-foreground"
                      )}
                    >
                      {domain.warns ? (
                        <TriangleAlert aria-hidden="true" className="size-3" />
                      ) : null}
                      {domain.text}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </React.Fragment>
        ))}
      </div>
    </section>
  )
}

function CarriedRow({
  children,
  detail,
  icon,
  label,
  muted = false,
}: {
  children: React.ReactNode
  detail: string | null
  icon: React.ReactNode
  label: string
  muted?: boolean
}) {
  return (
    <div className="flex min-h-10 items-center gap-2.5 border-t border-border/50 px-3 py-1 first:border-t-0">
      <span
        aria-hidden="true"
        className="shrink-0 text-muted-foreground [&_svg]:size-3.5"
      >
        {icon}
      </span>
      <span
        className={cn("type-label shrink-0", muted && "text-muted-foreground")}
      >
        {label}
      </span>
      <span className="type-meta min-w-0 flex-1 truncate text-muted-foreground">
        {detail}
      </span>
      {children}
    </div>
  )
}

// A label and its switch, the label's explanation in a tooltip.
function SwitchRow({
  checked,
  disabled,
  label,
  onCheckedChange,
  title,
}: {
  checked: boolean
  disabled: boolean
  label: string
  onCheckedChange: (checked: boolean) => void
  title?: string
}) {
  return (
    <div
      className={cn(
        "flex h-8 min-w-0 items-center justify-between gap-3",
        disabled && !checked && "opacity-60"
      )}
    >
      <span className="type-label min-w-0 truncate" title={title}>
        {label}
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
