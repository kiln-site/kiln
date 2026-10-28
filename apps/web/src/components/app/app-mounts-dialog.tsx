import * as React from "react"
import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { Result } from "effect"
import {
  appMountsSchema,
  type AppMount,
  type AppMountSource,
  type RelayVolume,
} from "@workspace/contracts"
import {
  FileText,
  FolderTree,
  HardDrive,
  LoaderCircle,
  Plus,
  Rocket,
  Trash2,
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

import type {
  AppComposeMounts,
  ComposeMountsModule,
} from "@/components/app/app-compose-mounts"
import { useAppConfigSave } from "@/components/app/app-config-dialogs"
import { appServices, type App } from "@/components/app/app-presentation"
import { CreateVolumeDialog } from "@/components/relay/relay-volume-dialogs"
import { recoverPromise } from "@/effect/promise"
import type { ComposeMount, ComposeMountChange } from "@/lib/compose-mounts"
import { relayVolumesQueryOptions } from "@/lib/query-options"

type MountType = AppMountSource["type"]
type VolumesQuery = UseQueryResult<{ volumes: ReadonlyArray<RelayVolume> }>

const mountTypes: Record<
  MountType,
  { icon: React.ReactNode; label: string; source: () => AppMountSource }
> = {
  volume: {
    icon: <HardDrive />,
    label: "Volume",
    source: () => ({ type: "volume", volumeId: "" }),
  },
  host: {
    icon: <FolderTree />,
    label: "Path on the node",
    source: () => ({ path: "", type: "host" }),
  },
  file: {
    icon: <FileText />,
    label: "File",
    source: () => ({ content: "", type: "file" }),
  },
}

// Every service, for a Compose app's mounts.
const ALL_SERVICES = "*"

// What the app mounts, saved together. A file
// starts empty; its contents are edited from the Volumes section. What a
// pasted Compose file mounts is changed in the file, saved with them.
export function AppMountsDialog({
  app,
  compose,
  composeFile,
  deploying,
  onOpenChange,
  routeId,
  saved,
  savedCompose,
}: {
  app: App
  // Whether it runs a Compose file, whose mounts each name a service.
  compose: boolean
  composeFile: AppComposeMounts | null
  deploying: boolean
  onOpenChange: (open: boolean) => void
  routeId: string
  saved: ReadonlyArray<AppMount>
  savedCompose: string
}) {
  const [draft, setDraft] = React.useState<Array<AppMount>>(() => [...saved])
  // Changes to the Compose file's mounts by their place in it as saved,
  // null for one removed.
  const [composeEdits, setComposeEdits] = React.useState<
    ReadonlyMap<string, ComposeMountChange | null>
  >(() => new Map())
  const [creatingFor, setCreatingFor] = React.useState<string | null>(null)
  const volumes = useQuery(relayVolumesQueryOptions(app.relayId))
  const save = useAppConfigSave(app, routeId)
  const editing =
    composeFile?.editable && composeFile.module ? composeFile.module : null
  const composeMounts = composeFile?.mounts ?? []
  const composeDirty = editing !== null && composeEdits.size > 0
  const composeDraft = React.useMemo(
    () =>
      composeDirty
        ? applyComposeEdits(editing, savedCompose, composeEdits)
        : { problem: null, text: savedCompose },
    [composeDirty, composeEdits, editing, savedCompose]
  )
  // Edits name mounts by their place in the file as it was when the dialog
  // opened; if it has changed since, they could land on another mount.
  const [openedCompose] = React.useState(savedCompose)
  const problem =
    mountsProblem(draft) ??
    (composeDirty && savedCompose !== openedCompose
      ? "The Compose file changed since this opened. Reopen it to change its mounts."
      : null) ??
    composeMountsProblem(editing, composeMounts, composeEdits) ??
    composeDraft.problem
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || composeDirty
  const pending = save.isPending ? save.variables.next : null
  const services = appServices(app)
  const update = (id: string, change: (mount: AppMount) => AppMount) =>
    setDraft((current) =>
      current.map((mount) => (mount.id === id ? change(mount) : mount))
    )
  const submit = async (next: "deploy" | "stay") => {
    if (problem) return
    const done = await recoverPromise(
      () =>
        save
          .mutateAsync({
            config: {
              mounts: draft,
              ...(composeDirty && { compose: composeDraft.text }),
            },
            next,
          })
          .then(() => true),
      () => false
    )
    if (done) onOpenChange(false)
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(92dvh,52rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Volumes</DialogTitle>
          <DialogDescription>
            All the app keeps across deploys; anything else in its containers is
            lost. Changes apply on the next deploy.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit("stay")
          }}
        >
          {draft.length === 0 && composeMounts.length === 0 ? (
            <p className="border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
              Nothing mounted. Add a volume, a path on the node, or a file.
            </p>
          ) : null}
          {draft.length === 0 ? null : (
            <ul className="flex flex-col gap-3">
              {draft.map((mount) => (
                <MountFields
                  key={mount.id}
                  appId={app.id}
                  compose={compose}
                  mount={mount}
                  services={services}
                  volumes={volumes}
                  onChange={(change) => update(mount.id, change)}
                  onCreateVolume={() => setCreatingFor(mount.id)}
                  onRemove={() =>
                    setDraft((current) =>
                      current.filter((entry) => entry.id !== mount.id)
                    )
                  }
                />
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            {(Object.keys(mountTypes) as Array<MountType>).map((type) => (
              <Button
                key={type}
                size="sm"
                type="button"
                variant="outline"
                onClick={() =>
                  setDraft((current) => [
                    ...current,
                    {
                      id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
                      readOnly: type === "file",
                      service: null,
                      source: mountTypes[type].source(),
                      target: "",
                    },
                  ])
                }
              >
                <Plus />
                {mountTypes[type].label}
              </Button>
            ))}
          </div>
          {composeFile && composeMounts.length > 0 ? (
            <section className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <h3 className="text-xs font-medium">In {composeFile.path}</h3>
                <p className="text-xs text-muted-foreground">
                  {composeFile.editable
                    ? "Changes here are made in the Compose file."
                    : `Change these in ${composeFile.path} in the repository.`}
                </p>
              </div>
              <ul className="flex flex-col gap-3">
                {composeMounts.map((mount) => {
                  const edit = composeEdits.get(mount.key)
                  if (edit === null) return null
                  return (
                    <ComposeMountFields
                      key={mount.key}
                      change={
                        edit ?? {
                          readOnly: mount.readOnly,
                          source: mount.source,
                          target: mount.target,
                        }
                      }
                      editable={editing !== null && mount.editable}
                      mount={mount}
                      onChange={(change) =>
                        setComposeEdits((current) =>
                          new Map(current).set(mount.key, change)
                        )
                      }
                    />
                  )
                })}
              </ul>
            </section>
          ) : null}
          {problem && (draft.length > 0 || composeDirty) ? (
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
              disabled={pending !== null || !dirty || problem !== null}
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
        {creatingFor ? (
          <CreateVolumeDialog
            relayId={app.relayId}
            onClose={() => setCreatingFor(null)}
            onCreated={(volume) => {
              if (!volume.id) return
              const volumeId = volume.id
              update(creatingFor, (mount) => ({
                ...mount,
                source: { type: "volume", volumeId },
              }))
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

// The saved Compose file with the dialog's changes: each changed in place,
// then the removed ones from the last, so the places of those left hold.
// A change the file can't take says why instead.
function applyComposeEdits(
  module: ComposeMountsModule | null,
  text: string,
  edits: ReadonlyMap<string, ComposeMountChange | null>
): { problem: string | null; text: string } {
  if (!module) return { problem: null, text }
  const removed = [...edits]
    .filter(([, change]) => change === null)
    .map(([key]) => key)
    .sort((a, b) => keyIndex(b) - keyIndex(a))
  const result = Result.try(() => {
    let next = text
    for (const [key, change] of edits) {
      if (change) next = module.changeComposeMount(next, key, change)
    }
    for (const key of removed) {
      next = module.changeComposeMount(next, key, null)
    }
    return next
  })
  return Result.isSuccess(result)
    ? { problem: null, text: result.success }
    : {
        problem:
          result.failure instanceof Error
            ? result.failure.message
            : String(result.failure),
        text,
      }
}

function keyIndex(key: string): number {
  return (JSON.parse(key) as [string, string, number])[2]
}

function composeMountsProblem(
  module: ComposeMountsModule | null,
  mounts: ReadonlyArray<ComposeMount>,
  edits: ReadonlyMap<string, ComposeMountChange | null>
): string | null {
  if (!module) return null
  for (const mount of mounts) {
    const change = edits.get(mount.key)
    if (!change) continue
    const problem = module.composeMountProblem(mount, change)
    if (problem) return problem
  }
  return null
}

const composeKinds: Record<
  ComposeMount["kind"],
  { icon: React.ReactNode; label: string }
> = {
  bind: { icon: <FolderTree />, label: "Path on the node" },
  config: { icon: <FileText />, label: "Config" },
  secret: { icon: <FileText />, label: "Secret" },
  volume: { icon: <HardDrive />, label: "Volume" },
}

// One mount the Compose file declares. A config's or secret's source is
// its name at the top of the file, so only where it's mounted changes.
function ComposeMountFields({
  change,
  editable,
  mount,
  onChange,
}: {
  change: ComposeMountChange
  editable: boolean
  mount: ComposeMount
  onChange: (change: ComposeMountChange | null) => void
}) {
  const kind = composeKinds[mount.kind]
  const files = mount.kind === "config" || mount.kind === "secret"
  return (
    <li className="border bg-muted/10">
      <div className="flex h-10 items-center gap-2 border-b px-3 text-[0.8125rem] font-medium [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
        {kind.icon}
        {kind.label}
        <span className="font-mono text-xs font-normal text-muted-foreground">
          {mount.service}
        </span>
        {files ? null : (
          <label className="ml-auto flex items-center gap-2 text-xs font-normal text-muted-foreground">
            Read-only
            <Switch
              checked={change.readOnly}
              disabled={!editable}
              onCheckedChange={(readOnly) => onChange({ ...change, readOnly })}
            />
          </label>
        )}
        {editable ? (
          <Button
            aria-label="Remove"
            className={files ? "ml-auto" : undefined}
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={() => onChange(null)}
          >
            <Trash2 />
          </Button>
        ) : null}
      </div>
      {mount.editable ? null : (
        <p className="border-b px-3 py-2 text-xs text-muted-foreground">
          A YAML anchor or merge shares it with another part of the file, so
          change it in the Compose file.
        </p>
      )}
      <div className="grid gap-3 p-3 sm:grid-cols-2">
        <Field
          hint={
            mount.kind === "volume"
              ? mount.dockerName
                ? `${mount.dockerName} in Docker. A new name is a new, empty volume.`
                : "Empty for a volume of its own, made anew with each container."
              : mount.kind === "bind" && change.source.startsWith(".")
                ? "In the app’s folder on the node."
                : (mount.origin ?? undefined)
          }
          label={mount.kind === "bind" ? "Path" : "Name"}
        >
          <Input
            className="font-mono"
            disabled={!editable || files}
            spellCheck={false}
            value={change.source}
            onChange={(event) => {
              const source = event.currentTarget.value
              onChange({ ...change, source })
            }}
          />
        </Field>
        <Field label="Mounted at">
          <Input
            className="font-mono"
            disabled={!editable}
            spellCheck={false}
            value={change.target}
            onChange={(event) => {
              const target = event.currentTarget.value
              onChange({ ...change, target })
            }}
          />
        </Field>
      </div>
    </li>
  )
}

// Why the mounts can't be saved yet, or null when they can.
function mountsProblem(mounts: ReadonlyArray<AppMount>): string | null {
  for (const mount of mounts) {
    if (mount.source.type === "volume" && !mount.source.volumeId) {
      return "Choose a volume for each volume mount."
    }
    if (mount.source.type === "host" && !mount.source.path.trim()) {
      return "Enter the path on the node for each path mount."
    }
    if (!mount.target.trim()) return "Enter where each is mounted."
  }
  const parsed = appMountsSchema.safeParse(mounts)
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Invalid")
}

function MountFields({
  appId,
  compose,
  mount,
  onChange,
  onCreateVolume,
  onRemove,
  services,
  volumes,
}: {
  appId: string
  compose: boolean
  mount: AppMount
  onChange: (change: (mount: AppMount) => AppMount) => void
  onCreateVolume: () => void
  onRemove: () => void
  services: ReadonlyArray<string>
  volumes: VolumesQuery
}) {
  const type = mountTypes[mount.source.type]
  return (
    <li className="border bg-muted/10">
      <div className="flex h-10 items-center gap-2 border-b px-3 text-[0.8125rem] font-medium [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
        {type.icon}
        {type.label}
        <label className="ml-auto flex items-center gap-2 text-xs font-normal text-muted-foreground">
          Read-only
          <Switch
            checked={mount.readOnly}
            onCheckedChange={(readOnly) =>
              onChange((current) => ({ ...current, readOnly }))
            }
          />
        </label>
        <Button
          aria-label="Remove"
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
      <div className="grid gap-3 p-3 sm:grid-cols-2">
        {mount.source.type === "volume" ? (
          <VolumeField
            appId={appId}
            volumeId={mount.source.volumeId}
            volumes={volumes}
            onCreate={onCreateVolume}
            onChange={(volumeId) =>
              onChange((current) => ({
                ...current,
                source: { type: "volume", volumeId },
              }))
            }
          />
        ) : mount.source.type === "host" ? (
          <Field
            hint="Mounting a new path needs permission to edit the node’s files."
            label="Path on the node"
          >
            <Input
              className="font-mono"
              placeholder="/srv/media"
              spellCheck={false}
              value={mount.source.path}
              onChange={(event) => {
                const path = event.currentTarget.value
                onChange((current) => ({
                  ...current,
                  source: { path, type: "host" },
                }))
              }}
            />
          </Field>
        ) : (
          <Field label="Contents">
            <p className="flex h-8 items-center text-xs text-muted-foreground">
              {mount.source.content
                ? "Edit it from the Volumes section."
                : "Empty; edit it from the Volumes section once saved."}
            </p>
          </Field>
        )}
        <Field label="Mounted at">
          <Input
            className="font-mono"
            placeholder={
              mount.source.type === "file" ? "/etc/app/config.toml" : "/data"
            }
            spellCheck={false}
            value={mount.target}
            onChange={(event) => {
              const target = event.currentTarget.value
              onChange((current) => ({ ...current, target }))
            }}
          />
        </Field>
        {compose ? (
          <Field label="Service">
            <Select
              value={mount.service ?? ALL_SERVICES}
              onValueChange={(value) =>
                onChange((current) => ({
                  ...current,
                  service: value === ALL_SERVICES ? null : value,
                }))
              }
            >
              <SelectTrigger className="h-8 w-full px-2.5 font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[70]">
                <SelectItem value={ALL_SERVICES}>Every service</SelectItem>
                {[
                  ...new Set([
                    ...services,
                    ...(mount.service ? [mount.service] : []),
                  ]),
                ].map((service) => (
                  <SelectItem key={service} value={service}>
                    {service}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
      </div>
    </li>
  )
}

// One of the Relay's volumes, or a new one. Sharing a volume with another
// app or database is allowed, and said.
function VolumeField({
  appId,
  onChange,
  onCreate,
  volumeId,
  volumes,
}: {
  appId: string
  onChange: (volumeId: string) => void
  onCreate: () => void
  volumeId: string
  volumes: VolumesQuery
}) {
  const choices =
    volumes.data?.volumes.filter((volume) => volume.kind === "kiln") ?? []
  const chosen = choices.find((volume) => volume.id === volumeId)
  const shared =
    chosen?.mounts.some(
      (mount) => mount.kind !== "app" || mount.resourceId !== appId
    ) || chosen?.users.some((user) => user.appId !== appId)
  return (
    <Field
      hint={
        volumes.isError
          ? volumes.error.message
          : shared
            ? "Another App or container uses it; they’ll share its data."
            : undefined
      }
      label="Volume"
    >
      <div className="flex gap-2">
        <Select
          disabled={volumes.isPending || volumes.isError}
          value={volumeId || undefined}
          // A volume just made is chosen before Radix's hidden select lists
          // it, which reports no value; that isn't a choice.
          onValueChange={(value) => {
            if (value) onChange(value)
          }}
        >
          <SelectTrigger className="h-8 min-w-0 flex-1 px-2.5 text-xs">
            <SelectValue
              placeholder={volumes.isPending ? "Loading…" : "Choose a volume"}
            />
          </SelectTrigger>
          <SelectContent className="z-[70]">
            {choices.map((volume) =>
              volume.id ? (
                <SelectItem key={volume.id} value={volume.id}>
                  {volume.name}
                </SelectItem>
              ) : null
            )}
          </SelectContent>
        </Select>
        <Button size="sm" type="button" variant="outline" onClick={onCreate}>
          <Plus />
          New
        </Button>
      </div>
    </Field>
  )
}

function Field({
  children,
  hint,
  label,
}: {
  children: React.ReactNode
  hint?: string
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
