import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { sortFn_basic } from "@tanstack/react-table"
import type { RelayVolume } from "@workspace/contracts"
import {
  Archive,
  EllipsisVertical,
  FileCode2,
  HardDrive,
  LoaderCircle,
  Lock,
  Pencil,
  Plus,
  SlidersHorizontal,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

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
import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import { InfoCopyValue } from "@/components/info-page"
import { InfraSyncButton } from "@/components/infra-sync-button"
import { useRelayPermission } from "@/components/relay/relay-settings"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import { ResourceDeletionAlert } from "@/components/resource-deletion-alert"
import { VolumeCard } from "@/components/volumes/volume-card"
import {
  VOLUME_ACTIONS_WIDTH,
  VolumeAction,
  VolumeActionGap,
  VolumeActionLink,
  VolumeDeleteAction,
  VolumeFilesButton,
  VolumeSize,
  VolumeTag,
} from "@/components/volumes/volume-parts"
import { VolumeUsedBy } from "@/components/volumes/volume-used-by"
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
import { grantsAllowBackup } from "@/lib/backup-target-permissions"
import {
  accessCapabilitiesQueryOptions,
  appDirectoryQueryOptions,
  queryKeys,
  relayVolumesQueryOptions,
} from "@/lib/query-options"
import { volumeDeletionsQueryOptions } from "@/lib/resource-deletion-queries"

type VolumeDialog =
  | { kind: "back-up"; volume: RelayVolume }
  | { kind: "delete"; volume: RelayVolume }
  | { kind: "rename"; volume: RelayVolume }
  | null

// The dialogs load on first use.
const loadVolumeDialogs = () =>
  import("@/components/relay/relay-volume-dialogs")
const CreateVolumeForm = React.lazy(() =>
  loadVolumeDialogs().then((module) => ({
    default: module.CreateVolumeForm,
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

const ResourceBackupDialog = React.lazy(() =>
  import("@/components/backups/resource-backup-dialogs").then((module) => ({
    default: module.ResourceBackupDialog,
  }))
)

const volumeColumnHelper = createDataTableColumnHelper<RelayVolume>()

const volumeSearchFields = [
  (volume: RelayVolume) => volume.name,
  (volume: RelayVolume) => volume.dockerName,
] as const

// The Relay's Docker named volumes: those Kiln made for Apps to share,
// those Apps' Compose files declare, and the Relay's own data volume. Only
// those Kiln made can be renamed or deleted here.
export function RelayVolumesPage() {
  const { relay, routeId } = useRelayWorkspace()
  const canManage = useRelayPermission(relay.id, "relay.configure")
  // A stopped backup stops and starts the Apps that use the volume.
  const canManageApps = useRelayPermission(relay.id, "app.manage")
  const [searchStore] = React.useState(() => createDataTableSearchStore())
  const [dialog, setDialog] = React.useState<VolumeDialog>(null)
  // The App whose volumes are shown, those it owns or uses, or null for all.
  const [appFilter, setAppFilter] = React.useState<string | null>(null)
  const closeDialog = React.useCallback(() => setDialog(null), [])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-3 sm:p-4">
      <VolumeDeletionAlerts canManage={canManage} relayId={relay.id} />
      <DataTableWorkspace
        toolbar={
          <VolumesToolbar
            appFilter={appFilter}
            canManage={canManage}
            relayId={relay.id}
            searchStore={searchStore}
            onAppFilterChange={setAppFilter}
          />
        }
      >
        <VolumesTable
          appFilter={appFilter}
          canManage={canManage}
          relayId={relay.id}
          relayName={relay.name}
          routeId={routeId}
          searchStore={searchStore}
          onDialog={setDialog}
        />
      </DataTableWorkspace>
      <React.Suspense fallback={null}>
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
        {dialog?.kind === "back-up" && dialog.volume.id ? (
          <ResourceBackupDialog
            description="A full archive of the volume, read through Docker with each file’s owner and mode."
            open
            relayId={relay.id}
            stoppedUnavailable={
              canManageApps
                ? null
                : "Stopping it takes permission to manage the Apps that use it"
            }
            target={{ id: dialog.volume.id, kind: "volume" }}
            title={`Back up ${dialog.volume.name}`}
            onOpenChange={(open) => {
              if (!open) closeDialog()
            }}
          />
        ) : null}
      </React.Suspense>
    </div>
  )
}

// Volumes have no page of their own, so a deletion running, or stopped for
// someone to try again or keep the volume, shows above the list.
const VolumeDeletionAlerts = React.memo(function VolumeDeletionAlerts({
  canManage,
  relayId,
}: {
  canManage: boolean
  relayId: string
}) {
  const { data: deletions = [] } = useQuery(
    volumeDeletionsQueryOptions(relayId)
  )
  const { data: names } = useQuery({
    ...relayVolumesQueryOptions(relayId),
    enabled: deletions.length > 0,
    select: selectVolumeNames,
  })
  if (deletions.length === 0) return null
  return (
    <div className="mb-3 grid gap-2">
      {deletions.map(({ volumeId }) => (
        <ResourceDeletionAlert
          key={volumeId}
          canDelete={canManage}
          kind="volume"
          name={names?.get(volumeId) ?? "This volume"}
          relayId={relayId}
          resourceId={volumeId}
        />
      ))}
    </div>
  )
})

function selectVolumeNames(data: {
  volumes: ReadonlyArray<{ id: string | null; name: string }>
}): ReadonlyMap<string, string> {
  return new Map(
    data.volumes.flatMap((volume) =>
      volume.id === null ? [] : [[volume.id, volume.name] as const]
    )
  )
}

const warmVolumeDialogs = () => void loadVolumeDialogs()

// Opens where it's pressed: a name is all a new volume needs.
function NewVolumeButton({
  align = "end",
  children,
  relayId,
}: {
  align?: "center" | "end"
  children: React.ReactElement
  relayId: string
}) {
  const [open, setOpen] = React.useState(false)
  const close = React.useCallback(() => setOpen(false), [])
  return (
    <DrawerPopover open={open} onOpenChange={setOpen}>
      <DrawerPopoverTrigger asChild>{children}</DrawerPopoverTrigger>
      <DrawerPopoverContent
        title="New volume"
        align={align}
        className="w-80 max-w-[calc(100vw-1rem)] p-0"
      >
        <React.Suspense
          fallback={
            <div className="grid h-24 place-items-center">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <CreateVolumeForm relayId={relayId} onDone={close} />
        </React.Suspense>
      </DrawerPopoverContent>
    </DrawerPopover>
  )
}

const VolumesToolbar = React.memo(function VolumesToolbar({
  appFilter,
  canManage,
  relayId,
  searchStore,
  onAppFilterChange,
}: {
  appFilter: string | null
  canManage: boolean
  relayId: string
  searchStore: DataTableSearchStore
  onAppFilterChange: (appId: string | null) => void
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
          <NewVolumeButton relayId={relayId}>
            <Button aria-label="New volume" onPointerEnter={warmVolumeDialogs}>
              <Plus />
              <span className="hidden sm:inline">New volume</span>
            </Button>
          </NewVolumeButton>
        ) : null
      }
      controls={
        <VolumeAppFilter
          relayId={relayId}
          value={appFilter}
          onChange={onAppFilterChange}
        />
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

const noApps: ReadonlyArray<string> = []

// The Apps that own or use any volume, to filter the table by.
function selectVolumeApps(data: {
  volumes: ReadonlyArray<RelayVolume>
}): ReadonlyArray<string> {
  const apps = new Set<string>()
  for (const volume of data.volumes) {
    if (volume.owner) apps.add(volume.owner.appId)
    for (const user of volume.users) apps.add(user.appId)
  }
  return apps.size ? [...apps].sort() : noApps
}

function volumeBelongsTo(volume: RelayVolume, appId: string): boolean {
  return (
    volume.owner?.appId === appId ||
    volume.users.some((user) => user.appId === appId)
  )
}

const VolumeAppFilter = React.memo(function VolumeAppFilter({
  relayId,
  value,
  onChange,
}: {
  relayId: string
  value: string | null
  onChange: (appId: string | null) => void
}) {
  const { data: apps = noApps } = useQuery({
    ...relayVolumesQueryOptions(relayId),
    select: selectVolumeApps,
  })
  const { data: appNames } = useQuery({
    ...appDirectoryQueryOptions(),
    select: selectAppNames,
  })
  if (apps.length === 0 && value === null) return null
  const filtered = value !== null
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Filter volumes by App"
              className="relative shrink-0"
              type="button"
              variant={filtered ? "secondary" : "outline"}
            >
              <SlidersHorizontal />
              {filtered ? (
                <span
                  aria-hidden
                  className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
                />
              ) : null}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Filter</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="max-w-72">
        <DropdownMenuLabel>Show</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value ?? ""}
          onValueChange={(appId) => onChange(appId || null)}
        >
          <DropdownMenuRadioItem value="">All volumes</DropdownMenuRadioItem>
          {apps.map((appId) => (
            <DropdownMenuRadioItem key={appId} value={appId}>
              <span className="truncate">{appName(appNames, appId)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

function selectAppNames(apps: ReadonlyArray<{ id: string; name: string }>) {
  return new Map(apps.map((app) => [app.id, app.name]))
}

function appName(
  appNames: ReadonlyMap<string, string> | undefined,
  appId: string
): string {
  return appNames?.get(appId) ?? `App ${appId.slice(0, 8)}`
}

function VolumesTable({
  appFilter,
  canManage,
  relayId,
  relayName,
  routeId,
  searchStore,
  onDialog,
}: {
  appFilter: string | null
  canManage: boolean
  relayId: string
  relayName: string
  routeId: string
  searchStore: DataTableSearchStore
  onDialog: (dialog: VolumeDialog) => void
}) {
  const volumes = useQuery(relayVolumesQueryOptions(relayId))
  const canReadFiles = useRelayPermission(relayId, "relay.files.read")
  const canBrowse = canReadFiles && volumes.data?.filesAvailable === true
  const canBackUp = useVolumeBackups(relayId)
  // Why the Relay can't tell yet which Apps' configurations use a volume.
  const protectionPending =
    volumes.data?.protection.ready === false
      ? volumes.data.protection.retrying
        ? "protection pending: retrying"
        : (volumes.data.protection.reason ?? "")
      : null
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
              rows:
                appFilter === null
                  ? volumes.data.volumes
                  : volumes.data.volumes.filter((volume) =>
                      volumeBelongsTo(volume, appFilter)
                    ),
            }
          : {
              body: { kind: "loading", rowCount: 2 },
              refreshing: false,
              rows: [],
            },
    [appFilter, volumes]
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
      volumeColumnHelper.accessor((volume) => volume.users.length, {
        id: "mounts",
        header: "Used by",
        sortFn: sortFn_basic,
        cell: ({ row }) => (
          <VolumeUsedBy
            relayId={relayId}
            relayName={relayName}
            volume={row.original}
          />
        ),
        meta: dataTableColumnMeta(
          { hideBelow: "md", width: "9rem" },
          { cellClassName: "justify-end", headerClassName: "justify-end" }
        ),
      }),
      volumeColumnHelper.accessor((volume) => volume.sizeBytes ?? -1, {
        id: "size",
        header: "Size",
        sortFn: sortFn_basic,
        cell: ({ row }) => <VolumeSize sizeBytes={row.original.sizeBytes} />,
        meta: dataTableColumnMeta({ hideBelow: "sm", width: "7rem" }),
      }),
      volumeColumnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <VolumeActions
            canBackUp={canBackUp(row.original)}
            canBrowse={canBrowse}
            canManage={canManage}
            protectionPending={protectionPending}
            routeId={routeId}
            volume={row.original}
            onDialog={onDialog}
          />
        ),
        meta: dataTableColumnMeta(
          { width: VOLUME_ACTIONS_WIDTH },
          { cellClassName: "px-1 sm:px-2", headerClassName: "px-1 sm:px-2" }
        ),
      }),
      // Not on phones, where every action is an icon and nothing's tucked away.
      volumeColumnHelper.display({
        id: "identifiers",
        header: () => <span className="sr-only">Identifiers</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <VolumeIdentifiers relayId={relayId} volume={row.original} />
        ),
        meta: dataTableColumnMeta(
          { hideBelow: "md", width: "2.25rem" },
          { cellClassName: "px-0 pr-1", headerClassName: "px-0" }
        ),
      }),
    ])
    return defineDataTable({
      ariaLabel: "Volumes",
      columns,
      getRowId: (volume) => volume.dockerName,
      search: { fields: volumeSearchFields },
    })
  }, [
    canBackUp,
    canBrowse,
    canManage,
    onDialog,
    protectionPending,
    relayId,
    relayName,
    routeId,
  ])

  const supported = volumes.data?.supported !== false
  const emptyState = React.useCallback(
    ({ searchActive: searching }: { searchActive: boolean }) => {
      const searchActive = searching || appFilter !== null
      return (
        <DataTableEmptyState
          action={
            searchActive || !canManage || !supported ? undefined : (
              <NewVolumeButton align="center" relayId={relayId}>
                <Button size="sm" onPointerEnter={warmVolumeDialogs}>
                  <Plus /> New volume
                </Button>
              </NewVolumeButton>
            )
          }
          description={
            searchActive
              ? searching
                ? "Try a different name."
                : "This App neither owns nor uses any volume."
              : supported
                ? "Volumes keep data across deployments, and Apps on this Relay can share them."
                : "Update this Relay to manage its volumes from Hearth."
          }
          icon={
            <HardDrive className="size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
          }
          title={
            searchActive
              ? searching
                ? "No volumes match your search"
                : "No volumes for this App"
              : supported
                ? "No volumes yet"
                : "Volumes need a newer Relay"
          }
        />
      )
    },
    [appFilter, canManage, relayId, supported]
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

// Who may back up which volume: a Kiln volume takes the Relay's backup
// permission, an App's own volume the App's file permission.
function useVolumeBackups(relayId: string) {
  const { data: capabilities } = useQuery(accessCapabilitiesQueryOptions())
  return React.useCallback(
    (volume: RelayVolume) =>
      volume.id !== null &&
      volume.kind !== "relay" &&
      Boolean(
        capabilities &&
        (capabilities.isPlatformAdmin ||
          grantsAllowBackup(
            capabilities.grants,
            { id: volume.id, kind: "volume", relayId },
            "backup.create"
          ))
      ),
    [capabilities, relayId]
  )
}

const VolumeIdentity = React.memo(function VolumeIdentity({
  volume,
}: {
  volume: RelayVolume
}) {
  const own = volume.kind === "relay"
  return (
    <VolumeCard
      kind={volume.kind}
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
              <VolumeTag className="shrink-0">
                <Lock aria-hidden="true" />
                Relay
              </VolumeTag>
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

const VolumeActions = React.memo(function VolumeActions({
  canBackUp,
  canBrowse,
  canManage,
  protectionPending,
  routeId,
  volume,
  onDialog,
}: {
  canBackUp: boolean
  canBrowse: boolean
  canManage: boolean
  protectionPending: string | null
  routeId: string
  volume: RelayVolume
  onDialog: (dialog: VolumeDialog) => void
}) {
  const own = volume.kind === "relay"
  const kiln = volume.kind === "kiln"
  const deleteBlocked = own
    ? "The Relay keeps its data here"
    : !kiln
      ? "Its App's Compose file declares it; deleting the App deletes it"
      : protectionPending !== null
        ? `The Relay doesn't know yet which Apps use it${protectionPending ? `: ${protectionPending}` : ""}`
        : volume.users.some((user) => user.configured)
          ? "An App's configuration mounts it; remove it there first"
          : volume.mounts.length > 0
            ? "Remove what mounts it first"
            : null
  return (
    <DataTableActionGroup>
      {volume.owner ? (
        <VolumeComposeAction appId={volume.owner.appId} name={volume.name} />
      ) : canManage && kiln ? (
        <VolumeAction
          label={`Rename ${volume.name}`}
          tooltip="Rename"
          onClick={() => onDialog({ kind: "rename", volume })}
          onWarm={warmVolumeDialogs}
        >
          <Pencil />
        </VolumeAction>
      ) : (
        <VolumeActionGap />
      )}
      <VolumeFilesButton
        label={`View files in ${volume.name}`}
        link={
          canBrowse && volume.mountpoint
            ? {
                params: {
                  _splat: `${volume.mountpoint.replace(/^\/+/u, "")}/`,
                  relayId: routeId,
                },
                to: "/relay/$relayId/files/$",
              }
            : null
        }
        unavailable="Mount host files to view its files"
      />
      {canBackUp ? (
        <VolumeAction
          label={`Back up ${volume.name}`}
          tooltip="Back up"
          onClick={() => onDialog({ kind: "back-up", volume })}
        >
          <Archive />
        </VolumeAction>
      ) : (
        <VolumeActionGap />
      )}
      {canManage ? (
        <VolumeDeleteAction
          blocked={deleteBlocked}
          label={`Delete ${volume.name}`}
          tooltip="Delete"
          onClick={() => onDialog({ kind: "delete", volume })}
          onWarm={warmVolumeDialogs}
        />
      ) : (
        <VolumeActionGap />
      )}
    </DataTableActionGroup>
  )
})

// A Compose file's volume changes there, on its App.
function VolumeComposeAction({ appId, name }: { appId: string; name: string }) {
  const selectName = React.useCallback(
    (apps: ReadonlyArray<{ id: string; name: string }>) =>
      apps.find((app) => app.id === appId)?.name,
    [appId]
  )
  const { data: owner } = useQuery({
    ...appDirectoryQueryOptions(),
    select: selectName,
  })
  return (
    <VolumeActionLink
      label={`Open the App that defines ${name}`}
      link={{ params: { appId }, to: "/app/$appId/info" }}
      tooltip={`Defined in ${owner ?? "its App"}'s Compose file`}
    >
      <FileCode2 />
    </VolumeActionLink>
  )
}

const VolumeIdentifiers = React.memo(function VolumeIdentifiers({
  relayId,
  volume,
}: {
  relayId: string
  volume: RelayVolume
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`Copy identifiers of ${volume.name}`}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Copy identifiers</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-44">
        {volume.id ? (
          <CopyIdentifierMenuItem label="Volume ID" value={volume.id} />
        ) : null}
        <CopyIdentifierMenuItem label="Docker name" value={volume.dockerName} />
        <CopyIdentifierMenuItem label="Relay ID" value={relayId} />
        {volume.mountpoint ? (
          <CopyIdentifierMenuItem label="Host path" value={volume.mountpoint} />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})
