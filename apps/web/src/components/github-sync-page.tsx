import * as React from "react"
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import {
  Boxes,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  ClipboardCopy,
  EllipsisVertical,
  ExternalLink,
  FolderGit2,
  GitBranch,
  LoaderCircle,
  Pencil,
  Plus,
  FolderSync,
  RadioTower,
  Search,
  Server,
  Trash2,
  TriangleAlert,
  Zap,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { GitHubMark } from "@/components/github-mark"
import { RelativeTime } from "@/components/relative-time"
import {
  useScheduleScope,
  type ScheduleScope,
} from "@/components/schedule-scope"
import {
  WorkspaceTable,
  WorkspaceTableCell,
  WorkspaceTableHead,
  WorkspaceTableHeading,
  createWorkspaceTableSearchStore,
  useWorkspaceTableSearchInput,
  type WorkspaceTableSearchStore,
} from "@/components/workspace-table"
import { forkPromise } from "@/effect/promise"
import { githubSyncOverviewQueryOptions, queryKeys } from "@/lib/query-options"
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
  const [searchStore] = React.useState(createWorkspaceTableSearchStore)
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

  return (
    <div className="mx-auto w-full max-w-[90rem] px-3 pb-10 sm:px-5">
      <section className="overflow-hidden rounded-xl border bg-card/45 [contain:paint]">
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
      </section>

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
  searchStore: WorkspaceTableSearchStore
  onCreate: () => void
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  useWorkspaceTableSearchInput(inputRef, searchStore)
  const createButton = (
    <Button
      className="shrink-0"
      size="sm"
      disabled={!canCreate}
      onClick={onCreate}
    >
      <Plus />
      Create sync
    </Button>
  )

  return (
    <div className="flex min-w-0 items-center gap-2 border-b bg-background/25 p-3">
      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          id="github-sync-search"
          type="search"
          className="pl-9"
          defaultValue={searchStore.getServerSnapshot()}
          placeholder="Search syncs"
          onChange={(event) => searchStore.set(event.currentTarget.value)}
        />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to="/infra/sources">
            <FolderGit2 />
            <span className="hidden sm:inline">Sources</span>
          </Link>
        </Button>
        {createBlockedReason ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0}>{createButton}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{createBlockedReason}</TooltipContent>
          </Tooltip>
        ) : (
          createButton
        )}
      </div>
    </div>
  )
})

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
  searchStore: WorkspaceTableSearchStore
  syncs: Array<GitHubSyncView>
  onCreate: () => void
  onDelete: (sync: GitHubSyncView) => void
  onEdit: (sync: GitHubSyncView) => void
}) {
  const renderRow = React.useCallback(
    (sync: GitHubSyncView) => (
      <SyncTableRow sync={sync} onDelete={onDelete} onEdit={onEdit} />
    ),
    [onDelete, onEdit]
  )
  const renderEmpty = React.useCallback(
    (searchActive: boolean) => (
      <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
        <FolderGit2 className="size-6 text-muted-foreground/45" />
        <p className="mt-3 text-sm font-semibold">
          {searchActive
            ? "No syncs match your search"
            : scopeActive
              ? "Nothing syncs here yet"
              : "No syncs yet"}
        </p>
        <p className="type-support mt-1 max-w-sm text-muted-foreground">
          {searchActive
            ? "Try a repository, branch, folder, or game server name."
            : !hasSource
              ? "Syncs copy files from a source's repositories. Add a source to get started."
              : hasTargets
                ? "Create a sync to copy a repository folder into a game server or app, and keep it updated."
                : "Syncs copy files into a game server or app. Create one you can edit files on first."}
        </p>
        {searchActive ? null : canCreate ? (
          <Button type="button" size="sm" className="mt-4" onClick={onCreate}>
            <Plus /> Create sync
          </Button>
        ) : !hasSource ? (
          <Button asChild size="sm" className="mt-4">
            <Link to="/infra/sources" search={{ add: true }}>
              <Plus /> Add source
            </Link>
          </Button>
        ) : !hasTargets ? (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link to="/infra/servers">
                <Server /> Game servers
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/infra/apps">
                <Boxes /> Apps
              </Link>
            </Button>
          </div>
        ) : null}
      </div>
    ),
    [canCreate, hasSource, hasTargets, onCreate, scopeActive]
  )

  return (
    <WorkspaceTable
      getRowKey={syncRowKey}
      getSearchText={syncSearchText}
      head={<SyncTableHead />}
      items={syncs}
      renderEmpty={renderEmpty}
      renderRow={renderRow}
      searchStore={searchStore}
    />
  )
})

const SyncTableHead = React.memo(function SyncTableHead() {
  return (
    <WorkspaceTableHead>
      <WorkspaceTableHeading className="w-28 px-2 sm:w-32 sm:px-3">
        Status
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-auto sm:w-[30%]">
        Repository
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[20%] md:table-cell">
        Destination
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[26%] lg:table-cell">
        Latest sync
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-36 px-1 text-right sm:w-44 sm:px-3">
        Actions
      </WorkspaceTableHeading>
    </WorkspaceTableHead>
  )
})

const SyncTableRow = React.memo(function SyncTableRow({
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
  const repositoryUrl = `https://github.com/${sync.repository}`
  const folderUrl = `${repositoryUrl}/tree/${sync.branch.split("/").map(encodeURIComponent).join("/")}${sync.sourcePath ? `/${sync.sourcePath}` : ""}`
  const copyId = React.useCallback(() => {
    forkPromise(
      async () => {
        await navigator.clipboard.writeText(sync.id)
        showToast({ message: "Sync ID copied", type: "success" })
      },
      (cause) =>
        showToast({
          message: errorMessage(cause, "The sync ID could not be copied"),
          type: "error",
        })
    )
  }, [sync.id])
  const TargetIcon =
    sync.target.kind === "app"
      ? Boxes
      : sync.target.kind === "relay"
        ? RadioTower
        : Server

  return (
    <tr className="group transition-colors hover:bg-accent/25">
      <WorkspaceTableCell className="px-2 sm:px-3">
        <SyncStatus sync={sync} />
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        <div className="flex min-w-0 items-center gap-2">
          <GitHubMark className="size-3.5 text-muted-foreground" />
          <a
            href={folderUrl}
            target="_blank"
            rel="noreferrer"
            className="truncate text-xs font-semibold hover:underline"
          >
            {sync.repository}
            {sync.sourcePath ? (
              <span className="font-normal text-muted-foreground">
                /{sync.sourcePath}
              </span>
            ) : null}
          </a>
        </div>
        <div className="type-support mt-0.5 flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <GitBranch className="size-3 shrink-0" />
          <span className="max-w-[45%] shrink-0 truncate font-mono">
            {sync.branch}
          </span>
          <span aria-hidden="true">·</span>
          {sync.autoSync ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <Zap className="size-3" />
              Auto
            </span>
          ) : (
            <span className="shrink-0">Manual</span>
          )}
          {sync.includePatterns.length > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate font-mono">
                {sync.includePatterns.join(", ")}
              </span>
            </>
          ) : null}
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden md:table-cell">
        <div className="flex min-w-0 items-center gap-2">
          <TargetIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium">
            {sync.target.name}
          </span>
        </div>
        <p className="type-support mt-0.5 truncate font-mono text-muted-foreground">
          /{sync.targetPath}
          {sync.overwrite ? (
            <span className="font-sans"> · replaces files</span>
          ) : null}
        </p>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden lg:table-cell">
        <LatestSync sync={sync} />
      </WorkspaceTableCell>
      <WorkspaceTableCell className="px-1 sm:px-3">
        <div className="flex items-center justify-end gap-1">
          {sync.canManage ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="px-2 text-xs"
              disabled={busy}
              onClick={() => run.mutate()}
            >
              {busy ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <FolderSync />
              )}
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
                  aria-label={`Edit sync from ${sync.repository}`}
                  onClick={() => onEdit(sync)}
                >
                  <Pencil />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Edit sync</TooltipContent>
            </Tooltip>
          ) : null}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`More actions for sync from ${sync.repository}`}
                  >
                    <EllipsisVertical />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">More actions</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem asChild>
                <a href={folderUrl} target="_blank" rel="noreferrer">
                  <ExternalLink /> Open on GitHub
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={copyId}>
                <ClipboardCopy /> Copy sync ID
              </DropdownMenuItem>
              {sync.canManage ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => onDelete(sync)}
                  >
                    <Trash2 /> Delete sync
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </WorkspaceTableCell>
    </tr>
  )
})

function SyncStatus({ sync }: { sync: GitHubSyncView }) {
  const presentation =
    sync.status === "queued"
      ? {
          Icon: LoaderCircle,
          className: "text-muted-foreground",
          label: "Queued",
          spin: true,
        }
      : sync.status === "running"
        ? {
            Icon: LoaderCircle,
            className: "text-sky-400",
            label: "Syncing",
            spin: true,
          }
        : sync.status === "error"
          ? {
              Icon: CircleAlert,
              className: "text-destructive",
              label: "Failed",
              spin: false,
            }
          : sync.status === "success"
            ? sync.lastError
              ? {
                  Icon: TriangleAlert,
                  className: "text-amber-500",
                  label: "Warning",
                  spin: false,
                }
              : {
                  Icon: CircleCheck,
                  className: "text-emerald-500",
                  label: "Synced",
                  spin: false,
                }
            : {
                Icon: CircleDashed,
                className: "text-muted-foreground",
                label: "Not synced",
                spin: false,
              }
  const label = (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium",
        presentation.className
      )}
    >
      <presentation.Icon
        className={cn("size-3.5 shrink-0", presentation.spin && "animate-spin")}
      />
      {presentation.label}
    </span>
  )
  if (!sync.lastError || sync.status === "queued" || sync.status === "running")
    return label
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="cursor-help">
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        {sync.lastError}
      </TooltipContent>
    </Tooltip>
  )
}

function LatestSync({ sync }: { sync: GitHubSyncView }) {
  if (!sync.lastSyncedAt) {
    return <span className="type-support text-muted-foreground">Never</span>
  }
  return (
    <div className="min-w-0">
      {sync.lastCommitSha ? (
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <a
            href={`https://github.com/${sync.repository}/commit/${sync.lastCommitSha}`}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 font-mono text-primary hover:underline"
          >
            {sync.lastCommitSha.slice(0, 7)}
          </a>
          <span className="truncate">{sync.lastCommitMessage}</span>
        </div>
      ) : null}
      <p className="type-support mt-0.5 flex min-w-0 items-center gap-1 text-muted-foreground">
        <RelativeTime
          className="shrink-0"
          timestamp={Date.parse(sync.lastSyncedAt)}
        />
        {sync.status === "success" ? (
          <span className="truncate">
            ·{" "}
            {sync.lastChangedCount === 0
              ? "up to date"
              : `${sync.lastChangedCount} ${sync.lastChangedCount === 1 ? "file" : "files"} updated`}
          </span>
        ) : null}
      </p>
    </div>
  )
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
