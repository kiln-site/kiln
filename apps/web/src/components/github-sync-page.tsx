import * as React from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { sortFn_basic } from "@tanstack/react-table"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import {
  EllipsisVertical,
  ExternalLink,
  Files,
  GitCommitHorizontal,
  FolderGit2,
  FolderSync,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { showToast } from "@workspace/ui/components/sonner"
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
import { GitHubMark } from "@/components/github-mark"
import { IdentityName } from "@/components/identity-name"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { InfraSyncButton } from "@/components/infra-sync-button"
import { InstanceCard } from "@/components/instance-card"
import { AppKindIcon, ServerKindIcon } from "@/components/instance-kind-icon"
import { statusColumnWidth } from "@/components/instance-name-presentation"
import { RelativeTime } from "@/components/relative-time"
import {
  useScheduleScope,
  type ScheduleScope,
} from "@/components/schedule-scope"
import { StatusIndicator } from "@/components/status-indicator"
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
import {
  githubSyncOverviewQueryOptions,
  queryKeys,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import { runGitHubSync } from "@/server/github-sync"
import type { GitHubSyncView } from "@/server/github-sync.server"

// The dialogs load on first use; idle time warms them so opening one
// doesn't wait on the network.
const loadDialogs = () => import("@/components/github-sync-dialogs")
const GitHubSyncEditorDialog = React.lazy(() =>
  loadDialogs().then((module) => ({ default: module.GitHubSyncEditorDialog }))
)
const DeleteSyncDialog = React.lazy(() =>
  loadDialogs().then((module) => ({ default: module.DeleteSyncDialog }))
)

type OpenDialog =
  | { kind: "delete"; sync: GitHubSyncView }
  | { kind: "edit"; sync: GitHubSyncView }

export const GitHubSyncPage = React.memo(function GitHubSyncPage() {
  const { data } = useSuspenseQuery({
    ...githubSyncOverviewQueryOptions(),
    notifyOnChangeProps: ["data"],
  })
  const scope = useScheduleScope()
  const [searchStore] = React.useState(() => createDataTableSearchStore())
  const [dialog, setDialog] = React.useState<OpenDialog | null>(null)
  // Creating lives in the URL, so Sources can open it with a source chosen.
  const creating = useSearch({
    from: "/_app/automations/sync",
    select: (search) => search.create === true,
  })
  const preselectedSource = useSearch({
    from: "/_app/automations/sync",
    select: (search) => search.source,
  })
  const navigate = useNavigate({ from: "/automations/sync" })

  React.useEffect(() => {
    const idle = window.requestIdleCallback?.(() => void loadDialogs())
    return () => {
      if (idle !== undefined) window.cancelIdleCallback(idle)
    }
  }, [])

  const scopedSyncs = React.useMemo(
    () =>
      scope
        ? data.syncs.filter((sync) => syncMatchesScope(sync, scope))
        : data.syncs,
    [data.syncs, scope]
  )
  const scopedTarget = React.useMemo(
    () =>
      scope && "id" in scope
        ? (data.targets.find(
            (target) =>
              target.id === scope.id &&
              target.relayId === scope.relayId &&
              target.kind === scope.kind
          ) ?? null)
        : null,
    [data.targets, scope]
  )
  const hasSource = data.sources.some(
    (source) => source.installation && !source.installation.suspended
  )
  const canCreate = hasSource && data.targets.length > 0
  const setCreating = React.useCallback(
    (open: boolean) => {
      void navigate({
        replace: !open,
        search: (previous) => ({
          ...previous,
          create: open ? true : undefined,
          source: undefined,
        }),
      })
    },
    [navigate]
  )
  const openCreate = React.useCallback(() => setCreating(true), [setCreating])
  const closeCreate = React.useCallback(() => setCreating(false), [setCreating])
  const openEdit = React.useCallback(
    (sync: GitHubSyncView) => setDialog({ kind: "edit", sync }),
    []
  )
  const openDelete = React.useCallback(
    (sync: GitHubSyncView) => setDialog({ kind: "delete", sync }),
    []
  )
  const close = React.useCallback(() => setDialog(null), [])
  // Set as variables the column widths read, so the columns stay memoized.
  const columnWidths = React.useMemo(
    () => syncColumnWidths(scopedSyncs),
    [scopedSyncs]
  )

  return (
    <div
      className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-3 pb-3 sm:px-5 sm:pb-5"
      style={columnWidths}
    >
      <DataTableWorkspace
        toolbar={
          <SyncToolbar
            canCreate={canCreate}
            createBlockedReason={
              !hasSource
                ? "Add a source in Infrastructure first"
                : data.targets.length === 0
                  ? "You can't edit files on any game server or app"
                  : null
            }
            searchStore={searchStore}
            onCreate={openCreate}
          />
        }
      >
        <SyncTable
          canCreate={canCreate}
          hasSource={hasSource}
          hasTargets={data.targets.length > 0}
          scopeActive={scope !== null}
          searchStore={searchStore}
          syncs={scopedSyncs}
          onCreate={openCreate}
          onDelete={openDelete}
          onEdit={openEdit}
        />
      </DataTableWorkspace>

      <React.Suspense fallback={null}>
        {creating && canCreate ? (
          <GitHubSyncEditorDialog
            initialSourceId={preselectedSource ?? null}
            initialTarget={scopedTarget}
            sources={data.sources}
            sync={null}
            targets={data.targets}
            onClose={closeCreate}
          />
        ) : null}
        {dialog?.kind === "edit" ? (
          <GitHubSyncEditorDialog
            initialSourceId={null}
            initialTarget={null}
            sources={data.sources}
            sync={dialog.sync}
            targets={data.targets}
            onClose={close}
          />
        ) : null}
        {dialog?.kind === "delete" ? (
          <DeleteSyncDialog sync={dialog.sync} onClose={close} />
        ) : null}
      </React.Suspense>
    </div>
  )
})

const SyncToolbar = React.memo(function SyncToolbar({
  canCreate,
  createBlockedReason,
  searchStore,
  onCreate,
}: {
  canCreate: boolean
  createBlockedReason: string | null
  searchStore: DataTableSearchStore
  onCreate: () => void
}) {
  const search = React.useMemo(
    () => ({
      ariaLabel: "Search syncs",
      closeMobileWhenEmpty: true,
      id: "github-sync-search",
      placeholder: "Search syncs",
      store: searchStore,
    }),
    [searchStore]
  )
  const createButton = (
    <Button
      aria-label="Create sync"
      size="sm"
      disabled={!canCreate}
      onClick={onCreate}
    >
      <Plus />
      <span className="hidden sm:inline">Create sync</span>
    </Button>
  )
  return (
    <DataTableToolbar
      actions={
        <>
          <Button asChild size="sm" variant="outline">
            <Link to="/infra/sources" aria-label="Sources">
              <FolderGit2 />
              <span className="hidden sm:inline">Sources</span>
            </Link>
          </Button>
          {createBlockedReason ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>{createButton}</span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createBlockedReason}
              </TooltipContent>
            </Tooltip>
          ) : (
            createButton
          )}
        </>
      }
      leading={<SyncRefreshButton />}
      search={search}
    />
  )
})

const SyncRefreshButton = React.memo(function SyncRefreshButton() {
  const queryClient = useQueryClient()
  const refresh = React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.github.overview }),
    [queryClient]
  )
  return <InfraSyncButton label="Refresh syncs" sync={refresh} />
})

const syncColumnHelper = createDataTableColumnHelper<GitHubSyncView>()
const syncSearchFields = [syncSearchText] as const

const SyncTable = React.memo(function SyncTable({
  canCreate,
  hasSource,
  hasTargets,
  scopeActive,
  searchStore,
  syncs,
  onCreate,
  onDelete,
  onEdit,
}: {
  canCreate: boolean
  hasSource: boolean
  hasTargets: boolean
  scopeActive: boolean
  searchStore: DataTableSearchStore
  syncs: Array<GitHubSyncView>
  onCreate: () => void
  onDelete: (sync: GitHubSyncView) => void
  onEdit: (sync: GitHubSyncView) => void
}) {
  const source = React.useMemo(
    (): DataTableSource<GitHubSyncView> => ({
      body: { kind: "ready" },
      refreshing: false,
      rows: syncs,
    }),
    [syncs]
  )
  const definition = React.useMemo(
    () =>
      defineDataTable({
        ariaLabel: "Syncs",
        columns: syncColumnHelper.columns([
          syncColumnHelper.accessor((sync) => syncStatus(sync).label, {
            id: "status",
            header: () => (
              <span className="sr-only sm:not-sr-only">Status</span>
            ),
            sortFn: "text",
            cell: ({ row }) => (
              <StatusIndicator status={syncStatus(row.original)} />
            ),
            meta: dataTableColumnMeta(
              { width: { base: "2.5rem", sm: statusColumnWidth } },
              {
                cellClassName: "px-2 sm:px-3",
                headerClassName: "px-2 sm:px-3",
                headerLabelClassName: "shrink-0 overflow-visible text-clip",
              }
            ),
          }),
          syncColumnHelper.accessor(syncName, {
            id: "source",
            header: "Source",
            sortFn: "text",
            cell: ({ row }) => <SyncSource sync={row.original} />,
            // From xl up, Source and Destination fit their longest names, so
            // the columns after them sit close instead of spreading out.
            // Narrower screens share the space instead.
            meta: dataTableColumnMeta({
              width: {
                base: "minmax(0,1fr)",
                lg: "minmax(0,1.2fr)",
                xl: "minmax(0,var(--sync-source-width))",
              },
            }),
          }),
          syncColumnHelper.accessor((sync) => sync.target.name, {
            id: "destination",
            header: "Destination",
            sortFn: "text",
            cell: ({ row }) => <SyncDestination sync={row.original} />,
            meta: dataTableColumnMeta({
              hideBelow: "md",
              width: {
                md: "minmax(0,1fr)",
                xl: "minmax(0,var(--sync-destination-width))",
              },
            }),
          }),
          syncColumnHelper.accessor(
            (sync) => (sync.lastSyncedAt ? Date.parse(sync.lastSyncedAt) : 0),
            {
              id: "latest",
              header: "Latest sync",
              sortFn: sortFn_basic,
              cell: ({ row }) => <SyncLatestCommit sync={row.original} />,
              meta: dataTableColumnMeta({
                hideBelow: "lg",
                width: { lg: "minmax(0,1.2fr)", xl: "minmax(12rem,1fr)" },
              }),
            }
          ),
          syncColumnHelper.display({
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }) => (
              <SyncActions
                sync={row.original}
                onDelete={onDelete}
                onEdit={onEdit}
              />
            ),
            meta: dataTableColumnMeta(
              { width: { base: "12.25rem", sm: "12.5rem" } },
              {
                cellClassName: "px-1 sm:px-2",
                headerClassName: "px-1 sm:px-2",
              }
            ),
          }),
        ]),
        getRowId: syncRowKey,
        search: { fields: syncSearchFields },
        virtualization: true,
      }),
    [onDelete, onEdit]
  )
  const emptyState = React.useCallback(
    ({ searchActive }: { searchActive: boolean }) => (
      <DataTableEmptyState
        action={
          searchActive ? undefined : canCreate ? (
            <Button type="button" size="sm" onClick={onCreate}>
              <Plus /> Create sync
            </Button>
          ) : !hasSource ? (
            <Button asChild size="sm">
              <Link to="/infra/sources" search={{ add: true }}>
                <Plus /> Add source
              </Link>
            </Button>
          ) : !hasTargets ? (
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild size="sm" variant="outline">
                <Link to="/infra/servers">
                  <ServerKindIcon /> Game servers
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link to="/infra/apps">
                  <AppKindIcon /> Apps
                </Link>
              </Button>
            </div>
          ) : undefined
        }
        description={
          <span className="block max-w-sm">
            {searchActive
              ? "Try a repository, branch, folder, or game server name."
              : !hasSource
                ? "Syncs copy files from a source's repositories. Add a source to get started."
                : hasTargets
                  ? "Create a sync to copy a repository folder into a game server or app, and keep it updated."
                  : "Syncs copy files into a game server or app. Create one you can edit files on first."}
          </span>
        }
        icon={<FolderGit2 className="size-6 text-muted-foreground/45" />}
        title={
          searchActive
            ? "No syncs match your search"
            : scopeActive
              ? "Nothing syncs here yet"
              : "No syncs yet"
        }
      />
    ),
    [canCreate, hasSource, hasTargets, onCreate, scopeActive]
  )

  return (
    <DataTable
      definition={definition}
      emptyState={emptyState}
      searchStore={searchStore}
      source={source}
    />
  )
})

const SyncSource = React.memo(function SyncSource({
  sync,
}: {
  sync: GitHubSyncView
}) {
  return (
    <a
      href={syncFolderUrl(sync)}
      target="_blank"
      rel="noreferrer"
      className="group/source-link flex max-w-full min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <IdentityName
        icon={<GitHubMark className="size-4" />}
        meta={syncSourceMeta(sync)}
        name={syncName(sync)}
        nameClassName="transition-colors group-hover/source-link:text-primary"
      />
    </a>
  )
})

const SyncDestination = React.memo(function SyncDestination({
  sync,
}: {
  sync: GitHubSyncView
}) {
  const { target } = sync
  const files = sync.targetPath ? `${sync.targetPath}/` : ""
  const card =
    target.kind === "server" ? (
      <SyncDestinationServerCard sync={sync} />
    ) : (
      <InstanceCard
        {...syncDestinationCardProps(sync)}
        instance={{ id: target.id, kind: target.kind, relayId: target.relayId }}
      />
    )
  const className =
    "group/destination-link flex max-w-full min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
  // Opens the synced folder. Each route takes a full ID and redirects to its
  // short form; a game server's Relay-qualified ID names it even where short
  // IDs collide.
  if (target.kind === "relay") {
    return (
      <Link
        to="/relay/$relayId/files/$"
        params={{ relayId: target.relayId, _splat: files }}
        className={className}
      >
        {card}
      </Link>
    )
  }
  if (target.kind === "app") {
    return (
      <Link
        to="/app/$appId/files/$"
        params={{ appId: target.id, _splat: files }}
        className={className}
      >
        {card}
      </Link>
    )
  }
  return (
    <Link
      to="/server/$serverId/files/$"
      params={{ serverId: `${target.relayId}-${target.id}`, _splat: files }}
      className={className}
    >
      {card}
    </Link>
  )
})

// Only a game server needs the fleet snapshot, for its brick icon.
const SyncDestinationServerCard = React.memo(
  function SyncDestinationServerCard({ sync }: { sync: GitHubSyncView }) {
    const { target } = sync
    const selectServer = React.useCallback(
      (snapshot: RelayFleetSnapshot) => {
        const instance = snapshot.instances.find(
          (item) => item.relayId === target.relayId && item.id === target.id
        )
        return instance
          ? {
              brickId: instance.brickId,
              implementation: instance.implementation,
            }
          : null
      },
      [target.id, target.relayId]
    )
    const { data: server } = useQuery({
      ...relaySnapshotQueryOptions(),
      notifyOnChangeProps: ["data"],
      select: selectServer,
    })
    return (
      <InstanceCard
        {...syncDestinationCardProps(sync)}
        instance={{
          brickId: server?.brickId,
          id: target.id,
          implementation: server?.implementation,
          kind: "server",
          relayId: target.relayId,
        }}
      />
    )
  }
)

function syncDestinationCardProps(sync: GitHubSyncView) {
  return {
    meta: `/${sync.targetPath}${sync.overwrite ? " · Replaces files" : ""}`,
    metaClassName: "font-mono",
    name: sync.target.name,
    nameClassName:
      "transition-colors group-hover/destination-link:text-primary",
    showFavorite: false,
  }
}

function SyncLatestCommit({ sync }: { sync: GitHubSyncView }) {
  if (!sync.lastSyncedAt) {
    return <span className="type-meta text-muted-foreground">Never synced</span>
  }
  const syncedAt = (
    <RelativeTime
      className="shrink-0"
      timestamp={Date.parse(sync.lastSyncedAt)}
    />
  )
  // The change count gives way first, so a narrow cell keeps the time.
  const details = (
    <>
      {syncedAt}
      {sync.status === "success" ? (
        <span className="inline-flex min-w-0 items-center gap-1.5 overflow-hidden">
          <span aria-hidden="true">·</span>
          {sync.lastChangedCount === 0 ? (
            <span className="truncate">up to date</span>
          ) : (
            <span
              className="inline-flex items-center gap-1"
              title={`${sync.lastChangedCount} ${sync.lastChangedCount === 1 ? "file" : "files"} updated`}
            >
              <Files className="size-3 shrink-0" aria-hidden="true" />
              <span className="tabular-nums">{sync.lastChangedCount}</span>
              <span className="sr-only">
                {sync.lastChangedCount === 1 ? "file" : "files"} updated
              </span>
            </span>
          )}
        </span>
      ) : null}
    </>
  )
  if (!sync.lastCommitSha) {
    return (
      <span className="type-meta flex min-w-0 items-center gap-1.5 overflow-hidden text-muted-foreground">
        {details}
      </span>
    )
  }
  return (
    <a
      href={`https://github.com/${sync.repository}/commit/${sync.lastCommitSha}`}
      target="_blank"
      rel="noreferrer"
      className="group/commit-link block min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className="block truncate text-xs font-medium text-foreground transition-colors group-hover/commit-link:text-primary">
        {sync.lastCommitMessage?.split("\n", 1)[0] || "No commit message"}
      </span>
      <span className="type-meta flex min-w-0 items-center gap-1.5 overflow-hidden text-muted-foreground">
        <GitCommitHorizontal
          className="size-3 shrink-0 text-primary"
          aria-hidden="true"
        />
        <span className="shrink-0 font-mono text-primary">
          {sync.lastCommitSha.slice(0, 7)}
        </span>
        <span aria-hidden="true">·</span>
        {details}
      </span>
    </a>
  )
}

const SyncActions = React.memo(function SyncActions({
  sync,
  onDelete,
  onEdit,
}: {
  sync: GitHubSyncView
  onDelete: (sync: GitHubSyncView) => void
  onEdit: (sync: GitHubSyncView) => void
}) {
  const queryClient = useQueryClient()
  const run = useMutation({
    mutationFn: () => runGitHubSync({ data: { id: sync.id } }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.github.overview }),
    onError: (cause) =>
      showToast({
        message: errorMessage(cause, "The sync couldn't start"),
        type: "error",
      }),
  })
  const busy =
    run.isPending || sync.status === "queued" || sync.status === "running"
  const name = syncName(sync)
  return (
    <DataTableActionGroup>
      {sync.canManage ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="px-2 text-xs"
          disabled={busy}
          onClick={() => run.mutate()}
        >
          {busy ? <LoaderCircle className="animate-spin" /> : <FolderSync />}
          {busy ? "Syncing" : "Sync now"}
        </Button>
      ) : null}
      {sync.canManage ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Edit sync from ${name}`}
              onClick={() => onEdit(sync)}
            >
              <Pencil />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Edit sync
          </TooltipContent>
        </Tooltip>
      ) : null}
      {sync.canManage ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              aria-label={`Delete sync from ${name}`}
              onClick={() => onDelete(sync)}
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Delete sync
          </TooltipContent>
        </Tooltip>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`More actions for sync from ${name}`}
          >
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem asChild>
            <a href={syncFolderUrl(sync)} target="_blank" rel="noreferrer">
              <ExternalLink /> Open on GitHub
            </a>
          </DropdownMenuItem>
          <CopyIdentifierMenuItem label="Sync ID" value={sync.id} />
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
  )
})

function syncStatus(sync: GitHubSyncView): IdentityStatusPresentation {
  if (sync.status === "queued") {
    return { label: "Queued", pulse: true, tone: "neutral" }
  }
  if (sync.status === "running") {
    return { label: "Syncing", pulse: true, tone: "info" }
  }
  const detail = sync.lastError ?? undefined
  if (sync.status === "error") {
    return { detail, label: "Failed", tone: "danger" }
  }
  if (sync.status === "success") {
    return sync.lastError
      ? { detail, label: "Warning", tone: "warning" }
      : { label: "Synced", tone: "success" }
  }
  return { detail, label: "Not synced", tone: "neutral" }
}

// Estimated from character counts, which needs no layout pass and renders the
// same on the server. Rem per character at text-xs: semibold and mono names,
// regular meta text.
const nameRemPerChar = 0.43
const monoRemPerChar = 0.46
const metaRemPerChar = 0.38
// Cell padding, plus the card's icon and gap.
const cardChromeRem = 4.25

function syncColumnWidths(
  syncs: ReadonlyArray<GitHubSyncView>
): React.CSSProperties {
  let source = 0
  let destination = 0
  for (const sync of syncs) {
    source = Math.max(
      source,
      syncName(sync).length * nameRemPerChar,
      syncSourceMeta(sync).length * metaRemPerChar
    )
    destination = Math.max(
      destination,
      sync.target.name.length * nameRemPerChar,
      (sync.targetPath.length + 1) * monoRemPerChar +
        (sync.overwrite ? 17 * monoRemPerChar : 0)
    )
  }
  return {
    "--sync-destination-width": columnWidth(destination, 6, 14),
    "--sync-source-width": columnWidth(source, 7, 18),
  } as React.CSSProperties
}

function columnWidth(textRem: number, minRem: number, maxRem: number) {
  const text = Math.min(maxRem, Math.max(minRem, textRem))
  return `${Math.ceil((text + cardChromeRem) * 2) / 2}rem`
}

function syncSourceMeta(sync: GitHubSyncView) {
  return [
    sync.branch,
    sync.autoSync ? "Auto" : "Manual",
    ...(sync.includePatterns.length > 0
      ? [sync.includePatterns.join(", ")]
      : []),
  ].join(" · ")
}

function syncName(sync: GitHubSyncView) {
  return `${sync.repository}${sync.sourcePath ? `/${sync.sourcePath}` : ""}`
}

function syncFolderUrl(sync: GitHubSyncView) {
  const branch = encodePath(sync.branch)
  return `https://github.com/${sync.repository}/tree/${branch}${sync.sourcePath ? `/${encodePath(sync.sourcePath)}` : ""}`
}

function encodePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/")
}

function syncMatchesScope(sync: GitHubSyncView, scope: ScheduleScope) {
  if (!("id" in scope)) return scope.kind === sync.target.kind
  if (scope.kind === "relay") return sync.target.relayId === scope.relayId
  return (
    scope.kind === sync.target.kind &&
    scope.id === sync.target.id &&
    scope.relayId === sync.target.relayId
  )
}

function syncRowKey(sync: GitHubSyncView) {
  return sync.id
}

function syncSearchText(sync: GitHubSyncView) {
  return [
    sync.repository,
    sync.branch,
    sync.sourcePath,
    sync.targetPath,
    sync.target.name,
    sync.target.relayName,
    sync.connectionName,
    sync.lastCommitMessage ?? "",
    ...sync.includePatterns,
  ].join(" ")
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback
}
