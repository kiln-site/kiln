import * as React from "react"
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  ExternalLink,
  FolderGit2,
  Plus,
  FolderSync,
  Rocket,
  Trash2,
  UserRound,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  DataTableActionGroup,
  DataTableEmptyState,
} from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import { AccountAvatar } from "@/components/account-avatar"
import { GitHubMark } from "@/components/github-mark"
import { IdentityName } from "@/components/identity-name"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { InfraSyncButton } from "@/components/infra-sync-button"
import { statusColumnWidth } from "@/components/instance-name-presentation"
import { SourceAccount } from "@/components/source-account"
import { StatusIndicator } from "@/components/status-indicator"
import { WorkspacePage } from "@/components/workspace-page"
import { forkPromise } from "@/effect/promise"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import {
  replaceDataTableUrlSearch,
  type DataTableSearchStore,
} from "@/lib/data-table-search"
import type { DataTableSource } from "@/lib/data-table-source"
import {
  githubSourceRepositoryCountQueryOptions,
  githubSourcesQueryOptions,
} from "@/lib/query-options"
import type { GitHubConnectionView } from "@/server/github-sync.server"

type Source = GitHubConnectionView

type SourceDialog = { kind: "delete"; source: Source } | null

// The dialogs load on first use; idle time warms them.
const loadSourceDialogs = () => import("@/components/source-dialogs")
const AddSourceDialog = React.lazy(() =>
  loadSourceDialogs().then((module) => ({ default: module.AddSourceDialog }))
)
const DeleteSourceDialog = React.lazy(() =>
  loadSourceDialogs().then((module) => ({
    default: module.DeleteSourceDialog,
  }))
)

const sourceColumnHelper = createDataTableColumnHelper<Source>()
const sourceSearchFields = [
  (row: Source) => row.installation?.accountLogin ?? "",
  (row: Source) => row.appName,
  (row: Source) => row.appOwnerLogin,
  (row: Source) => row.ownerName ?? "",
  (row: Source) => row.ownerEmail ?? "",
  (row: Source) => sourceStatus(row).label,
  () => "GitHub",
] as const

export const SourcesPage = React.memo(function SourcesPage({
  addOpen,
  connected,
  error,
  searchStore,
  onAddOpenChange,
  onSetupResultShown,
}: {
  /** Add source lives in the URL, so Sync can link straight to it. */
  addOpen: boolean
  /** A source GitHub's setup just finished, to announce once. */
  connected: string | undefined
  error: string | undefined
  searchStore: DataTableSearchStore
  onAddOpenChange: (open: boolean) => void
  onSetupResultShown: () => void
}) {
  const { data } = useSuspenseQuery({
    ...githubSourcesQueryOptions(),
    notifyOnChangeProps: ["data"],
  })
  const [dialog, setDialog] = React.useState<SourceDialog>(null)
  const closeDialog = React.useCallback(() => setDialog(null), [])
  const openAdd = React.useCallback(
    () => onAddOpenChange(true),
    [onAddOpenChange]
  )
  const closeAdd = React.useCallback(
    () => onAddOpenChange(false),
    [onAddOpenChange]
  )

  React.useEffect(() => {
    const idle =
      "requestIdleCallback" in window
        ? window.requestIdleCallback(() => forkPromise(loadSourceDialogs))
        : undefined
    return () => {
      if (idle !== undefined) window.cancelIdleCallback(idle)
    }
  }, [])
  React.useEffect(() => {
    if (!connected && !error) return
    // One toast per outcome, however often this runs before the URL clears.
    if (error) {
      showToast({ id: `source-setup:${error}`, message: error, type: "error" })
    } else {
      showToast({
        id: `source-setup:${connected}`,
        message: "Source added",
        type: "success",
      })
    }
    onSetupResultShown()
  }, [connected, error, onSetupResultShown])

  return (
    <WorkspacePage>
      <DataTableWorkspace
        toolbar={<SourcesToolbar searchStore={searchStore} onAdd={openAdd} />}
      >
        <SourcesTable
          searchStore={searchStore}
          sources={data.sources}
          onAdd={openAdd}
          onDialog={setDialog}
        />
      </DataTableWorkspace>

      <React.Suspense fallback={null}>
        {addOpen ? <AddSourceDialog onClose={closeAdd} /> : null}
        {dialog?.kind === "delete" ? (
          <DeleteSourceDialog source={dialog.source} onClose={closeDialog} />
        ) : null}
      </React.Suspense>
    </WorkspacePage>
  )
})

const SourcesToolbar = React.memo(function SourcesToolbar({
  searchStore,
  onAdd,
}: {
  searchStore: DataTableSearchStore
  onAdd: () => void
}) {
  return (
    <DataTableToolbar
      actions={
        <>
          <Button asChild variant="outline">
            <Link to="/automations/sync">
              <FolderSync />
              <span className="hidden sm:inline">Syncs</span>
            </Link>
          </Button>
          <Button aria-label="Add source" type="button" onClick={onAdd}>
            <Plus />
            <span className="hidden sm:inline">Add source</span>
          </Button>
        </>
      }
      leading={<SourcesRefreshButton />}
      search={{
        ariaLabel: "Search sources",
        closeMobileWhenEmpty: true,
        id: "source-search",
        onValueChange: replaceDataTableUrlSearch,
        placeholder: "Search sources",
        store: searchStore,
      }}
    />
  )
})

const SourcesRefreshButton = React.memo(function SourcesRefreshButton() {
  const queryClient = useQueryClient()
  const refresh = React.useCallback(
    () =>
      // Repository counts too, which only GitHub knows.
      queryClient.invalidateQueries({ queryKey: ["github-sync"] }),
    [queryClient]
  )
  return <InfraSyncButton label="Refresh sources" sync={refresh} />
})

const SourcesTable = React.memo(function SourcesTable({
  searchStore,
  sources,
  onAdd,
  onDialog,
}: {
  searchStore: DataTableSearchStore
  sources: ReadonlyArray<Source>
  onAdd: () => void
  onDialog: (dialog: SourceDialog) => void
}) {
  const source = React.useMemo<DataTableSource<Source>>(
    () => ({ body: { kind: "ready" }, refreshing: false, rows: [...sources] }),
    [sources]
  )
  const definition = React.useMemo(() => {
    const columns = sourceColumnHelper.columns([
      sourceColumnHelper.accessor((row) => sourceStatus(row).label, {
        id: "status",
        header: () => <span className="sr-only sm:not-sr-only">Status</span>,
        sortFn: "text",
        cell: ({ row }) => (
          <StatusIndicator status={sourceStatus(row.original)} />
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
      sourceColumnHelper.accessor((row) => row.provider, {
        id: "type",
        header: "Type",
        sortFn: "text",
        cell: () => (
          <span className="inline-flex items-center gap-2 text-xs font-medium">
            <GitHubMark className="size-4" />
            GitHub
          </span>
        ),
        meta: dataTableColumnMeta({ hideBelow: "sm", width: "6rem" }),
      }),
      sourceColumnHelper.accessor(
        (row) => row.installation?.accountLogin ?? row.appName,
        {
          id: "account",
          header: "Source",
          sortFn: "text",
          cell: ({ row }) => <SourceAccount source={row.original} />,
          meta: dataTableColumnMeta({ width: "minmax(0,1fr)" }),
        }
      ),
      sourceColumnHelper.accessor((row) => row.ownerName ?? "", {
        id: "owner",
        header: "Kiln User",
        sortFn: "text",
        cell: ({ row }) => <SourceOwnerCell source={row.original} />,
        meta: dataTableColumnMeta({ hideBelow: "lg", width: "minmax(0,1fr)" }),
      }),
      sourceColumnHelper.accessor((row) => row.appName, {
        id: "app",
        header: "App",
        sortFn: "text",
        cell: ({ row }) => (
          <span className="type-meta truncate font-mono">
            {row.original.appName}
          </span>
        ),
        meta: dataTableColumnMeta({ hideBelow: "lg", width: "minmax(0,1fr)" }),
      }),
      sourceColumnHelper.display({
        id: "repositories",
        header: "Scope",
        enableSorting: false,
        cell: ({ row }) => <RepositoryCountCell source={row.original} />,
        meta: dataTableColumnMeta({ hideBelow: "md", width: "5.5rem" }),
      }),
      sourceColumnHelper.accessor((row) => row.syncCount, {
        id: "usage",
        header: "Used by",
        sortFn: (left, right) =>
          left.original.syncCount - right.original.syncCount,
        cell: ({ row }) => <UsageCell source={row.original} />,
        meta: dataTableColumnMeta({ hideBelow: "md", width: "8.5rem" }),
      }),
      sourceColumnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <SourceActions source={row.original} onDialog={onDialog} />
        ),
        meta: dataTableColumnMeta(
          { width: "4.5rem" },
          { cellClassName: "px-1 sm:px-2", headerClassName: "px-1 sm:px-2" }
        ),
      }),
    ])
    return defineDataTable({
      ariaLabel: "Sources",
      columns,
      getRowId: (row) => row.id,
      search: { fields: sourceSearchFields },
    })
  }, [onDialog])
  const emptyState = React.useCallback(
    ({ searchActive }: { searchActive: boolean }) => (
      <DataTableEmptyState
        action={
          searchActive ? undefined : (
            <Button size="sm" type="button" onClick={onAdd}>
              <Plus /> Add source
            </Button>
          )
        }
        description={
          <span className="block max-w-sm">
            {searchActive
              ? "Try an account, organization, or app name."
              : "Add an account Kiln can read repositories from, so apps can deploy from them and syncs can copy their files."}
          </span>
        }
        icon={<FolderGit2 className="size-6 text-muted-foreground/45" />}
        title={searchActive ? "No sources match your search" : "No sources yet"}
      />
    ),
    [onAdd]
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

function SourceOwnerCell({ source }: { source: Source }) {
  return (
    <IdentityName
      icon={
        source.ownerName ? (
          <AccountAvatar name={source.ownerName} />
        ) : (
          <UserRound className="size-4" aria-hidden="true" />
        )
      }
      iconClassName="border-0 bg-transparent"
      meta={source.ownerEmail}
      name={source.ownerName ?? "Deleted user"}
    />
  )
}

function RepositoryCountCell({ source }: { source: Source }) {
  const installation = source.installation
  const count = useQuery({
    ...githubSourceRepositoryCountQueryOptions(source.id),
    enabled: installation !== null && !installation.suspended,
  })
  if (!installation) {
    return <span className="type-meta text-muted-foreground">—</span>
  }
  return (
    <span className="type-meta flex min-w-0 items-center gap-1.5">
      <span className="tabular-nums">
        {count.data ?? (count.isError ? "?" : "…")}
      </span>
      <span className="truncate text-muted-foreground">
        {installation.repositorySelection === "all" ? "· All" : "· Selected"}
      </span>
    </span>
  )
}

function UsageCell({ source }: { source: Source }) {
  return (
    <span className="type-meta flex min-w-0 flex-col items-start gap-0.5">
      <Link
        to="/automations/sync"
        className="inline-flex items-center gap-1.5 hover:text-primary"
      >
        <FolderSync className="size-3 text-muted-foreground" />
        <span className="tabular-nums">{source.syncCount}</span>
        {source.syncCount === 1 ? "sync" : "syncs"}
      </Link>
      <Link
        to="/infra/deployments"
        className="inline-flex items-center gap-1.5 hover:text-primary"
      >
        <Rocket className="size-3 text-muted-foreground" />
        <span className="tabular-nums">{source.deploymentCount}</span>
        {source.deploymentCount === 1 ? "app" : "apps"}
      </Link>
    </span>
  )
}

const SourceActions = React.memo(function SourceActions({
  source,
  onDialog,
}: {
  source: Source
  onDialog: (dialog: SourceDialog) => void
}) {
  const name = source.installation?.accountLogin ?? source.appName
  return (
    <DataTableActionGroup>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            asChild
            className="text-muted-foreground hover:text-primary"
            size="icon-sm"
            variant="ghost"
          >
            <a
              aria-label={`Open ${name} on GitHub`}
              href={source.manageUrl ?? source.installUrl}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink />
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {source.installation ? "Open on GitHub" : "Install on GitHub"}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={`Delete ${name}`}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={() => onDialog({ kind: "delete", source })}
          >
            <Trash2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Delete</TooltipContent>
      </Tooltip>
    </DataTableActionGroup>
  )
})

function sourceStatus(source: Source): IdentityStatusPresentation {
  if (!source.installation) {
    return {
      detail: "Install the app on GitHub to choose repositories",
      label: "Not installed",
      tone: "warning",
    }
  }
  if (source.installation.suspended) {
    return {
      detail: "Suspended on GitHub; its syncs are paused",
      label: "Suspended",
      tone: "danger",
    }
  }
  return { label: "Connected", tone: "success" }
}
