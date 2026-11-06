import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  appMountFileName,
  type AppMount,
  type RelayVolume,
} from "@workspace/contracts"
import { sortFn_basic } from "@tanstack/react-table"
import {
  Archive,
  FileCode2,
  FileText,
  FolderTree,
  HardDrive,
  LoaderCircle,
  Pencil,
  Plus,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import {
  useAppComposeMounts,
  type AppComposeMounts,
} from "@/components/app/app-compose-mounts"
import {
  AppCodeDialog,
  AppDocumentDialog,
  type EditableAppConfig,
} from "@/components/app/app-config-dialogs"
import { AppGitHubFileDialog } from "@/components/app/app-github-file-dialog"
import {
  appContainers,
  appRelayAvailable,
  appServices,
  type App,
} from "@/components/app/app-presentation"
import {
  DeployToApplyButton,
  ServiceTag,
  useAppRunsCompose,
} from "@/components/app/app-settings"
import { DataTableActionGroup } from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
} from "@/components/drawer-popover"
import { InfoCopyValue, InfoSection } from "@/components/info-page"
import { useRelayPermission } from "@/components/relay/relay-settings"
import { StatusIndicator } from "@/components/status-indicator"
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
  type VolumeLink,
} from "@/components/volumes/volume-parts"
import {
  mountAwaitsDeploy,
  mountsLeftBehind,
  type WantedMount,
} from "@/lib/app-mount-drift"
import type { ComposeMount } from "@/lib/compose-mounts"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import type { DataTableSource } from "@/lib/data-table-source"
import { grantsAllowBackup } from "@/lib/backup-target-permissions"
import {
  accessCapabilitiesQueryOptions,
  appVolumesQueryOptions,
} from "@/lib/query-options"
import { warmSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"

const loadVolumeDialogs = () => import("@/components/app/app-volume-dialogs")
const AppVolumeDialog = React.lazy(() =>
  loadVolumeDialogs().then((module) => ({ default: module.AppVolumeDialog }))
)
const AppVolumeAddPanel = React.lazy(() =>
  loadVolumeDialogs().then((module) => ({ default: module.AppVolumeAddPanel }))
)
const AppVolumeRemoveDialog = React.lazy(() =>
  loadVolumeDialogs().then((module) => ({
    default: module.AppVolumeRemoveDialog,
  }))
)

type MountEntry =
  | { kind: "config"; mount: AppMount }
  // The Compose file, at a mount's definition if it's opened for one.
  | { kind: "compose"; mount: ComposeMount | null }

// A row reads the same whatever it mounts: what it is, where it's mounted,
// and a way into its files.
interface MountRow {
  // Where its backups are: a volume's own, or the App's for what's in its
  // folder. Null for what no backup covers, or that can't be read.
  backups: { volume?: string } | null
  // The Compose file that defines it, where it's changed, if one does.
  composeFile: string | null
  // Whether that file is edited here, rather than in its repository.
  composeEditable: boolean
  entry: MountEntry
  filesLink: VolumeLink | null
  filesUnavailable: string | null
  icon: "file" | "folder" | "volume"
  id: string
  // A volume the config mounts that no longer exists.
  missing: boolean
  name: string
  readOnly: boolean
  service: string | null
  sizeBytes: number | null
  target: string
  // What a container should show for it, to tell it's been deployed.
  wanted: WantedMount
}

type Dialog =
  // The Compose file, at a mount's definition if it's opened for one.
  | { kind: "compose"; mount: ComposeMount | null }
  | { kind: "edit"; mount: AppMount; name: string }
  | { entry: AppMount; kind: "file" }
  | { kind: "remove"; mount: AppMount; name: string }
  | null

const mountColumnHelper = createDataTableColumnHelper<MountRow>()

const volumeFilesHint = "Mount host files on this Relay to view its files"

const PENDING_DEPLOY = {
  detail: "Deploy this app to apply its volume changes.",
  label: "Pending deploy",
  tone: "warning",
} as const

// What the app mounts: the Relay's volumes, paths on the node, and files
// kept in its config, then what its Compose file mounts itself. Its
// containers keep nothing else across deploys. Changes apply on the next
// deploy.
export function AppVolumesSection({
  app,
  canManage,
  config,
  routeId,
}: {
  app: App
  canManage: boolean
  config: EditableAppConfig
  routeId: string
}) {
  const [dialog, setDialog] = React.useState<Dialog>(null)
  const compose = useAppRunsCompose(app)
  const { mounts } = config
  const composeFile = useAppComposeMounts(app, config)
  const { data: capabilities } = useQuery(accessCapabilitiesQueryOptions())
  const canReadHost = useRelayPermission(app.relayId, "relay.files.read")
  const canReadFiles = app.permissions.includes("app.files.read")
  const composeVolumes = composeFile?.mounts?.some(
    (mount) => mount.kind === "volume" && mount.source
  )
  const { data: appVolumes } = useQuery({
    ...appVolumesQueryOptions(app.relayId, app.id),
    select: mountVolumeDetails,
    refetchInterval: false,
    staleTime: 5 * 60_000,
    enabled:
      composeVolumes || mounts.some((mount) => mount.source.type !== "file"),
  })
  const rows = React.useMemo((): Array<MountRow> => {
    const context: RowContext = {
      app,
      // A path in the App's folder is backed up with the App.
      canReadBackups: Boolean(
        capabilities &&
        (capabilities.isPlatformAdmin ||
          grantsAllowBackup(
            capabilities.grants,
            { id: app.id, kind: "app", relayId: app.relayId },
            "backup.read"
          ))
      ),
      canReadFiles,
      canReadHost,
      composeFile,
      filesAvailable: appVolumes?.filesAvailable ?? false,
      readable: (id) =>
        id &&
        capabilities &&
        (capabilities.isPlatformAdmin ||
          grantsAllowBackup(
            capabilities.grants,
            { id, kind: "volume", relayId: app.relayId },
            "backup.read"
          ))
          ? id
          : null,
      referencesKnown: appVolumes?.referencesKnown ?? false,
      routeId,
      volumes: appVolumes?.volumes,
    }
    return [
      ...mounts.map((mount) => configRow(context, mount)),
      ...(composeFile?.mounts ?? []).map((mount) => composeRow(context, mount)),
    ]
  }, [
    app,
    canReadFiles,
    canReadHost,
    capabilities,
    appVolumes,
    composeFile,
    mounts,
    routeId,
  ])
  const empty = rows.length === 0
  const configRows = React.useMemo(
    () => rows.filter((row) => row.entry.kind === "config"),
    [rows]
  )
  const composeRows = React.useMemo(
    () => rows.filter((row) => row.entry.kind === "compose"),
    [rows]
  )
  const deploying = app.deployment?.state === "running"
  // A deployment under way is what would apply them.
  const running = React.useMemo(() => appContainers(app), [app])
  const awaiting = React.useMemo(
    () =>
      new Set(
        deploying
          ? []
          : rows.flatMap((row) =>
              mountAwaitsDeploy(running, row.wanted) ? [row.id] : []
            )
      ),
    [deploying, rows, running]
  )
  // A Compose file not read yet can't say what's no longer wanted.
  const composeKnown = !composeFile || composeFile.mounts !== null
  const pending =
    awaiting.size > 0 ||
    (!deploying &&
      composeKnown &&
      mountsLeftBehind(
        running,
        rows.map((row) => row.wanted),
        { compose }
      ))
  const close = React.useCallback((open: boolean) => {
    if (!open) setDialog(null)
  }, [])
  const addProps = { app, compose, deploying, routeId, saved: mounts }
  return (
    <InfoSection
      icon={<HardDrive />}
      title="Volumes"
      status={pending ? <StatusIndicator status={PENDING_DEPLOY} /> : null}
      action={
        <>
          {pending && canManage && appRelayAvailable(app) ? (
            <DeployToApplyButton app={app} />
          ) : null}
          {canManage && !empty ? (
            <AddVolumeButton {...addProps} align="end" variant="outline" />
          ) : null}
        </>
      }
      content={empty ? true : "flush"}
    >
      {empty ? (
        <div className="flex flex-col items-center gap-3 py-5 text-center">
          <p className="max-w-md text-[0.8125rem] text-muted-foreground">
            Nothing here is kept when the app redeploys. Add a volume for data
            that should stay, like uploads or settings.
          </p>
          {canManage ? (
            <AddVolumeButton {...addProps} align="center" variant="default" />
          ) : null}
        </div>
      ) : (
        // Their rows are all there is, so these tables aren't scroll areas of
        // their own: over them, the wheel scrolls the page.
        <div className="[&_tbody]:overflow-visible [&_tbody]:overscroll-auto">
          {configRows.length > 0 ? (
            <MountsTable
              app={app}
              awaiting={awaiting}
              canManage={canManage}
              compose={compose}
              hideHeader={false}
              rows={configRows}
              onDialog={setDialog}
            />
          ) : null}
          {composeRows.length > 0 ? (
            <>
              <ComposeGroupHeader
                editable={canManage && Boolean(composeFile?.editable)}
                file={composeFile?.path ?? "compose.yaml"}
                topBorder={configRows.length > 0}
                onOpen={() => setDialog({ kind: "compose", mount: null })}
              />
              <MountsTable
                app={app}
                awaiting={awaiting}
                canManage={canManage}
                compose={compose}
                hideHeader={configRows.length > 0}
                rows={composeRows}
                onDialog={setDialog}
              />
            </>
          ) : null}
        </div>
      )}
      <React.Suspense fallback={null}>
        {dialog?.kind === "edit" ? (
          <AppVolumeDialog
            app={app}
            compose={compose}
            deploying={deploying}
            editing={dialog.mount}
            editingName={dialog.name}
            routeId={routeId}
            saved={mounts}
            onOpenChange={close}
          />
        ) : null}
        {dialog?.kind === "remove" ? (
          <AppVolumeRemoveDialog
            app={app}
            config={{
              mounts: mounts.filter((mount) => mount.id !== dialog.mount.id),
            }}
            deploying={deploying}
            description={
              dialog.mount.source.type === "file"
                ? "The app stops mounting this file on its next deploy."
                : "The app stops mounting it on its next deploy. Its data stays, and you can add it back."
            }
            name={dialog.name}
            routeId={routeId}
            onOpenChange={close}
          />
        ) : null}
      </React.Suspense>
      {dialog?.kind === "compose" ? (
        composeFile?.github ? (
          <AppGitHubFileDialog
            app={app}
            cursorAt={dialog.mount?.range?.to}
            source={composeFile.github}
            onOpenChange={close}
          />
        ) : (
          <AppDocumentDialog
            app={app}
            canManage={canManage}
            deploying={deploying}
            cursorAt={dialog.mount?.range?.to}
            kind="compose"
            routeId={routeId}
            saved={config.compose}
            onOpenChange={close}
          />
        )
      ) : null}
      {dialog?.kind === "file" && dialog.entry.source.type === "file" ? (
        <AppCodeDialog
          app={app}
          canManage
          configFor={(draft) => ({
            mounts: mounts.map((entry) =>
              entry.id === dialog.entry.id
                ? { ...entry, source: { content: draft, type: "file" } }
                : entry
            ),
          })}
          deploying={deploying}
          document={{
            hint: `Mounted at ${dialog.entry.target}.`,
            noun: "file",
            path: fileName(dialog.entry.target),
            placeholder: "",
          }}
          routeId={routeId}
          saved={dialog.entry.source.content}
          onOpenChange={close}
        />
      ) : null}
    </InfoSection>
  )
}

// Opens the picker where it's pressed. What's chosen goes on in the same
// popover, and closing it drops whatever wasn't added.
function AddVolumeButton({
  align,
  variant,
  ...panel
}: Omit<React.ComponentProps<typeof AppVolumeAddPanel>, "onDone"> & {
  align: "center" | "end"
  variant: "default" | "outline"
}) {
  const [open, setOpen] = React.useState(false)
  const close = React.useCallback(() => setOpen(false), [])
  return (
    <DrawerPopover open={open} onOpenChange={setOpen}>
      <DrawerPopoverTrigger asChild>
        <Button
          aria-expanded={open}
          size="sm"
          type="button"
          variant={variant}
          onFocus={() => void loadVolumeDialogs()}
          onPointerEnter={() => void loadVolumeDialogs()}
        >
          <Plus />
          Add volume
        </Button>
      </DrawerPopoverTrigger>
      <DrawerPopoverContent
        title="Add volume"
        align={align}
        className="w-[26rem] max-w-[calc(100vw-1rem)] overflow-hidden p-0"
      >
        <React.Suspense
          fallback={
            <div className="grid h-24 place-items-center">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <AppVolumeAddPanel {...panel} onDone={close} />
        </React.Suspense>
      </DrawerPopoverContent>
    </DrawerPopover>
  )
}

const MountsTable = React.memo(function MountsTable({
  app,
  awaiting,
  canManage,
  compose,
  hideHeader,
  onDialog,
  rows,
}: {
  app: App
  // The rows a deploy has yet to apply.
  awaiting: ReadonlySet<string>
  canManage: boolean
  // Whether it runs a Compose file, so each mount names its services.
  compose: boolean
  // For rows under another table's headers.
  hideHeader: boolean
  onDialog: (dialog: Dialog) => void
  rows: Array<MountRow>
}) {
  const source = React.useMemo(
    (): DataTableSource<MountRow> => ({
      body: { kind: "ready" },
      refreshing: false,
      rows,
    }),
    [rows]
  )
  const definition = React.useMemo(
    () =>
      defineDataTable({
        ariaLabel: "Volumes",
        hideHeader,
        columns: mountColumnHelper.columns([
          mountColumnHelper.accessor((row) => row.name, {
            id: "volume",
            header: "Volume",
            sortFn: "text",
            cell: ({ row }) => (
              <MountIdentity
                pending={awaiting.has(row.original.id)}
                row={row.original}
              />
            ),
            meta: dataTableColumnMeta({ width: "minmax(0,1fr)" }),
          }),
          // Only a Compose file runs more than one service to tell apart.
          ...(compose
            ? [
                mountColumnHelper.accessor((row) => row.service ?? "", {
                  id: "services",
                  header: "Services",
                  sortFn: "text",
                  cell: ({ row }) => (
                    <MountServices app={app} service={row.original.service} />
                  ),
                  meta: dataTableColumnMeta(
                    { hideBelow: "md", width: "9.5rem" },
                    {
                      cellClassName: "justify-end",
                      headerClassName: "justify-end",
                    }
                  ),
                }),
              ]
            : []),
          mountColumnHelper.accessor((row) => row.sizeBytes ?? -1, {
            id: "size",
            header: "Size",
            sortFn: sortFn_basic,
            cell: ({ row }) =>
              row.original.icon === "volume" ? (
                <VolumeSize sizeBytes={row.original.sizeBytes} />
              ) : null,
            meta: dataTableColumnMeta({ hideBelow: "sm", width: "6rem" }),
          }),
          mountColumnHelper.display({
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }) => (
              <MountActions
                app={app}
                canManage={canManage}
                row={row.original}
                onDialog={onDialog}
              />
            ),
            meta: dataTableColumnMeta(
              { width: VOLUME_ACTIONS_WIDTH },
              { cellClassName: "px-1 sm:px-2", headerClassName: "px-1 sm:px-2" }
            ),
          }),
        ]),
        getRowId: (row) => row.id,
      }),
    [app, awaiting, canManage, compose, hideHeader, onDialog]
  )
  return <DataTable definition={definition} emptyState={null} source={source} />
})

// Above the mounts a Compose file defines: they're the file's, not settings
// here, so this says so once and is the way in.
function ComposeGroupHeader({
  editable,
  file,
  onOpen,
  topBorder,
}: {
  editable: boolean
  file: string
  onOpen: () => void
  topBorder: boolean
}) {
  return (
    <div
      className={cn(
        "flex min-h-10 items-center gap-2 border-b bg-muted/20 py-1 pr-2 pl-3",
        topBorder && "border-t"
      )}
    >
      <FileCode2
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="min-w-0 truncate font-mono text-xs font-medium">
        {file}
      </span>
      <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">
        Defined in the Compose file
      </span>
      <Button
        className="ml-auto shrink-0"
        size="xs"
        type="button"
        variant="outline"
        onClick={onOpen}
      >
        {editable ? "Edit file" : "View file"}
      </Button>
    </div>
  )
}

const mountIcons = {
  file: <FileText className="size-4" aria-hidden="true" />,
  folder: <FolderTree className="size-4" aria-hidden="true" />,
}

// The services a mount is in: the one it names, or every one running. Before
// a first deploy there are none to name yet.
function MountServices({ app, service }: { app: App; service: string | null }) {
  const services = service ? [service] : appServices(app)
  if (services.length === 0) {
    return <span className="type-meta text-muted-foreground">Every</span>
  }
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {services.map((name) => (
        <ServiceTag key={name} app={app} service={name} />
      ))}
    </span>
  )
}

function MountIdentity({ pending, row }: { pending: boolean; row: MountRow }) {
  return (
    <VolumeCard
      icon={row.icon === "volume" ? undefined : mountIcons[row.icon]}
      status={pending ? PENDING_DEPLOY : undefined}
      meta={
        <InfoCopyValue
          className="max-w-full text-[length:inherit] hover:text-foreground"
          label="mount path"
          value={row.target}
        />
      }
      metaClassName="font-mono"
      name={row.name}
      nameClassName={row.missing ? "text-destructive" : undefined}
      nameAccessory={row.readOnly ? <VolumeTag>Read-only</VolumeTag> : null}
    />
  )
}

function MountActions({
  app,
  canManage,
  onDialog,
  row,
}: {
  app: App
  canManage: boolean
  onDialog: (dialog: Dialog) => void
  row: MountRow
}) {
  const { entry } = row
  const warmDialogs = () => void loadVolumeDialogs()
  const fileMount =
    canManage && entry.kind === "config" && entry.mount.source.type === "file"
      ? entry.mount
      : null
  const composeEdit = canManage && row.composeEditable
  return (
    <DataTableActionGroup>
      {entry.kind === "compose" ? (
        <VolumeAction
          label={`${composeEdit ? "Edit" : "View"} ${row.name} in ${row.composeFile}`}
          tooltip={`${composeEdit ? "Edit" : "View"} in ${row.composeFile}`}
          onClick={() => onDialog({ kind: "compose", mount: entry.mount })}
          onWarm={warmSyntaxCodeEditorModule}
        >
          {composeEdit ? <Pencil /> : <FileCode2 />}
        </VolumeAction>
      ) : canManage ? (
        <VolumeAction
          label={`Edit ${row.name}`}
          tooltip="Edit"
          onClick={() =>
            onDialog({ kind: "edit", mount: entry.mount, name: row.name })
          }
          onWarm={warmDialogs}
        >
          <Pencil />
        </VolumeAction>
      ) : (
        <VolumeActionGap />
      )}
      {fileMount ? (
        <VolumeAction
          label={`Edit the contents of ${row.name}`}
          tooltip="Edit contents"
          onClick={() => {
            warmSyntaxCodeEditorModule()
            onDialog({ entry: fileMount, kind: "file" })
          }}
          onWarm={warmSyntaxCodeEditorModule}
        >
          <FileText />
        </VolumeAction>
      ) : (
        <VolumeFilesButton
          label={`View files in ${row.name}`}
          link={row.filesLink}
          unavailable={row.filesUnavailable}
        />
      )}
      {row.backups ? (
        <VolumeActionLink
          label={`Backups of ${row.name}`}
          link={{
            params: {},
            search: {
              kind: "app",
              relay: app.relayId,
              server: app.id,
              ...row.backups,
            },
            to: "/backups/runs",
          }}
          tooltip="Backups"
        >
          <Archive />
        </VolumeActionLink>
      ) : (
        <VolumeActionGap />
      )}
      {canManage ? (
        <VolumeDeleteAction
          blocked={
            entry.kind === "config"
              ? null
              : row.composeEditable
                ? `Defined in ${row.composeFile}, so remove it there`
                : `Defined in ${row.composeFile} in the repository, so remove it there`
          }
          label={`Remove ${row.name}`}
          tooltip="Remove"
          onClick={() => {
            if (entry.kind !== "config") return
            onDialog({ kind: "remove", mount: entry.mount, name: row.name })
          }}
          onWarm={warmDialogs}
        />
      ) : (
        <VolumeActionGap />
      )}
    </DataTableActionGroup>
  )
}

interface RowContext {
  app: App
  canReadBackups: boolean
  canReadFiles: boolean
  canReadHost: boolean
  composeFile: AppComposeMounts | null
  filesAvailable: boolean
  readable: (id: string | null | undefined) => string | null
  // Whether a configured volume that isn't listed is really gone.
  referencesKnown: boolean
  routeId: string
  volumes: ReadonlyArray<MountVolume> | undefined
}

function volumeFilesLink(
  { routeId }: RowContext,
  volumeId: string
): VolumeLink {
  return {
    params: { appId: routeId },
    search: { volume: volumeId },
    to: "/app/$appId/files",
  }
}

// A path on the node opens in its Relay's Files, for those who can read them.
function hostFilesLink(
  { app, canReadHost, filesAvailable }: RowContext,
  path: string
): VolumeLink | null {
  if (!canReadHost || !filesAvailable) return null
  return {
    params: {
      _splat: `${path.replace(/^\/+/u, "").replace(/\/+$/u, "")}/`,
      relayId: app.relayId,
    },
    to: "/relay/$relayId/files/$",
  }
}

function volumeFiles(context: RowContext, volumeId: string | null | undefined) {
  if (!volumeId || !context.canReadFiles) {
    return { filesLink: null, filesUnavailable: null }
  }
  return context.filesAvailable
    ? {
        filesLink: volumeFilesLink(context, volumeId),
        filesUnavailable: null,
      }
    : { filesLink: null, filesUnavailable: volumeFilesHint }
}

function volumeBackups(context: RowContext, id: string | null | undefined) {
  const volume = context.readable(id)
  return volume ? { volume } : null
}

function configRow(context: RowContext, mount: AppMount): MountRow {
  const { source } = mount
  const wanted = (shown: Pick<WantedMount, "readOnly" | "source">) => ({
    ...shown,
    service: mount.service,
    target: mount.target,
  })
  const base = {
    composeEditable: false,
    composeFile: null,
    entry: { kind: "config", mount } as const,
    id: `config:${mount.id}`,
    missing: false,
    readOnly: mount.readOnly,
    service: mount.service,
    target: mount.target,
  }
  switch (source.type) {
    case "volume": {
      const volume = context.volumes?.find(
        (candidate) => candidate.id === source.volumeId
      )
      const missing =
        context.volumes !== undefined && context.referencesKnown && !volume
      return {
        ...base,
        ...volumeFiles(context, missing ? null : source.volumeId),
        backups: volumeBackups(context, source.volumeId),
        icon: "volume",
        missing,
        name: missing
          ? "Volume deleted"
          : (volume?.name ?? `Volume ${source.volumeId.slice(0, 8)}`),
        sizeBytes: volume?.sizeBytes ?? null,
        wanted: wanted({
          readOnly: mount.readOnly,
          source: volume?.dockerName ?? null,
        }),
      }
    }
    case "host":
      return {
        ...base,
        backups: null,
        filesLink: hostFilesLink(context, source.path),
        filesUnavailable: null,
        icon: "folder",
        name: source.path,
        sizeBytes: null,
        wanted: wanted({ readOnly: mount.readOnly, source: source.path }),
      }
    case "file":
      return {
        ...base,
        backups: null,
        filesLink: null,
        filesUnavailable: null,
        icon: "file",
        name: fileName(mount.target),
        sizeBytes: null,
        // Kept on the node under its deployment, so its name is what shows.
        wanted: {
          ...wanted({ readOnly: mount.readOnly, source: null }),
          // Those who can't manage the app get its files without their
          // contents, so there's nothing of theirs to compare.
          ...(context.app.permissions.includes("app.manage") && {
            sourceFile: appMountFileName(mount.id, source.content),
          }),
        },
      }
  }
}

function composeRow(context: RowContext, mount: ComposeMount): MountRow {
  const relative = mount.kind === "bind" && mount.source.startsWith(".")
  const file = context.composeFile?.path ?? "compose.yaml"
  const volume =
    mount.kind === "volume" && mount.source
      ? context.volumes?.find(
          (candidate) =>
            candidate.owner?.appId === context.app.id &&
            candidate.owner.volume === mount.source
        )
      : undefined
  const volumeId = volume?.id
  const files =
    mount.kind === "volume"
      ? volumeFiles(context, volumeId)
      : mount.kind === "bind"
        ? {
            filesLink: relative
              ? appFolderLink(context, mount.source)
              : hostFilesLink(context, mount.source),
            filesUnavailable: null,
          }
        : { filesLink: null, filesUnavailable: null }
  return {
    ...files,
    backups:
      mount.kind === "volume"
        ? volumeBackups(context, volumeId)
        : relative && context.canReadBackups
          ? {}
          : null,
    composeEditable: context.composeFile?.editable ?? false,
    composeFile: file,
    entry: { kind: "compose", mount },
    icon:
      mount.kind === "volume"
        ? "volume"
        : mount.kind === "bind"
          ? "folder"
          : "file",
    id: `compose:${mount.key}`,
    missing: false,
    name:
      mount.kind === "volume"
        ? mount.source || "Anonymous volume"
        : mount.source,
    readOnly: mount.readOnly,
    service: mount.service,
    sizeBytes: volume?.sizeBytes ?? null,
    target: mount.target,
    wanted: {
      // A config's or secret's access is its own, and a relative path is
      // the node's by then.
      readOnly:
        mount.kind === "volume" || mount.kind === "bind"
          ? mount.readOnly
          : null,
      service: mount.service,
      source:
        mount.kind === "volume"
          ? mount.dockerName
          : mount.kind === "bind" && mount.source.startsWith("/")
            ? mount.source
            : null,
      target: mount.target,
    },
  }
}

// A Compose file's relative path is under the app's folder on the node.
function appFolderLink({ routeId }: RowContext, source: string): VolumeLink {
  const path = source.replace(/^\.\/?/u, "").replace(/\/+$/u, "")
  return {
    params: { _splat: path ? `${path}/` : "", appId: routeId },
    to: "/app/$appId/files/$",
  }
}

type MountVolume = Pick<
  RelayVolume,
  "dockerName" | "id" | "name" | "owner" | "sizeBytes"
>

// Only what the rows show, so anything else about a volume can't repaint them.
function mountVolumeDetails(data: {
  filesAvailable: boolean
  referencesKnown: boolean
  volumes: ReadonlyArray<RelayVolume>
}) {
  return {
    filesAvailable: data.filesAvailable,
    referencesKnown: data.referencesKnown,
    volumes: data.volumes.map(
      ({ dockerName, id, name, owner, sizeBytes }): MountVolume => ({
        dockerName,
        id,
        name,
        owner,
        sizeBytes,
      })
    ),
  }
}

function fileName(target: string): string {
  return target.split("/").filter(Boolean).at(-1) ?? target
}
