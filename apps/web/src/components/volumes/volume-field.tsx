import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import type { RelayVolume } from "@workspace/contracts"
import {
  ChevronsUpDown,
  CornerDownLeft,
  FileText,
  FolderTree,
  Plus,
  TriangleAlert,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import {
  InstancePickerContent,
  InstancePickerFooterAction,
  type InstancePickerItem,
  type VolumePickerIdentity,
} from "@/components/instance-picker"
import {
  VolumeCard,
  volumeCardMeta,
  type VolumeCardProps,
} from "@/components/volumes/volume-card"
import { VolumeTag } from "@/components/volumes/volume-parts"
import { appDirectoryQueryOptions } from "@/lib/query-options"
import {
  looksLikeVolumeSpec,
  parseVolumeSpecs,
  type ParsedVolumeSpec,
  type VolumeSpec,
} from "@/lib/volume-spec"

export type VolumePickerItem = InstancePickerItem<VolumePickerIdentity>

const CREATE_KEY = "volume:create"
const SPEC_KEY = "volume:definition"
const noVolumes: ReadonlyArray<RelayVolume> = []

/** A volume's card as a picker's row shows it, in place of an instance's. */
export function VolumePickerCard(props: VolumeCardProps) {
  return (
    <VolumeCard
      className="min-w-0 flex-1 gap-2"
      iconClassName="border-0 bg-muted/55"
      metaClassName="font-mono"
      nameClassName="type-control-sm"
      {...props}
    />
  )
}

function volumePickerItem(
  volume: RelayVolume,
  relayId: string,
  appId: string | undefined
): VolumePickerItem {
  const meta = volumeCardMeta(volume)
  const here = volume.users.some((user) => user.appId === appId)
  return {
    card: (
      <VolumePickerCard
        kind={volume.kind}
        meta={meta}
        name={volume.name}
        nameAccessory={here ? <VolumeTag>Mounted here</VolumeTag> : null}
      />
    ),
    identity: { id: volume.dockerName, kind: "volume", relayId },
    key: volume.id ?? volume.dockerName,
    meta,
    name: volume.name,
    searchText: volume.dockerName,
  }
}

// The row for a definition being typed: what it'll do, or why it can't.
function definitionItem(
  text: string,
  relayId: string,
  volumes: ReadonlyArray<RelayVolume>,
  canCreate: boolean
): VolumePickerItem {
  const identity = { id: SPEC_KEY, kind: "volume", relayId } as const
  const [first] = parseVolumeSpecs(text)
  const spec = first?.spec
  const missing =
    spec?.kind === "volume" && !findVolumeByName(volumes, spec.name)
  const problem =
    first?.problem ??
    (missing && !canCreate
      ? "Creating a volume takes permission to configure this Relay."
      : null)
  const meta =
    problem ??
    `${missing ? "New volume, " : ""}mounted at ${spec?.target}${spec?.readOnly ? ", read-only" : ""}`
  const name = spec ? (spec.kind === "volume" ? spec.name : spec.path) : text
  return {
    card: (
      <VolumePickerCard
        icon={
          problem ? (
            <TriangleAlert
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
          ) : (
            <CornerDownLeft
              className="size-4 text-primary-ink"
              aria-hidden="true"
            />
          )
        }
        meta={meta}
        metaClassName={undefined}
        name={name}
        textClassName={problem ? "whitespace-normal" : undefined}
      />
    ),
    disabled: problem !== null,
    identity,
    key: SPEC_KEY,
    meta,
    name,
    searchText: text,
  }
}

function createItem(name: string, relayId: string): VolumePickerItem {
  return {
    card: (
      <VolumePickerCard
        icon={<Plus className="size-4 text-primary-ink" aria-hidden="true" />}
        meta="New volume on this Relay"
        metaClassName={undefined}
        name={`Create ${name}`}
      />
    ),
    identity: { id: CREATE_KEY, kind: "volume", relayId },
    key: CREATE_KEY,
    meta: "",
    name,
    searchText: name,
  }
}

/** The volume a name refers to, by the name it shows or Docker's. */
export function findVolumeByName(
  volumes: ReadonlyArray<RelayVolume> | undefined,
  name: string
): RelayVolume | undefined {
  const lowered = name.toLowerCase()
  return volumes?.find(
    (volume) =>
      volume.dockerName === name || volume.name.toLowerCase() === lowered
  )
}

// Every way to get a volume in one picker: pick one, type a name to create
// it, or paste a definition from a Compose file, which applies at once. A
// definition being typed shows what it'll do and takes Enter.
export function VolumePickerList({
  appId,
  canCreate,
  loadError,
  loading,
  onChoose,
  onCreate,
  onDone,
  onFile,
  onHost,
  onSpecs,
  relayId,
  selectedKey = null,
  volumes = noVolumes,
}: {
  // The App it's for, which marks what's already mounted there.
  appId?: string
  canCreate: boolean
  // Why the Relay's volumes can't be listed, such as lacking access to them.
  loadError?: string | undefined
  loading: boolean
  onChoose: (volume: RelayVolume) => void
  onCreate: (name: string) => void
  // After any choice, such as to close what holds it.
  onDone?: () => void
  onFile?: () => void
  onHost?: () => void
  // With any lines of a paste that couldn't be used.
  onSpecs: (
    specs: ReadonlyArray<VolumeSpec>,
    skipped: ReadonlyArray<ParsedVolumeSpec>
  ) => void
  relayId: string
  selectedKey?: string | null
  volumes?: ReadonlyArray<RelayVolume> | undefined
}) {
  const items = React.useMemo(
    () => volumes.map((volume) => volumePickerItem(volume, relayId, appId)),
    [appId, relayId, volumes]
  )
  const selectedKeys = React.useMemo(
    () => new Set(selectedKey ? [selectedKey] : []),
    [selectedKey]
  )
  const searchItem = React.useCallback(
    (text: string) => {
      if (looksLikeVolumeSpec(text)) {
        return definitionItem(text, relayId, volumes, canCreate)
      }
      return canCreate && !findVolumeByName(volumes, text)
        ? createItem(text, relayId)
        : null
    },
    [canCreate, relayId, volumes]
  )
  const select = React.useCallback(
    (item: VolumePickerItem) => {
      const text = item.searchText ?? ""
      if (item.key === CREATE_KEY) {
        onCreate(text)
      } else if (item.key === SPEC_KEY) {
        onSpecs(
          parseVolumeSpecs(text).flatMap(({ spec }) => (spec ? [spec] : [])),
          []
        )
      } else {
        const volume = volumes.find(
          (candidate) => (candidate.id ?? candidate.dockerName) === item.key
        )
        if (!volume) return
        onChoose(volume)
      }
      onDone?.()
    },
    [onChoose, onCreate, onDone, onSpecs, volumes]
  )
  const applyPaste = React.useCallback(
    (event: React.ClipboardEvent<HTMLInputElement>) => {
      const pasted = event.clipboardData.getData("text")
      if (!looksLikeVolumeSpec(pasted)) return
      const results = parseVolumeSpecs(pasted)
      const usable = results.flatMap(({ spec }) => (spec ? [spec] : []))
      // Nothing to apply stays in the search, whose row says what's wrong.
      if (usable.length === 0 && results.length <= 1) return
      event.preventDefault()
      onSpecs(
        usable,
        results.filter(({ problem }) => problem)
      )
      if (usable.length > 0) onDone?.()
    },
    [onDone, onSpecs]
  )
  const startMounting = (start: () => void) => {
    start()
    onDone?.()
  }
  return (
    <InstancePickerContent
      ariaLabel="Volumes"
      emptyMessage={
        loadError ??
        (loading
          ? "Loading volumes…"
          : canCreate
            ? "No volumes yet. Type a name to create one."
            : "No volumes on this Relay")
      }
      favoritesFilter={false}
      filterBar={false}
      footer={
        onHost || onFile ? (
          <div className="grid sm:grid-cols-2">
            {onHost ? (
              <InstancePickerFooterAction
                icon={FolderTree}
                label="A folder on the node"
                onClick={() => startMounting(onHost)}
              />
            ) : null}
            {onFile ? (
              <InstancePickerFooterAction
                icon={FileText}
                label="A file"
                onClick={() => startMounting(onFile)}
              />
            ) : null}
          </div>
        ) : undefined
      }
      items={items}
      searchItem={searchItem}
      searchPlaceholder={
        canCreate
          ? "Find, name, or paste uploads:/data:ro"
          : "Find, or paste uploads:/data:ro"
      }
      selectedKeys={selectedKeys}
      onSearchPaste={applyPaste}
      onSelect={select}
    />
  )
}

// A volume in a form, shaped as Add App's Database field: the picker behind a
// trigger that shows what's chosen.
export function VolumeField({
  children,
  focusAfterChoice,
  ...picker
}: Omit<React.ComponentProps<typeof VolumePickerList>, "onDone"> & {
  // What's chosen, shown on the trigger.
  children: React.ReactNode
  // Takes focus once a choice closes the picker.
  focusAfterChoice?: React.RefObject<HTMLElement | null>
}) {
  const [open, setOpen] = React.useState(false)
  const chose = React.useRef(false)
  const close = React.useCallback(() => {
    chose.current = true
    setOpen(false)
  }, [])
  return (
    <div className="min-w-0">
      <span className="mb-2 block text-xs font-medium">Volume</span>
      <DrawerPopover open={open} onOpenChange={setOpen}>
        <DrawerPopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label="Volume"
            className="h-12 w-full justify-between gap-3 px-2 font-normal"
          >
            {children}
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </DrawerPopoverTrigger>
        <DrawerPopoverContent
          title="Volumes"
          align="start"
          className="z-[70] w-(--radix-popover-trigger-width) min-w-72 overflow-hidden p-0"
          onCloseAutoFocus={(event) => {
            if (!chose.current) return
            chose.current = false
            event.preventDefault()
            focusAfterChoice?.current?.focus()
          }}
        >
          <VolumePickerList {...picker} onDone={close} />
        </DrawerPopoverContent>
      </DrawerPopover>
    </div>
  )
}

/** Lines of a definition that couldn't be used, each with why. */
export function VolumeSpecProblems({
  className,
  results,
}: {
  className?: string
  results: ReadonlyArray<ParsedVolumeSpec>
}) {
  if (results.length === 0) return null
  return (
    <ul className={cn("grid gap-1 text-xs text-muted-foreground", className)}>
      {results.map(({ line, problem }) => (
        <li key={line} className="min-w-0">
          <span className="font-mono text-foreground">{line}</span>
          <span> — {problem}</span>
        </li>
      ))}
    </ul>
  )
}

/** Who else uses a volume, in a few words, or null when nothing else does. */
export function useVolumeUsage(
  volume: Pick<RelayVolume, "mounts" | "users">,
  appId: string | undefined
): string | null {
  const { data: names } = useQuery({
    ...appDirectoryQueryOptions(),
    select: selectAppNames,
  })
  const others = volume.users.filter((user) => user.appId !== appId)
  const elsewhere = volume.mounts.filter(
    (mount) => mount.kind !== "app" && mount.kind !== "relay"
  ).length
  const count = others.length + elsewhere
  if (count === 0) return null
  const first = others[0]
  const name = first ? (names?.get(first.appId) ?? "an App") : "a container"
  return count === 1
    ? `Used by ${name}`
    : `Used by ${name} and ${count - 1} more`
}

function selectAppNames(apps: ReadonlyArray<{ id: string; name: string }>) {
  return new Map(apps.map((app) => [app.id, app.name]))
}
