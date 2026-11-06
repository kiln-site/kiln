import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  appMountsSchema,
  relayVolumeNameSchema,
  type AppMount,
  type RelayVolume,
} from "@workspace/contracts"
import {
  FileText,
  FolderTree,
  HardDrive,
  LoaderCircle,
  Rocket,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
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
import { Textarea } from "@workspace/ui/components/textarea"

import {
  useAppConfigSave,
  type EditableAppConfig,
  type SaveNext,
} from "@/components/app/app-config-dialogs"
import {
  withMadeVolume,
  type DraftSource,
  type MountDraft,
} from "@/components/app/app-mount-drafts"
import { appServices, type App } from "@/components/app/app-presentation"
import { useRelayPermission } from "@/components/relay/relay-settings"
import { VolumeCard, volumeCardMeta } from "@/components/volumes/volume-card"
import {
  findVolumeByName,
  useVolumeUsage,
  VolumeField,
  VolumePickerList,
  VolumeSpecProblems,
} from "@/components/volumes/volume-field"
import { recoverPromise } from "@/effect/promise"
import { queryKeys, relayVolumesQueryOptions } from "@/lib/query-options"
import type { ParsedVolumeSpec, VolumeSpec } from "@/lib/volume-spec"
import { createRelayVolume } from "@/server/relay-volumes"

// Every service, for a Compose app's mounts.
const ALL_SERVICES = "*"
// Stands in for a volume not yet made while its mount is checked.
const PENDING_VOLUME_ID = "0".repeat(40)

const newMountId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16)

function newDraft(
  source: DraftSource,
  fields: Partial<Pick<MountDraft, "readOnly" | "target">> = {}
): MountDraft {
  return {
    id: newMountId(),
    readOnly: source.type === "file",
    service: null,
    source,
    target: "",
    ...fields,
  }
}

function mountDraft(mount: AppMount, name: string): MountDraft {
  return {
    ...mount,
    source:
      mount.source.type === "volume" ? { ...mount.source, name } : mount.source,
  }
}

function draftMount(draft: MountDraft, volumeId?: string): AppMount {
  const { source } = draft
  return {
    ...draft,
    source:
      source.type === "volume"
        ? {
            type: "volume",
            volumeId: volumeId ?? source.volumeId ?? PENDING_VOLUME_ID,
          }
        : source,
  }
}

function chosenVolumes(volumes: ReadonlyArray<RelayVolume> | undefined) {
  // Only the volumes Kiln made can go in a configuration: those a Compose
  // file declares are its own.
  return volumes?.filter((volume) => volume.kind === "kiln" && volume.id)
}

// What the add panel and the edit dialog share: the mounts being written, and
// saving them with the volumes they need made.
function useMountDrafts({
  app,
  editing,
  initial,
  onDone,
  routeId,
  saved,
}: {
  app: App
  // The mount it changes; otherwise it adds.
  editing: AppMount | null
  initial: ReadonlyArray<MountDraft>
  onDone: () => void
  routeId: string
  saved: ReadonlyArray<AppMount>
}) {
  const [drafts, setDrafts] = React.useState(initial)
  const volumes = useQuery(relayVolumesQueryOptions(app.relayId))
  const choices = React.useMemo(
    () => chosenVolumes(volumes.data?.volumes),
    [volumes.data?.volumes]
  )
  const canCreate = useRelayPermission(app.relayId, "relay.configure")
  const save = useAppConfigSave(app, routeId)
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: (name: string) =>
      createRelayVolume({ data: { name, relayId: app.relayId } }),
  })
  const others = saved.filter((mount) => mount.id !== editing?.id)
  const problem = mountsProblem(others, drafts)
  // Set while volumes are made and the config saved, as one step.
  const [pending, setPending] = React.useState<SaveNext | null>(null)
  const update = (id: string, change: (draft: MountDraft) => MountDraft) =>
    setDrafts((current) =>
      current.map((draft) => (draft.id === id ? change(draft) : draft))
    )
  const volumeSource = (name: string): DraftSource => {
    const found = findVolumeByName(choices, name)
    return found
      ? { name: found.name, type: "volume", volumeId: found.id }
      : { name, type: "volume", volumeId: null }
  }
  const fromSpec = ({ readOnly, target, ...spec }: VolumeSpec) =>
    newDraft(
      spec.kind === "host"
        ? { path: spec.path, type: "host" }
        : volumeSource(spec.name),
      { readOnly, target }
    )
  const submit = async (next: SaveNext) => {
    if (problem !== null) return
    setPending(next)
    const done = await recoverPromise(
      async () => {
        const made = new Map<string, string>()
        const resolved: Array<AppMount> = []
        for (const draft of drafts) {
          const { source } = draft
          if (source.type !== "volume" || source.volumeId) {
            resolved.push(draftMount(draft))
            continue
          }
          const name = source.name.trim()
          const volumeId =
            made.get(name) ?? (await create.mutateAsync(name)).id ?? ""
          made.set(name, volumeId)
          // Saving again after a failure uses what this already made.
          setDrafts((current) => withMadeVolume(current, name, volumeId))
          resolved.push(draftMount(draft, volumeId))
        }
        if (made.size > 0) {
          await queryClient.invalidateQueries({
            queryKey: queryKeys.relayVolumes(app.relayId),
          })
        }
        await save.mutateAsync({
          config: {
            mounts: editing
              ? saved.flatMap((mount) =>
                  mount.id === editing.id ? resolved : [mount]
                )
              : [...saved, ...resolved],
          },
          next,
        })
        return true
      },
      () => false
    )
    setPending(null)
    if (done) onDone()
  }
  return {
    canCreate,
    choices,
    createError: create.error,
    drafts,
    fromSpec,
    pending,
    problem,
    setDrafts,
    submit,
    update,
    volumes,
    volumeSource,
  }
}

// Behind the Add volume button, in the picker's own popover. Choosing goes
// straight to where it's mounted; a pasted definition already says, so it
// only needs confirming.
export function AppVolumeAddPanel({
  app,
  compose,
  deploying,
  onDone,
  routeId,
  saved,
}: {
  app: App
  // Whether it runs a Compose file, whose mounts each name a service.
  compose: boolean
  deploying: boolean
  onDone: () => void
  routeId: string
  saved: ReadonlyArray<AppMount>
}) {
  const mounts = useMountDrafts({
    app,
    editing: null,
    initial: noDrafts,
    onDone,
    routeId,
    saved,
  })
  const { drafts, pending, problem, setDrafts, submit } = mounts
  const [picking, setPicking] = React.useState(true)
  // Lines of a paste it couldn't use, until the next one.
  const [skipped, setSkipped] = React.useState<ReadonlyArray<ParsedVolumeSpec>>(
    []
  )
  const add = (next: ReadonlyArray<MountDraft>) => {
    setDrafts((current) => [...current, ...next])
    setPicking(false)
  }
  if (picking) {
    return (
      <>
        <VolumePickerList
          appId={app.id}
          canCreate={mounts.canCreate}
          loadError={mounts.volumes.error?.message}
          loading={mounts.volumes.isPending}
          relayId={app.relayId}
          volumes={mounts.choices}
          onChoose={(volume) =>
            add([
              newDraft({
                name: volume.name,
                type: "volume",
                volumeId: volume.id,
              }),
            ])
          }
          onCreate={(name) => add([newDraft(mounts.volumeSource(name))])}
          onFile={() => add([newDraft({ content: "", type: "file" })])}
          onHost={() => add([newDraft({ path: "", type: "host" })])}
          onSpecs={(specs, unused) => {
            setSkipped(unused)
            if (specs.length > 0) add(specs.map(mounts.fromSpec))
          }}
        />
        <VolumeSpecProblems className="border-t p-2.5" results={skipped} />
      </>
    )
  }
  const several = drafts.length > 1
  const ready = problem === null
  return (
    <form
      className="flex max-h-[min(72dvh,36rem)] min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        void submit("stay")
      }}
    >
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3">
        {drafts.map((draft) => {
          const volume = draftVolume(draft, mounts.choices)
          return (
            <div
              key={draft.id}
              className={cn(
                "grid min-w-0 gap-3",
                several && "border bg-muted/10 p-3"
              )}
            >
              <div className="flex min-w-0 items-center gap-1">
                <MountSummary source={draft.source} volume={volume} />
                <Button
                  aria-label="Remove"
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setDrafts((current) =>
                      current.filter((entry) => entry.id !== draft.id)
                    )
                    if (!several) setPicking(true)
                  }}
                >
                  <X />
                </Button>
              </div>
              <MountDraftFields
                appId={app.id}
                compose={compose}
                draft={draft}
                services={compose ? appServices(app) : noServices}
                volume={volume}
                onChange={(change) => mounts.update(draft.id, change)}
              />
            </div>
          )
        })}
        <VolumeSpecProblems results={skipped} />
        {mounts.createError ? (
          <p className="text-xs text-destructive">
            {mounts.createError.message}
          </p>
        ) : problem ? (
          <p className="text-xs text-muted-foreground">{problem}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t p-2">
        <Button
          // A definition leaves nothing to fill in, so Enter confirms it.
          autoFocus={ready}
          disabled={pending !== null || !ready}
          size="sm"
          type="submit"
          variant="outline"
        >
          {pending === "stay" ? (
            <LoaderCircle className="animate-spin" />
          ) : null}
          Add
        </Button>
        <Button
          disabled={pending !== null || deploying || !ready}
          size="sm"
          type="button"
          onClick={() => void submit("deploy")}
        >
          {pending === "deploy" ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Rocket />
          )}
          Add and deploy
        </Button>
      </div>
    </form>
  )
}

const noDrafts: ReadonlyArray<MountDraft> = []

function draftVolume(
  { source }: MountDraft,
  volumes: ReadonlyArray<RelayVolume> | undefined
) {
  return source.type === "volume"
    ? volumes?.find((candidate) => candidate.id === source.volumeId)
    : undefined
}

// Changes one mount: what it mounts, where, and how.
export function AppVolumeDialog({
  app,
  compose,
  deploying,
  editing,
  editingName,
  onOpenChange,
  routeId,
  saved,
}: {
  app: App
  // Whether it runs a Compose file, whose mounts each name a service.
  compose: boolean
  deploying: boolean
  editing: AppMount
  // What it's called, for those who can't list the Relay's volumes.
  editingName: string
  onOpenChange: (open: boolean) => void
  routeId: string
  saved: ReadonlyArray<AppMount>
}) {
  const [initial] = React.useState(() => [mountDraft(editing, editingName)])
  const mounts = useMountDrafts({
    app,
    editing,
    initial,
    onDone: () => onOpenChange(false),
    routeId,
    saved,
  })
  const { drafts, pending, problem, setDrafts, submit } = mounts
  const draft = drafts[0]
  const nextField = React.useRef<HTMLInputElement>(null)
  if (!draft) return null
  const volume = draftVolume(draft, mounts.choices)
  // Whatever's chosen takes the place of what was, keeping the rest.
  const replace = (next: MountDraft) =>
    setDrafts([
      {
        ...next,
        id: draft.id,
        readOnly: next.target ? next.readOnly : draft.readOnly,
        service: draft.service,
        target: next.target || draft.target,
      },
    ])
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(92dvh,52rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit volume</DialogTitle>
          <DialogDescription>
            A volume keeps data when the app redeploys. Everything else in its
            containers is replaced.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid min-w-0 gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit("stay")
          }}
        >
          <VolumeField
            appId={app.id}
            canCreate={mounts.canCreate}
            focusAfterChoice={nextField}
            loading={mounts.volumes.isPending}
            relayId={app.relayId}
            selectedKey={
              draft.source.type === "volume" ? draft.source.volumeId : null
            }
            volumes={mounts.choices}
            onChoose={(picked) =>
              replace(
                newDraft({
                  name: picked.name,
                  type: "volume",
                  volumeId: picked.id,
                })
              )
            }
            onCreate={(name) => replace(newDraft(mounts.volumeSource(name)))}
            onFile={() => replace(newDraft({ content: "", type: "file" }))}
            onHost={() => replace(newDraft({ path: "", type: "host" }))}
            onSpecs={(specs) => {
              const [spec] = specs
              if (spec) replace(mounts.fromSpec(spec))
            }}
          >
            <MountSummary source={draft.source} volume={volume} />
          </VolumeField>
          <MountDraftFields
            appId={app.id}
            compose={compose}
            draft={draft}
            services={compose ? appServices(app) : noServices}
            targetRef={nextField}
            volume={volume}
            onChange={(change) => mounts.update(draft.id, change)}
          />
          {mounts.volumes.isError ? (
            <p className="text-xs text-muted-foreground">
              {mounts.volumes.error.message}
            </p>
          ) : null}
          {mounts.createError ? (
            <p className="text-xs text-destructive">
              {mounts.createError.message}
            </p>
          ) : problem ? (
            <p className="text-xs text-muted-foreground">{problem}</p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={pending !== null || problem !== null}
              type="submit"
              variant="outline"
            >
              {pending === "stay" ? (
                <LoaderCircle className="animate-spin" />
              ) : null}
              Save
            </Button>
            <Button
              disabled={pending !== null || deploying || problem !== null}
              type="button"
              onClick={() => void submit("deploy")}
            >
              {pending === "deploy" ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Rocket />
              )}
              Save and deploy
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const noServices: ReadonlyArray<string> = []

// Why the drafts can't be saved yet, or null when they can. A field simply
// not filled in yet blocks saving but isn't worth a message, so it's empty.
function mountsProblem(
  others: ReadonlyArray<AppMount>,
  drafts: ReadonlyArray<MountDraft>
): string | null {
  for (const { source, target } of drafts) {
    if (
      source.type === "volume" &&
      !source.volumeId &&
      !relayVolumeNameSchema.safeParse(source.name).success
    ) {
      return "Name the volume in 64 characters or fewer."
    }
    if (source.type === "host" && !source.path.trim()) {
      return ""
    }
    if (!target.trim()) return ""
  }
  const parsed = appMountsSchema.safeParse([
    ...others,
    ...drafts.map((draft) => draftMount(draft)),
  ])
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Invalid")
}

function MountDraftFields({
  appId,
  compose,
  draft,
  onChange,
  services,
  targetRef,
  volume,
}: {
  appId: string
  compose: boolean
  draft: MountDraft
  onChange: (change: (draft: MountDraft) => MountDraft) => void
  services: ReadonlyArray<string>
  // The first field left to fill in, to move focus to.
  targetRef?: React.RefObject<HTMLInputElement | null>
  volume: RelayVolume | undefined
}) {
  const { source } = draft
  return (
    <>
      {source.type === "host" ? (
        <Field
          hint="Mounting a new path needs permission to edit the node’s files."
          label="Path"
        >
          <Input
            ref={targetRef}
            autoFocus={!source.path}
            className="font-mono"
            placeholder="/srv/media"
            spellCheck={false}
            value={source.path}
            onChange={(event) => {
              const path = event.currentTarget.value
              onChange((current) => ({
                ...current,
                source: { path, type: "host" },
              }))
            }}
          />
        </Field>
      ) : null}
      <Field
        hint={
          source.type === "file"
            ? "Where the file appears inside the app."
            : "The folder inside the app that keeps this data."
        }
        label="Mounted at"
      >
        <Input
          ref={source.type === "host" ? undefined : targetRef}
          autoFocus={source.type !== "host" && !draft.target}
          className="font-mono"
          placeholder={
            source.type === "file" ? "/etc/app/config.toml" : "/data"
          }
          spellCheck={false}
          value={draft.target}
          onChange={(event) => {
            const target = event.currentTarget.value
            onChange((current) => ({ ...current, target }))
          }}
        />
      </Field>
      {source.type === "file" ? (
        <Field label="Contents">
          <Textarea
            className="min-h-24 font-mono text-xs"
            spellCheck={false}
            value={source.content}
            onChange={(event) => {
              const content = event.currentTarget.value
              onChange((current) => ({
                ...current,
                source: { content, type: "file" },
              }))
            }}
          />
        </Field>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={draft.readOnly}
            onCheckedChange={(readOnly) =>
              onChange((current) => ({ ...current, readOnly }))
            }
          />
          Read-only
        </label>
        {compose ? (
          <ServiceSelect
            services={services}
            value={draft.service}
            onChange={(service) =>
              onChange((current) => ({ ...current, service }))
            }
          />
        ) : null}
      </div>
      {volume ? <SharedVolumeHint appId={appId} volume={volume} /> : null}
    </>
  )
}

// What the trigger shows: always an icon and two lines, so that what's
// chosen never changes the dialog's height.
function MountSummary({
  source,
  volume,
}: {
  source: DraftSource
  volume: RelayVolume | undefined
}) {
  const shared = {
    className: "min-w-0 flex-1 gap-2 text-left",
    iconClassName: "size-7 border-0 bg-muted/55",
    nameClassName: "type-control-sm",
  }
  const quiet = (Icon: typeof HardDrive) => (
    <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
  )
  if (source.type === "host") {
    return (
      <VolumeCard
        {...shared}
        icon={quiet(FolderTree)}
        meta="A path on the Relay’s node"
        name="Folder on the node"
      />
    )
  }
  if (source.type === "file") {
    return (
      <VolumeCard
        {...shared}
        icon={quiet(FileText)}
        meta="Kept with the app’s configuration"
        name="File"
      />
    )
  }
  return (
    <VolumeCard
      {...shared}
      kind={volume?.kind}
      meta={
        source.volumeId
          ? volume
            ? volumeCardMeta(volume)
            : "On this Relay"
          : "New volume"
      }
      name={source.name || volume?.name || "Volume"}
    />
  )
}

function SharedVolumeHint({
  appId,
  volume,
}: {
  appId: string
  volume: RelayVolume
}) {
  const usage = useVolumeUsage(volume, appId)
  if (!usage) return null
  return (
    <p className="text-xs text-muted-foreground">
      {usage}, so they’ll share its data.
    </p>
  )
}

function ServiceSelect({
  onChange,
  services,
  value,
}: {
  onChange: (service: string | null) => void
  services: ReadonlyArray<string>
  value: string | null
}) {
  return (
    <label className="ml-auto flex min-w-0 items-center gap-2 text-xs">
      Service
      <Select
        value={value ?? ALL_SERVICES}
        onValueChange={(next) => onChange(next === ALL_SERVICES ? null : next)}
      >
        <SelectTrigger className="h-8 w-40 px-2.5 font-mono text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="z-[70]">
          <SelectItem value={ALL_SERVICES}>Every service</SelectItem>
          {[...new Set([...services, ...(value ? [value] : [])])].map(
            (service) => (
              <SelectItem key={service} value={service}>
                {service}
              </SelectItem>
            )
          )}
        </SelectContent>
      </Select>
    </label>
  )
}

// Stops mounting something. What it held stays, so this says so rather than
// asking for the confirmation deleting takes.
export function AppVolumeRemoveDialog({
  app,
  config,
  deploying,
  description,
  name,
  onOpenChange,
  routeId,
}: {
  app: App
  config: Partial<EditableAppConfig>
  deploying: boolean
  description: string
  name: string
  onOpenChange: (open: boolean) => void
  routeId: string
}) {
  const save = useAppConfigSave(app, routeId)
  const pending = save.isPending ? save.variables.next : null
  const submit = async (next: SaveNext) => {
    const done = await recoverPromise(
      () => save.mutateAsync({ config, next }).then(() => true),
      () => false
    )
    if (done) onOpenChange(false)
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {name}?</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={pending !== null}
            type="button"
            variant="outline"
            onClick={() => void submit("stay")}
          >
            {pending === "stay" ? (
              <LoaderCircle className="animate-spin" />
            ) : null}
            Remove
          </Button>
          <Button
            disabled={pending !== null || deploying}
            type="button"
            onClick={() => void submit("deploy")}
          >
            {pending === "deploy" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Rocket />
            )}
            Remove and deploy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  children,
  hint,
  label,
}: {
  children: React.ReactNode
  hint?: string | undefined
  label: string
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  )
}
