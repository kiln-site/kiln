import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import type { AppMount, RelayVolume } from "@workspace/contracts"
import { Link } from "@tanstack/react-router"
import {
  Archive,
  FileText,
  FolderTree,
  HardDrive,
  Settings2,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import {
  AppCodeDialog,
  type EditableAppConfig,
} from "@/components/app/app-config-dialogs"
import { useAppComposeMounts } from "@/components/app/app-compose-mounts"
import { AppMountsDialog } from "@/components/app/app-mounts-dialog"
import type { App } from "@/components/app/app-presentation"
import { ServiceTag, useAppRunsCompose } from "@/components/app/app-settings"
import { DataTable } from "@/components/data-table-view"
import { InfoCopyValue, InfoSection } from "@/components/info-page"
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
  appBackupsQueryOptions,
  relayVolumesQueryOptions,
} from "@/lib/query-options"
import { warmSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"

// A mount the config keeps, or one the Compose file declares. Each row
// carries what its cells need, so the columns don't change with the data.
type MountRow = { backupVolumeId?: string | undefined } & (
  | {
      app: App
      canManage: boolean
      id: string
      kind: "config"
      mount: AppMount
      mounts: ReadonlyArray<AppMount>
      routeId: string
      volumeNames: ReadonlyMap<string, string> | undefined
    }
  | {
      app: App
      file: string
      id: string
      kind: "compose"
      mount: ComposeMount
    }
)

const mountColumnHelper = createDataTableColumnHelper<MountRow>()

// What the app mounts: the Relay's volumes, paths on the node, and files
// kept in its config, which open in the code dialog, then what its Compose
// file mounts itself. Its containers keep nothing else across deploys.
// Configure changes them; they apply on the next deploy.
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
  const [configuring, setConfiguring] = React.useState(false)
  const compose = useAppRunsCompose(app)
  const { mounts } = config
  const composeFile = useAppComposeMounts(app, config)
  const { data: capabilities } = useQuery(accessCapabilitiesQueryOptions())
  const { data: volumes } = useQuery({
    ...relayVolumesQueryOptions(app.relayId),
    select: mountVolumeDetails,
    refetchInterval: false,
    staleTime: 5 * 60_000,
    enabled: mounts.some((mount) => mount.source.type === "volume"),
  })
  const { data: ownedVolumes } = useQuery({
    ...appBackupsQueryOptions(app.relayId, app.id),
    select: appVolumeDetails,
    refetchInterval: false,
    staleTime: 5 * 60_000,
    enabled: Boolean(
      composeFile?.mounts?.some(
        (mount) => mount.kind === "volume" && mount.source
      )
    ),
  })
  const volumeNames = React.useMemo(
    () => (volumes ? volumeNamesById(volumes) : undefined),
    [volumes]
  )
  const rows = React.useMemo((): Array<MountRow> => {
    const readable = (id: string | undefined) =>
      id &&
      capabilities &&
      (capabilities.isPlatformAdmin ||
        grantsAllowBackup(
          capabilities.grants,
          { id, kind: "volume", relayId: app.relayId },
          "backup.read"
        ))
        ? id
        : undefined
    return [
      ...mounts.map((mount) => ({
        app,
        canManage,
        id: `config:${mount.id}`,
        kind: "config" as const,
        backupVolumeId: readable(
          mount.source.type === "volume" ? mount.source.volumeId : undefined
        ),
        mount,
        mounts,
        routeId,
        volumeNames,
      })),
      ...(composeFile?.mounts ?? []).map((mount) => ({
        app,
        file: composeFile?.path ?? "compose.yaml",
        id: `compose:${mount.key}`,
        kind: "compose" as const,
        backupVolumeId: readable(
          mount.kind === "volume" && mount.source
            ? (ownedVolumes?.find((volume) => volume.name === mount.source)
                ?.id ?? undefined)
            : undefined
        ),
        mount,
      })),
    ]
  }, [
    app,
    canManage,
    capabilities,
    composeFile,
    mounts,
    ownedVolumes,
    routeId,
    volumeNames,
    volumes,
  ])
  const empty = rows.length === 0
  return (
    <InfoSection
      icon={<HardDrive />}
      title="Volumes"
      action={
        canManage ? (
          <>
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => setConfiguring(true)}
            >
              <Settings2 />
              Configure
            </Button>
            {configuring ? (
              <AppMountsDialog
                app={app}
                compose={compose}
                composeFile={composeFile}
                savedCompose={config.compose}
                deploying={app.deployment?.state === "running"}
                routeId={routeId}
                saved={mounts}
                onOpenChange={setConfiguring}
              />
            ) : null}
          </>
        ) : null
      }
      content={empty ? true : "flush"}
    >
      {empty ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          Nothing yet, so the app keeps no data across deploys. Mount a volume
          to keep or share data, a path on the node, or a file.
        </p>
      ) : (
        <MountsTable compose={compose} rows={rows} />
      )}
    </InfoSection>
  )
}

const MountsTable = React.memo(function MountsTable({
  compose,
  rows,
}: {
  // Whether it runs a Compose file, so each mount names its service.
  compose: boolean
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
        columns: mountColumnHelper.columns([
          mountColumnHelper.accessor(mountSourceText, {
            id: "source",
            header: "Source",
            sortFn: "text",
            cell: ({ row }) => <MountSourceCell row={row.original} />,
            meta: dataTableColumnMeta({ width: "minmax(0,1.3fr)" }),
          }),
          mountColumnHelper.accessor((row) => row.mount.target, {
            id: "target",
            header: "Mounted at",
            sortFn: "text",
            cell: ({ row }) => (
              <div className="flex w-full min-w-0">
                <InfoCopyValue
                  label="mount path"
                  value={row.original.mount.target}
                />
              </div>
            ),
            meta: dataTableColumnMeta({ width: "minmax(0,1fr)" }),
          }),
          ...(compose
            ? [
                mountColumnHelper.accessor((row) => row.mount.service ?? "", {
                  id: "service",
                  header: "Service",
                  sortFn: "text",
                  cell: ({ row }) =>
                    row.original.mount.service ? (
                      <ServiceTag
                        app={row.original.app}
                        service={row.original.mount.service}
                      />
                    ) : (
                      <span className="text-muted-foreground">Every</span>
                    ),
                  meta: dataTableColumnMeta({
                    hideBelow: "sm",
                    width: "8rem",
                  }),
                }),
              ]
            : []),
          mountColumnHelper.accessor(
            (row) => (row.mount.readOnly ? "Read-only" : "Read-write"),
            {
              id: "access",
              header: "Access",
              sortFn: "text",
              cell: ({ getValue }) => (
                <span className="text-muted-foreground">{getValue()}</span>
              ),
              meta: dataTableColumnMeta({ hideBelow: "md", width: "7rem" }),
            }
          ),
          mountColumnHelper.accessor((row) => row.backupVolumeId ?? "", {
            id: "backups",
            header: "",
            cell: ({ row }) =>
              row.original.backupVolumeId ? (
                <Button asChild size="xs" variant="outline">
                  <Link
                    to="/backups/runs"
                    search={{
                      kind: "app",
                      relay: row.original.app.relayId,
                      server: row.original.app.id,
                      volume: row.original.backupVolumeId,
                    }}
                  >
                    <Archive />
                    Backups
                  </Link>
                </Button>
              ) : null,
            meta: dataTableColumnMeta({ width: "7rem" }),
          }),
        ]),
        getRowId: (row) => row.id,
      }),
    [compose]
  )
  return <DataTable definition={definition} emptyState={null} source={source} />
})

function mountSourceText(row: MountRow): string {
  if (row.kind === "compose") return row.mount.dockerName ?? row.mount.source
  const { source } = row.mount
  return source.type === "volume"
    ? (row.volumeNames?.get(source.volumeId) ?? "")
    : source.type === "host"
      ? source.path
      : fileName(row.mount.target)
}

function MountSourceCell({ row }: { row: MountRow }) {
  return row.kind === "config" ? (
    <AppMountSource
      app={row.app}
      canManage={row.canManage}
      mount={row.mount}
      mounts={row.mounts}
      routeId={row.routeId}
      volumeNames={row.volumeNames}
    />
  ) : (
    <ComposeMountSource file={row.file} mount={row.mount} />
  )
}

// A mount the Compose file declares, marked as the file's.
function ComposeMountSource({
  file,
  mount,
}: {
  file: string
  mount: ComposeMount
}) {
  const relative = mount.kind === "bind" && mount.source.startsWith(".")
  const [icon, label, title] =
    mount.kind === "volume"
      ? [
          <HardDrive />,
          mount.dockerName ?? "Anonymous volume",
          mount.dockerName
            ? `Volume ${mount.source}, ${mount.dockerName} in Docker`
            : "A volume of its own, made anew with each container",
        ]
      : mount.kind === "bind"
        ? [
            <FolderTree />,
            mount.source,
            relative
              ? `${mount.source} in the app's folder on the node`
              : `${mount.source} on the node`,
          ]
        : [
            <FileText />,
            mount.source,
            `${mount.kind === "config" ? "Config" : "Secret"} ${mount.source}${mount.origin ? `, from ${mount.origin}` : ""}`,
          ]
  return (
    <span className="flex min-w-0 items-center gap-2" title={title}>
      <span className="shrink-0 text-muted-foreground [&>svg]:size-3.5">
        {icon}
      </span>
      <span
        className={
          mount.kind === "volume" && mount.dockerName
            ? "truncate"
            : "truncate font-mono text-xs"
        }
      >
        {label}
      </span>
      <span
        className="shrink-0 border px-1 font-mono text-[10px] text-muted-foreground"
        title={`Declared in ${file}`}
      >
        {file}
      </span>
    </span>
  )
}

// Select only identity: backup task updates must not repaint the Info table.
function appVolumeDetails(data: {
  targets: ReadonlyArray<{ id: string; kind: string; name: string | null }>
}) {
  return data.targets
    .filter((target) => target.kind === "volume")
    .map(({ id, name }) => ({ id, name }))
}

// Ignore measurement and mount updates: these rows only need identity and names.
function mountVolumeDetails(data: { volumes: ReadonlyArray<RelayVolume> }) {
  return {
    volumes: data.volumes.map(({ id, name, owner }) => ({ id, name, owner })),
  }
}

function volumeNamesById(data: {
  volumes: ReadonlyArray<Pick<RelayVolume, "id" | "name">>
}): ReadonlyMap<string, string> {
  return new Map(
    data.volumes.flatMap((volume) =>
      volume.id ? [[volume.id, volume.name] as const] : []
    )
  )
}

function AppMountSource({
  app,
  canManage,
  mount,
  mounts,
  routeId,
  volumeNames,
}: {
  app: App
  canManage: boolean
  mount: AppMount
  mounts: ReadonlyArray<AppMount>
  routeId: string
  volumeNames: ReadonlyMap<string, string> | undefined
}) {
  const { source } = mount
  switch (source.type) {
    case "volume": {
      const name = volumeNames?.get(source.volumeId)
      return (
        <span className="flex min-w-0 items-center gap-2">
          <HardDrive className="size-3.5 shrink-0 text-muted-foreground" />
          {volumeNames && name === undefined ? (
            <span className="truncate text-destructive">Volume deleted</span>
          ) : (
            <span className="truncate" title={name}>
              {name ?? `Volume ${source.volumeId.slice(0, 8)}`}
            </span>
          )}
        </span>
      )
    }
    case "host":
      return (
        <span
          className="flex min-w-0 items-center gap-2"
          title={`${source.path} on the node`}
        >
          <FolderTree className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs">{source.path}</span>
        </span>
      )
    case "file":
      return canManage ? (
        <AppMountFileButton
          app={app}
          content={source.content}
          mount={mount}
          mounts={mounts}
          routeId={routeId}
        />
      ) : (
        <span className="flex min-w-0 items-center gap-2">
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs">
            {fileName(mount.target)}
          </span>
        </span>
      )
  }
}

// A file the config mounts, edited in the code dialog. Saving it saves the
// mounts as they are with its new contents.
function AppMountFileButton({
  app,
  content,
  mount,
  mounts,
  routeId,
}: {
  app: App
  content: string
  mount: AppMount
  mounts: ReadonlyArray<AppMount>
  routeId: string
}) {
  const [open, setOpen] = React.useState(false)
  const name = fileName(mount.target)
  return (
    <>
      <Button
        className="max-w-full"
        size="xs"
        type="button"
        variant="outline"
        onPointerEnter={warmSyntaxCodeEditorModule}
        onFocus={warmSyntaxCodeEditorModule}
        onClick={() => {
          warmSyntaxCodeEditorModule()
          setOpen(true)
        }}
      >
        <FileText />
        <span className="truncate font-mono">{name}</span>
      </Button>
      {open ? (
        <AppCodeDialog
          app={app}
          canManage
          configFor={(draft) => ({
            mounts: mounts.map((entry) =>
              entry.id === mount.id
                ? { ...entry, source: { content: draft, type: "file" } }
                : entry
            ),
          })}
          deploying={app.deployment?.state === "running"}
          document={{
            hint: `Mounted at ${mount.target}.`,
            noun: "file",
            path: name,
            placeholder: "",
          }}
          routeId={routeId}
          saved={content}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  )
}

function fileName(target: string): string {
  return target.split("/").filter(Boolean).at(-1) ?? target
}
