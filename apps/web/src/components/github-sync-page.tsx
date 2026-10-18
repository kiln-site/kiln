import * as React from "react"
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import {
  ArrowRight,
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
  RefreshCw,
  Search,
  Server,
  Settings2,
  Trash2,
  TriangleAlert,
  Zap,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
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
import { refreshGitHubConnection, runGitHubSync } from "@/server/github-sync"
import type {
  GitHubConnectionView,
  GitHubSyncTarget,
  GitHubSyncView,
} from "@/server/github-sync.server"

// The dialogs load on first use; idle time warms them so opening one
// doesn't wait on the network.
const loadDialogs = () => import("@/components/github-sync-dialogs")
const ConnectGitHubDialog = React.lazy(() =>
  loadDialogs().then((module) => ({ default: module.ConnectGitHubDialog }))
)
const GitHubSyncEditorDialog = React.lazy(() =>
  loadDialogs().then((module) => ({ default: module.GitHubSyncEditorDialog }))
)
const RemoveConnectionDialog = React.lazy(() =>
  loadDialogs().then((module) => ({ default: module.RemoveConnectionDialog }))
)
const DeleteSyncDialog = React.lazy(() =>
  loadDialogs().then((module) => ({ default: module.DeleteSyncDialog }))
)

type OpenDialog =
  | { kind: "connect" }
  | { kind: "create"; target: GitHubSyncTarget | null }
  | { kind: "delete"; sync: GitHubSyncView }
  | { kind: "edit"; sync: GitHubSyncView }
  | { kind: "remove"; connection: GitHubConnectionView }

export const GitHubSyncPage = React.memo(function GitHubSyncPage() {
  const { data } = useSuspenseQuery({
    ...githubSyncOverviewQueryOptions(),
    notifyOnChangeProps: ["data"],
  })
  const scope = useScheduleScope()
  const [searchStore] = React.useState(createWorkspaceTableSearchStore)
  const [dialog, setDialog] = React.useState<OpenDialog | null>(null)
  useSetupResultToast()

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
  const installed = data.connections.some(
    (connection) =>
      connection.installation && !connection.installation.suspended
  )
  const canCreate = installed && data.targets.length > 0
  const openConnect = React.useCallback(
    () => setDialog({ kind: "connect" }),
    []
  )
  const openCreate = React.useCallback(
    () => setDialog({ kind: "create", target: scopedTarget }),
    [scopedTarget]
  )
  const openEdit = React.useCallback(
    (sync: GitHubSyncView) => setDialog({ kind: "edit", sync }),
    []
  )
  const openDelete = React.useCallback(
    (sync: GitHubSyncView) => setDialog({ kind: "delete", sync }),
    []
  )
  const openRemove = React.useCallback(
    (connection: GitHubConnectionView) =>
      setDialog({ connection, kind: "remove" }),
    []
  )
  const close = React.useCallback(() => setDialog(null), [])

  return (
    <div className="mx-auto w-full max-w-[90rem] space-y-4 px-3 pb-10 sm:px-5">
      <GitHubConnections
        connections={data.connections}
        webhooksReachable={data.webhooksReachable}
        onConnect={openConnect}
        onRemove={openRemove}
      />
      <section className="overflow-hidden rounded-xl border bg-card/45 [contain:paint]">
        <SyncToolbar
          canCreate={canCreate}
          createBlockedReason={
            !installed
              ? "Connect GitHub first"
              : data.targets.length === 0
                ? "You can't edit files on any game server or app"
                : null
          }
          searchStore={searchStore}
          onCreate={openCreate}
        />
        <SyncTable
          canCreate={canCreate}
          connected={data.connections.length > 0}
          scopeActive={scope !== null}
          searchStore={searchStore}
          syncs={scopedSyncs}
          onCreate={openCreate}
          onDelete={openDelete}
          onEdit={openEdit}
        />
      </section>

      <React.Suspense fallback={null}>
        {dialog?.kind === "connect" ? (
          <ConnectGitHubDialog
            hearthUrl={data.hearthUrl}
            webhooksReachable={data.webhooksReachable}
            onClose={close}
          />
        ) : null}
        {dialog?.kind === "create" || dialog?.kind === "edit" ? (
          <GitHubSyncEditorDialog
            connections={data.connections}
            initialTarget={dialog.kind === "create" ? dialog.target : null}
            sync={dialog.kind === "edit" ? dialog.sync : null}
            targets={data.targets}
            onClose={close}
          />
        ) : null}
        {dialog?.kind === "delete" ? (
          <DeleteSyncDialog sync={dialog.sync} onClose={close} />
        ) : null}
        {dialog?.kind === "remove" ? (
          <RemoveConnectionDialog
            connection={dialog.connection}
            onClose={close}
          />
        ) : null}
      </React.Suspense>
    </div>
  )
})

/** GitHub sends the browser back here with the outcome of connecting. */
function useSetupResultToast() {
  const navigate = useNavigate({ from: "/automations/sync" })
  const connected = useSearch({
    from: "/_app/automations/sync",
    select: (search) => search.connected,
  })
  const error = useSearch({
    from: "/_app/automations/sync",
    select: (search) => search.githubError,
  })
  React.useEffect(() => {
    if (!connected && !error) return
    if (error) showToast({ message: error, type: "error" })
    else showToast({ message: "GitHub connected", type: "success" })
    void navigate({
      replace: true,
      search: (previous) => ({
        ...previous,
        connected: undefined,
        githubError: undefined,
      }),
    })
  }, [connected, error, navigate])
}

const GitHubConnections = React.memo(function GitHubConnections({
  connections,
  webhooksReachable,
  onConnect,
  onRemove,
}: {
  connections: ReadonlyArray<GitHubConnectionView>
  webhooksReachable: boolean
  onConnect: () => void
  onRemove: (connection: GitHubConnectionView) => void
}) {
  return (
    <section className="overflow-hidden rounded-xl border bg-card/45 [contain:paint]">
      <div className="flex flex-wrap items-center gap-3 border-b bg-background/25 p-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background">
          <GitHubMark />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">GitHub</h2>
          <p className="type-support text-muted-foreground">
            Keep config files in a repository and copy them into game servers
            and apps{webhooksReachable ? " on every push" : ""}.
          </p>
        </div>
        {connections.length > 0 ? (
          <Button size="sm" variant="outline" onClick={onConnect}>
            <Plus />
            Add account
          </Button>
        ) : null}
      </div>
      {connections.length === 0 ? (
        <GitHubConnectSteps onConnect={onConnect} />
      ) : (
        <ul className="divide-y">
          {connections.map((connection) => (
            <GitHubConnectionRow
              key={connection.id}
              connection={connection}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}
    </section>
  )
})

const connectSteps = [
  {
    description: "Kiln fills in a private GitHub App for you.",
    title: "Create the app",
  },
  {
    description: "Install it on your account or an organization.",
    title: "Choose repositories",
  },
  {
    description: "Pick a repository folder for each game server or app.",
    title: "Add syncs",
  },
] as const

function GitHubConnectSteps({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <ol className="grid gap-3 sm:grid-cols-3">
        {connectSteps.map((step, index) => (
          <li key={step.title} className="flex gap-3">
            <span className="type-code grid size-6 shrink-0 place-items-center rounded-full border bg-background text-muted-foreground">
              {index + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-semibold">{step.title}</span>
              <span className="type-support block text-muted-foreground">
                {step.description}
              </span>
            </span>
          </li>
        ))}
      </ol>
      <Button size="sm" onClick={onConnect}>
        <GitHubMark />
        Connect GitHub
        <ArrowRight />
      </Button>
    </div>
  )
}

const GitHubConnectionRow = React.memo(function GitHubConnectionRow({
  connection,
  onRemove,
}: {
  connection: GitHubConnectionView
  onRemove: (connection: GitHubConnectionView) => void
}) {
  const queryClient = useQueryClient()
  const refresh = useMutation({
    mutationFn: () => refreshGitHubConnection({ data: { id: connection.id } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.github.overview,
      })
      showToast({
        message: result.installed
          ? "GitHub connection refreshed"
          : "The app isn't installed on an account yet",
        type: result.installed ? "success" : "warning",
      })
    },
    onError: (cause) =>
      showToast({
        message: errorMessage(cause, "GitHub couldn't be reached"),
        type: "error",
      }),
  })
  const installation = connection.installation

  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2.5 sm:flex-nowrap">
      {installation?.accountAvatarUrl ? (
        <img
          alt=""
          src={`${installation.accountAvatarUrl}${installation.accountAvatarUrl.includes("?") ? "&" : "?"}s=64`}
          className={cn(
            "size-8 shrink-0 border bg-background",
            installation.accountType === "Organization"
              ? "rounded-md"
              : "rounded-full"
          )}
          loading="lazy"
        />
      ) : (
        <div className="grid size-8 shrink-0 place-items-center rounded-full border bg-background text-muted-foreground">
          <GitHubMark className="size-3.5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-xs font-semibold">
            {installation ? installation.accountLogin : connection.appName}
          </p>
          {installation ? (
            <Badge variant="outline" className="shrink-0">
              {installation.accountType === "Organization"
                ? "Organization"
                : "Personal"}
            </Badge>
          ) : null}
          {!installation ? (
            <Badge
              variant="outline"
              className="shrink-0 border-amber-500/40 text-amber-500"
            >
              Not installed
            </Badge>
          ) : installation.suspended ? (
            <Badge variant="destructive" className="shrink-0">
              Suspended
            </Badge>
          ) : null}
        </div>
        <p className="type-support truncate text-muted-foreground">
          {[
            installation
              ? installation.repositorySelection === "all"
                ? "All repositories"
                : "Selected repositories"
              : "Install the app to choose repositories",
            connection.webhookActive ? "Syncs on push" : "Checks every minute",
            `${connection.syncCount} ${connection.syncCount === 1 ? "sync" : "syncs"}`,
            connection.ownerName
              ? `Connected by ${connection.ownerName}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {installation ? (
          <Button asChild size="sm" variant="ghost">
            <a
              href={connection.manageUrl ?? connection.appUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Settings2 />
              Repository access
            </a>
          </Button>
        ) : (
          <Button asChild size="sm">
            <a href={connection.installUrl}>
              <GitHubMark />
              Install on GitHub
            </a>
          </Button>
        )}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`More actions for ${connection.appName}`}
                >
                  {refresh.isPending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <EllipsisVertical />
                  )}
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">More actions</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuItem
              disabled={refresh.isPending}
              onSelect={() => refresh.mutate()}
            >
              <RefreshCw /> Check installation
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={connection.appUrl} target="_blank" rel="noreferrer">
                <ExternalLink /> View app on GitHub
              </a>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => onRemove(connection)}
            >
              <Trash2 /> Disconnect
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
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
      className="ml-auto shrink-0"
      size="sm"
      disabled={!canCreate}
      onClick={onCreate}
    >
      <Plus />
      Add sync
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
      {createBlockedReason ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="ml-auto" tabIndex={0}>
              {createButton}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{createBlockedReason}</TooltipContent>
        </Tooltip>
      ) : (
        createButton
      )}
    </div>
  )
})

const SyncTable = React.memo(function SyncTable({
  canCreate,
  connected,
  scopeActive,
  searchStore,
  syncs,
  onCreate,
  onDelete,
  onEdit,
}: {
  canCreate: boolean
  connected: boolean
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
            : connected
              ? "Add a sync to copy a repository folder into a game server or app, and keep it updated."
              : "Connect GitHub above, then copy a repository folder into a game server or app."}
        </p>
        {!searchActive && canCreate ? (
          <Button type="button" size="sm" className="mt-4" onClick={onCreate}>
            <Plus /> Add sync
          </Button>
        ) : null}
      </div>
    ),
    [canCreate, connected, onCreate, scopeActive]
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
  const TargetIcon = sync.target.kind === "app" ? Boxes : Server

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
          {sync.afterSync === "restart" ? (
            <span className="font-sans"> · restarts after changes</span>
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
              <RefreshCw className={busy ? "animate-spin" : ""} />
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
  if (!("id" in scope)) {
    return scope.kind === "server" && sync.target.kind === "server"
  }
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
