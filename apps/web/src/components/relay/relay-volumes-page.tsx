import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { sortFn_basic } from "@tanstack/react-table"
import type { RelayVolume, RelayVolumeMount } from "@workspace/contracts"
import {
  Container,
  EllipsisVertical,
  FolderOpen,
  HardDrive,
  Lock,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { CopyIdentifierMenuItem } from "@/components/copy-identifier-menu-item"
import {
  DataTableActionGroup,
  DataTableEmptyState,
} from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import { IdentityName } from "@/components/identity-name"
import { InfoCopyValue } from "@/components/info-page"
import { InfraSyncButton } from "@/components/infra-sync-button"
import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import { InstancePickerContent } from "@/components/instance-picker"
import { AppKindIcon, RelayKindIcon } from "@/components/instance-kind-icon"
import { relayHostAccessQueryOptions } from "@/components/relay/relay-host-access"
import { useRelayPermission } from "@/components/relay/relay-settings"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import { formatBytes } from "@/lib/format-bytes"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import {
  createDataTableSearchStore,
  type DataTableSearchStore,
} from "@/lib/data-table-search"
import type { DataTableSource } from "@/lib/data-table-source"
import type { InstancePickerItem } from "@/lib/instance-picker-filters"
import {
  appDirectoryQueryOptions,
  queryKeys,
  relayVolumesQueryOptions,
} from "@/lib/query-options"

type VolumeDialog =
  | { kind: "create" }
  | { kind: "delete"; volume: RelayVolume }
  | { kind: "rename"; volume: RelayVolume }
  | null

// The dialogs load on first use.
const loadVolumeDialogs = () =>
  import("@/components/relay/relay-volume-dialogs")
const CreateVolumeDialog = React.lazy(() =>
  loadVolumeDialogs().then((module) => ({
    default: module.CreateVolumeDialog,
  }))
)
const RenameVolumeDialog = React.lazy(() =>
  loadVolumeDialogs().then((module) => ({
    default: module.RenameVolumeDialog,
  }))
)
const DeleteVolumeDialog = React.lazy(() =>
  loadVolumeDialogs().then((module) => ({
    default: module.DeleteVolumeDialog,
  }))
)

const volumeColumnHelper = createDataTableColumnHelper<RelayVolume>()

const volumeSearchFields = [
  (volume: RelayVolume) => volume.name,
  (volume: RelayVolume) => volume.dockerName,
] as const

// The Relay's Docker named volumes: those Kiln made for apps to share, and
// the Relay's own data volume, which can't be renamed or deleted.
export function RelayVolumesPage() {
  const { relay, routeId } = useRelayWorkspace()
  const canManage = useRelayPermission(relay.id, "relay.configure")
  const [searchStore] = React.useState(() => createDataTableSearchStore())
  const [dialog, setDialog] = React.useState<VolumeDialog>(null)
  const closeDialog = React.useCallback(() => setDialog(null), [])
  const openCreate = React.useCallback(() => setDialog({ kind: "create" }), [])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-3 sm:p-4">
      <DataTableWorkspace
        toolbar={
          <VolumesToolbar
            canManage={canManage}
            relayId={relay.id}
            searchStore={searchStore}
            onCreate={openCreate}
          />
        }
      >
        <VolumesTable
          canManage={canManage}
          relayId={relay.id}
          relayName={relay.name}
          routeId={routeId}
          searchStore={searchStore}
          onCreate={openCreate}
          onDialog={setDialog}
        />
      </DataTableWorkspace>
      <React.Suspense fallback={null}>
        {dialog?.kind === "create" ? (
          <CreateVolumeDialog relayId={relay.id} onClose={closeDialog} />
        ) : null}
        {dialog?.kind === "rename" ? (
          <RenameVolumeDialog
            relayId={relay.id}
            volume={dialog.volume}
            onClose={closeDialog}
          />
        ) : null}
        {dialog?.kind === "delete" ? (
          <DeleteVolumeDialog
            relayId={relay.id}
            volume={dialog.volume}
            onClose={closeDialog}
          />
        ) : null}
      </React.Suspense>
    </div>
  )
}

const VolumesToolbar = React.memo(function VolumesToolbar({
  canManage,
  relayId,
  searchStore,
  onCreate,
}: {
  canManage: boolean
  relayId: string
  searchStore: DataTableSearchStore
  onCreate: () => void
}) {
  const queryClient = useQueryClient()
  // Older Relays can't make volumes; the table says to update them.
  const { data: supported = true } = useQuery({
    ...relayVolumesQueryOptions(relayId),
    select: selectSupported,
  })
  return (
    <DataTableToolbar
      actions={
        canManage && supported ? (
          <Button aria-label="New volume" onClick={onCreate}>
            <Plus />
            <span className="hidden sm:inline">New volume</span>
          </Button>
        ) : null
      }
      leading={
        <InfraSyncButton
          label="Refresh volumes"
          sync={() =>
            queryClient.invalidateQueries({
              queryKey: queryKeys.relayVolumes(relayId),
            })
          }
        />
      }
      search={{
        ariaLabel: "Search volumes",
        closeMobileWhenEmpty: true,
        id: "volume-search",
        placeholder: "Search volumes",
        store: searchStore,
      }}
    />
  )
})

function selectSupported(data: { supported: boolean }): boolean {
  return data.supported
}

function VolumesTable({
  canManage,
  relayId,
  relayName,
  routeId,
  searchStore,
  onCreate,
  onDialog,
}: {
  canManage: boolean
  relayId: string
  relayName: string
  routeId: string
  searchStore: DataTableSearchStore
  onCreate: () => void
  onDialog: (dialog: VolumeDialog) => void
}) {
  const volumes = useQuery(relayVolumesQueryOptions(relayId))
  const canBrowse = useVolumeBrowsing(relayId)
  const source = React.useMemo<DataTableSource<RelayVolume>>(
    () =>
      volumes.isError
        ? {
            body: {
              error: volumes.error,
              kind: "error",
              retry: () => void volumes.refetch(),
            },
            refreshing: false,
            rows: [],
          }
        : volumes.data
          ? {
              body: { kind: "ready" },
              refreshing: volumes.isFetching,
              rows: volumes.data.volumes,
            }
          : {
              body: { kind: "loading", rowCount: 2 },
              refreshing: false,
              rows: [],
            },
    [volumes]
  )
  const definition = React.useMemo(() => {
    const columns = volumeColumnHelper.columns([
      volumeColumnHelper.accessor((volume) => volume.name, {
        id: "volume",
        header: "Volume",
        sortFn: "text",
        cell: ({ row }) => <VolumeIdentity volume={row.original} />,
        meta: dataTableColumnMeta({ width: "minmax(0,1fr)" }),
      }),
      volumeColumnHelper.accessor((volume) => volume.sizeBytes ?? -1, {
        id: "size",
        header: "Size",
        sortFn: sortFn_basic,
        cell: ({ row }) => <VolumeSize volume={row.original} />,
        meta: dataTableColumnMeta({ hideBelow: "sm", width: "7rem" }),
      }),
      volumeColumnHelper.accessor((volume) => volume.mounts.length, {
        id: "mounts",
        header: "Mounts",
        sortFn: sortFn_basic,
        cell: ({ row }) => (
          <VolumeMounts
            relayId={relayId}
            relayName={relayName}
            volume={row.original}
          />
        ),
        meta: dataTableColumnMeta({ hideBelow: "md", width: "9rem" }),
      }),
      volumeColumnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <VolumeActions
            canBrowse={canBrowse}
            canManage={canManage}
            relayId={relayId}
            routeId={routeId}
            volume={row.original}
            onDialog={onDialog}
          />
        ),
        meta: dataTableColumnMeta(
          { width: "6.5rem" },
          { cellClassName: "px-1 sm:px-2", headerClassName: "px-1 sm:px-2" }
        ),
      }),
    ])
    return defineDataTable({
      ariaLabel: "Volumes",
      columns,
      getRowId: (volume) => volume.dockerName,
      search: { fields: volumeSearchFields },
    })
  }, [canBrowse, canManage, onDialog, relayId, relayName, routeId])

  const supported = volumes.data?.supported !== false
  const emptyState = React.useCallback(
    ({ searchActive }: { searchActive: boolean }) => (
      <DataTableEmptyState
        action={
          searchActive || !canManage || !supported ? undefined : (
            <Button size="sm" onClick={onCreate}>
              <Plus /> New volume
            </Button>
          )
        }
        description={
          searchActive
            ? "Try a different name."
            : supported
              ? "Volumes keep data across deployments, and apps on this Relay can share them."
              : "Update this Relay to manage its volumes from Hearth."
        }
        icon={
          <HardDrive className="size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
        }
        title={
          searchActive
            ? "No volumes match your search"
            : supported
              ? "No volumes yet"
              : "Volumes need a newer Relay"
        }
      />
    ),
    [canManage, onCreate, supported]
  )

  return (
    <DataTable
      definition={definition}
      emptyState={emptyState}
      searchStore={searchStore}
      source={source}
    />
  )
}

// Whether the volume's folder opens in the Relay's Files: with host files
// mounted and permission to read them.
function useVolumeBrowsing(relayId: string): boolean {
  const canReadFiles = useRelayPermission(relayId, "relay.files.read")
  const { data: ready = false } = useQuery({
    ...relayHostAccessQueryOptions(relayId),
    enabled: canReadFiles,
    select: (access) => access.files.status === "ready",
  })
  return canReadFiles && ready
}

const VolumeIdentity = React.memo(function VolumeIdentity({
  volume,
}: {
  volume: RelayVolume
}) {
  const own = volume.kind === "relay"
  return (
    <IdentityName
      icon={
        own ? (
          <RelayKindIcon className="size-4" aria-hidden="true" />
        ) : (
          <HardDrive className="size-4" aria-hidden="true" />
        )
      }
      meta={
        <InfoCopyValue
          className="max-w-full text-[length:inherit] hover:text-foreground"
          label="Docker name"
          value={volume.dockerName}
        />
      }
      metaClassName="font-mono"
      name={volume.name}
      nameAccessory={
        own ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex shrink-0 items-center gap-1 border bg-muted/30 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                <Lock className="size-3" aria-hidden="true" />
                Relay
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              The Relay keeps its data here, so it can't be renamed or deleted
            </TooltipContent>
          </Tooltip>
        ) : null
      }
    />
  )
})

function VolumeSize({ volume }: { volume: RelayVolume }) {
  return volume.sizeBytes === null ? (
    <span
      className="type-meta text-muted-foreground"
      title="Docker hasn't measured it yet"
    >
      —
    </span>
  ) : (
    <span className="type-meta tabular-nums">
      {formatBytes(volume.sizeBytes)}
    </span>
  )
}

// The apps whose containers mount a volume, and how many containers that
// is; the list groups them by app.
const VolumeMounts = React.memo(function VolumeMounts({
  relayId,
  relayName,
  volume,
}: {
  relayId: string
  relayName: string
  volume: RelayVolume
}) {
  const [open, setOpen] = React.useState(false)
  const close = React.useCallback(() => setOpen(false), [])
  const apps = new Set(
    volume.mounts.flatMap((mount) =>
      mount.kind === "app" && mount.resourceId ? [mount.resourceId] : []
    )
  ).size
  const containers = volume.mounts.length
  return (
    <DrawerPopover open={open} onOpenChange={setOpen}>
      <DrawerPopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${apps} ${apps === 1 ? "app" : "apps"}, ${containers} ${containers === 1 ? "container" : "containers"} mount ${volume.name}`}
          className="type-meta relative z-10 -mx-1.5 flex h-8 min-w-0 items-center gap-3 rounded-md px-1.5 text-muted-foreground transition-colors outline-none hover:bg-muted/55 focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-muted/55"
        >
          <MountCount count={apps} icon={AppKindIcon} one="app" other="apps" />
          <MountCount
            count={containers}
            icon={Container}
            one="container"
            other="containers"
          />
        </button>
      </DrawerPopoverTrigger>
      <DrawerPopoverContent
        title="Mounts"
        aria-label="Mounts"
        align="start"
        sideOffset={6}
        className="w-72 max-w-[calc(100vw-1rem)] overflow-hidden p-0"
      >
        <VolumeMountPicker
          relayId={relayId}
          relayName={relayName}
          volume={volume}
          onNavigate={close}
        />
      </DrawerPopoverContent>
    </DrawerPopover>
  )
})

function MountCount({
  count,
  icon: Icon,
  one,
  other,
}: {
  count: number
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  one: string
  other: string
}) {
  return (
    <span
      title={`${count} ${count === 1 ? one : other}`}
      className={cn(
        "pointer-events-none flex items-center gap-1 tabular-nums",
        count ? "text-foreground" : "opacity-40"
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {count}
    </span>
  )
}

const noSelectedMounts: ReadonlySet<string> = new Set()

// What mounts a volume, as the Automations targets list shows its targets:
// one row per app, however many of its containers mount it.
const VolumeMountPicker = React.memo(function VolumeMountPicker({
  relayId,
  relayName,
  volume,
  onNavigate,
}: {
  relayId: string
  relayName: string
  volume: RelayVolume
  onNavigate: () => void
}) {
  const navigate = useNavigate()
  const { data: appNames } = useQuery({
    ...appDirectoryQueryOptions(),
    select: selectAppNames,
  })
  const items = React.useMemo(
    () => volumeMountItems(volume, relayId, relayName, appNames),
    [appNames, relayId, relayName, volume]
  )
  const select = React.useCallback(
    (item: InstancePickerItem) => {
      onNavigate()
      void navigate({ href: mountHref(item.identity) })
    },
    [navigate, onNavigate]
  )
  return (
    <InstancePickerContent
      ariaLabel="Mounts"
      emptyMessage="Nothing mounts this volume"
      favoritesFilter={false}
      includeKindGroups={false}
      items={items}
      selectedKeys={noSelectedMounts}
      onSelect={select}
    />
  )
})

function selectAppNames(apps: ReadonlyArray<{ id: string; name: string }>) {
  return new Map(apps.map((app) => [app.id, app.name]))
}

function volumeMountItems(
  volume: RelayVolume,
  relayId: string,
  relayName: string,
  appNames: ReadonlyMap<string, string> | undefined
): Array<InstancePickerItem> {
  const groups = new Map<
    string,
    {
      identity: InstancePickerItem["identity"]
      mounts: Array<RelayVolumeMount>
      name: string
    }
  >()
  for (const mount of volume.mounts) {
    const id = mount.resourceId
    const target =
      mount.kind === "relay"
        ? {
            identity: {
              id: relayId,
              kind: "relay",
              relayId,
              source: "fleet",
            } as const,
            key: "relay",
            name: relayName,
          }
        : mount.kind === "app" && id
          ? {
              identity: { id, kind: "app", relayId } as const,
              key: `app:${id}`,
              name: appNames?.get(id) ?? `App ${id.slice(0, 8)}`,
            }
          : mount.kind === "database" && id
            ? {
                identity: { id, kind: "database", relayId } as const,
                key: `database:${id}`,
                name: `Database ${id.slice(0, 8)}`,
              }
            : mount.kind === "instance" && id
              ? {
                  identity: { id, kind: "server", relayId } as const,
                  key: `server:${id}`,
                  name: `Game server ${id.slice(0, 8)}`,
                }
              : null
    // Containers Kiln doesn't run only count toward the total.
    if (!target) continue
    const group = groups.get(target.key)
    if (group) group.mounts.push(mount)
    else groups.set(target.key, { ...target, mounts: [mount] })
  }
  return [...groups].map(([key, group]) => {
    const containers = group.mounts.length
    const paths = [...new Set(group.mounts.map((mount) => mount.destination))]
    return {
      identity: group.identity,
      key,
      meta: `${containers} ${containers === 1 ? "container" : "containers"} · ${paths.join(", ")}`,
      name: group.name,
      searchText: [
        ...group.mounts.map((mount) => mount.container),
        ...paths,
      ].join(" "),
    }
  })
}

// Each workspace route takes a full ID and redirects to its short form.
function mountHref(identity: InstancePickerItem["identity"]): string {
  if (identity.kind === "server") {
    return `/server/${encodeURIComponent(`${identity.relayId}-${identity.id}`)}`
  }
  if (identity.kind === "database") {
    return `/db/${encodeURIComponent(identity.id)}`
  }
  if (identity.kind === "app") return `/app/${encodeURIComponent(identity.id)}`
  return `/relay/${encodeURIComponent(identity.relayId)}`
}

const VolumeActions = React.memo(function VolumeActions({
  canBrowse,
  canManage,
  relayId,
  routeId,
  volume,
  onDialog,
}: {
  canBrowse: boolean
  canManage: boolean
  relayId: string
  routeId: string
  volume: RelayVolume
  onDialog: (dialog: VolumeDialog) => void
}) {
  const own = volume.kind === "relay"
  const deleteBlocked = own
    ? "The Relay keeps its data here"
    : volume.mounts.length > 0
      ? "Remove what mounts it first"
      : null
  return (
    <DataTableActionGroup>
      <Tooltip>
        <TooltipTrigger asChild>
          {canBrowse && volume.mountpoint ? (
            <Button
              asChild
              className="text-muted-foreground hover:text-primary-ink"
              size="icon-sm"
              variant="ghost"
            >
              <Link
                aria-label={`View files in ${volume.name}`}
                to="/relay/$relayId/files/$"
                params={{
                  _splat: `${volume.mountpoint.replace(/^\/+/u, "")}/`,
                  relayId: routeId,
                }}
              >
                <FolderOpen />
              </Link>
            </Button>
          ) : (
            // A disabled button gets no pointer events; its wrapper keeps the
            // tooltip that says why.
            <span tabIndex={0} className="rounded-md outline-none">
              <Button
                aria-label={`View files in ${volume.name}`}
                disabled
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <FolderOpen />
              </Button>
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {canBrowse ? "View files" : "Mount host files to view its files"}
        </TooltipContent>
      </Tooltip>
      {canManage ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={deleteBlocked ? 0 : -1}
              className="rounded-md outline-none"
            >
              <Button
                aria-label={`Delete ${volume.name}`}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive light:hover:bg-destructive/20"
                disabled={deleteBlocked !== null}
                size="icon-sm"
                type="button"
                variant="ghost"
                onClick={() => onDialog({ kind: "delete", volume })}
              >
                <Trash2 />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {deleteBlocked ?? "Delete"}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={`More actions for ${volume.name}`}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-44">
          {canManage && !own ? (
            <>
              <DropdownMenuItem
                onSelect={() => onDialog({ kind: "rename", volume })}
              >
                <Pencil /> Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {volume.id ? (
            <CopyIdentifierMenuItem label="Volume ID" value={volume.id} />
          ) : null}
          <CopyIdentifierMenuItem
            label="Docker name"
            value={volume.dockerName}
          />
          <CopyIdentifierMenuItem label="Relay ID" value={relayId} />
          {volume.mountpoint ? (
            <CopyIdentifierMenuItem
              label="Host path"
              value={volume.mountpoint}
            />
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
  )
})
