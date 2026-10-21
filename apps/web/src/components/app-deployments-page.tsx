import * as React from "react"
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  EllipsisVertical,
  ExternalLink,
  LoaderCircle,
  RotateCcw,
  Rocket,
  ScrollText,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import {
  deploymentDuration,
  deploymentStatusPresentation,
  deploymentTriggerLabels,
  shortCommit,
  shortDigest,
} from "@/components/app/app-deployment-presentation"
import { sourceTypeLabels } from "@/components/app/app-presentation"
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
import { InfraSyncButton } from "@/components/infra-sync-button"
import { InstanceCard } from "@/components/instance-card"
import { statusColumnWidth } from "@/components/instance-name-presentation"
import { RelativeTime } from "@/components/relative-time"
import {
  ServerScopePicker,
  type ServerPickerOption,
} from "@/components/server-scope-picker"
import { StatusIndicator } from "@/components/status-indicator"
import { WorkspacePage } from "@/components/workspace-page"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import {
  replaceDataTableUrlSearch,
  type DataTableSearchStore,
} from "@/lib/data-table-search"
import { useCursorDataTableSource } from "@/lib/data-table-source"
import {
  appDeploymentLogQueryOptions,
  appDeploymentsQueryOptions,
  appDirectoryQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import { redeployAppDeployment } from "@/server/app-deployments"
import type { AppDeploymentView } from "@/server/app-deployments.server"

// Every app's deployments, newest first, across the Relays the person can
// read. Scoped to one app, this is that app's history.

type Deployment = AppDeploymentView
type ScopeKind = "app" | "relay"

export interface AppDeploymentsScope {
  appId?: string
  relayId?: string
}

const columnHelper = createDataTableColumnHelper<Deployment>()
const searchFields = [
  (row: Deployment) => row.appName,
  (row: Deployment) => row.relayName,
  (row: Deployment) => row.commitMessage ?? "",
  (row: Deployment) => row.commitSha ?? "",
  (row: Deployment) => row.repository ?? "",
  (row: Deployment) => row.branch ?? "",
  (row: Deployment) => row.triggeredByName ?? "",
  (row: Deployment) => deploymentTriggerLabels[row.trigger],
  (row: Deployment) => deploymentStatusPresentation(row).label,
] as const

export const AppDeploymentsPage = React.memo(function AppDeploymentsPage({
  scope,
  searchStore,
  onScopeChange,
}: {
  scope: AppDeploymentsScope
  searchStore: DataTableSearchStore
  onScopeChange: (scope: AppDeploymentsScope) => void
}) {
  const [logFor, setLogFor] = React.useState<Deployment | null>(null)
  const closeLog = React.useCallback(() => setLogFor(null), [])
  return (
    <WorkspacePage>
      <DeploymentsScopePicker scope={scope} onScopeChange={onScopeChange} />
      <DataTableWorkspace
        toolbar={<DeploymentsToolbar searchStore={searchStore} />}
      >
        <DeploymentsTable
          scope={scope}
          searchStore={searchStore}
          onOpenLog={setLogFor}
        />
      </DataTableWorkspace>
      {logFor ? (
        <DeploymentLogDialog deployment={logFor} onClose={closeLog} />
      ) : null}
    </WorkspacePage>
  )
})

const DeploymentsScopePicker = React.memo(function DeploymentsScopePicker({
  scope,
  onScopeChange,
}: {
  scope: AppDeploymentsScope
  onScopeChange: (scope: AppDeploymentsScope) => void
}) {
  const { data: apps = [] } = useQuery(appDirectoryQueryOptions())
  const options = React.useMemo((): Array<ServerPickerOption<ScopeKind>> => {
    const relays = new Map(apps.map((app) => [app.relayId, app.relayName]))
    return [
      ...[...relays].map(([id, name]) => ({
        id,
        kind: "relay" as const,
        name,
        relayId: id,
        relayName: name,
      })),
      ...apps.map((app) => ({
        id: app.id,
        kind: "app" as const,
        name: app.name,
        relayId: app.relayId,
        relayName: app.relayName,
      })),
    ]
  }, [apps])
  const selected = React.useMemo(
    () =>
      options.find((option) =>
        scope.appId
          ? option.kind === "app" &&
            option.id === scope.appId &&
            option.relayId === scope.relayId
          : option.kind === "relay" && option.id === scope.relayId
      ) ?? null,
    [options, scope.appId, scope.relayId]
  )
  const select = React.useCallback(
    (option: ServerPickerOption<ScopeKind> | null) =>
      onScopeChange(
        !option
          ? {}
          : option.kind === "app"
            ? { appId: option.id, relayId: option.relayId }
            : { relayId: option.relayId }
      ),
    [onScopeChange]
  )
  return (
    <ServerScopePicker<ScopeKind>
      allLabel="All apps"
      ariaLabel="Apps and Relays"
      changeLabel="Change scope"
      chooseLabel="Choose app"
      emptyMessage="No apps found."
      selectedServer={selected}
      servers={options}
      onSelect={select}
    />
  )
})

const DeploymentsToolbar = React.memo(function DeploymentsToolbar({
  searchStore,
}: {
  searchStore: DataTableSearchStore
}) {
  return (
    <DataTableToolbar
      leading={<DeploymentsRefreshButton />}
      search={{
        ariaLabel: "Search deployments",
        closeMobileWhenEmpty: true,
        id: "deployment-search",
        onValueChange: replaceDataTableUrlSearch,
        placeholder: "Search deployments",
        store: searchStore,
      }}
    />
  )
})

const DeploymentsRefreshButton = React.memo(
  function DeploymentsRefreshButton() {
    const queryClient = useQueryClient()
    const refresh = React.useCallback(
      () => queryClient.invalidateQueries({ queryKey: ["app-deployments"] }),
      [queryClient]
    )
    return <InfraSyncButton label="Refresh deployments" sync={refresh} />
  }
)

const DeploymentsTable = React.memo(function DeploymentsTable({
  scope,
  searchStore,
  onOpenLog,
}: {
  scope: AppDeploymentsScope
  searchStore: DataTableSearchStore
  onOpenLog: (deployment: Deployment) => void
}) {
  const query = useInfiniteQuery(appDeploymentsQueryOptions(scope))
  const source = useCursorDataTableSource({
    getRowKey: deploymentKey,
    query,
    resetKey: `${scope.relayId ?? ""}:${scope.appId ?? ""}`,
  })
  const definition = React.useMemo(() => {
    const columns = columnHelper.columns([
      columnHelper.accessor((row) => deploymentStatusPresentation(row).label, {
        id: "status",
        header: () => <span className="sr-only sm:not-sr-only">Status</span>,
        sortFn: "text",
        cell: ({ row }) => (
          <StatusIndicator status={deploymentStatusPresentation(row.original)} />
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
      columnHelper.accessor((row) => row.appName, {
        id: "app",
        header: "App",
        sortFn: "text",
        cell: ({ row }) => <DeploymentApp deployment={row.original} />,
        meta: dataTableColumnMeta(
          { width: "minmax(11rem,1fr)" },
          { cellClassName: "p-0" }
        ),
      }),
      columnHelper.accessor((row) => row.commitMessage ?? "", {
        id: "commit",
        header: "Commit",
        sortFn: "text",
        cell: ({ row }) => <DeploymentCommit deployment={row.original} />,
        meta: dataTableColumnMeta({ width: "minmax(12rem,1.4fr)" }),
      }),
      columnHelper.accessor((row) => deploymentTriggerLabels[row.trigger], {
        id: "trigger",
        header: "Trigger",
        sortFn: "text",
        cell: ({ row }) => <DeploymentTrigger deployment={row.original} />,
        meta: dataTableColumnMeta({ hideBelow: "md", width: "9rem" }),
      }),
      columnHelper.accessor((row) => Date.parse(row.startedAt), {
        id: "started",
        header: "Started",
        sortFn: (left, right) =>
          Date.parse(left.original.startedAt) -
          Date.parse(right.original.startedAt),
        cell: ({ row }) => (
          <span className="type-meta">
            <RelativeTime timestamp={Date.parse(row.original.startedAt)} />
          </span>
        ),
        meta: dataTableColumnMeta({ hideBelow: "sm", width: "7.5rem" }),
      }),
      columnHelper.display({
        id: "duration",
        header: "Duration",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="type-meta text-muted-foreground tabular-nums">
            {deploymentDuration(row.original) ?? "—"}
          </span>
        ),
        meta: dataTableColumnMeta({ hideBelow: "lg", width: "6rem" }),
      }),
      columnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <DeploymentActions deployment={row.original} onOpenLog={onOpenLog} />
        ),
        meta: dataTableColumnMeta(
          { width: "4.5rem" },
          { cellClassName: "px-1 sm:px-2", headerClassName: "px-1 sm:px-2" }
        ),
      }),
    ])
    return defineDataTable({
      ariaLabel: "Deployments",
      columns,
      getRowId: deploymentKey,
      search: { fields: searchFields },
    })
  }, [onOpenLog])
  const emptyState = React.useCallback(
    ({ searchActive }: { searchActive: boolean }) => (
      <DataTableEmptyState
        description={
          <span className="block max-w-sm">
            {searchActive
              ? "Try an app, commit, branch, or who deployed it."
              : "Each time an app deploys, by hand or from a push to GitHub, it shows here."}
          </span>
        }
        icon={<Rocket className="size-6 text-muted-foreground/45" />}
        title={
          searchActive ? "No deployments match your search" : "No deployments"
        }
      />
    ),
    []
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

function deploymentKey(deployment: Deployment): string {
  return deployment.id
}

const DeploymentApp = React.memo(function DeploymentApp({
  deployment,
}: {
  deployment: Deployment
}) {
  return (
    <Link
      to="/app/$appId/info"
      params={{ appId: deployment.appId }}
      preload="intent"
      className="group/app-link flex min-h-14 w-full min-w-0 items-center px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
    >
      <InstanceCard
        className="min-w-0 flex-1"
        instance={{
          id: deployment.appId,
          kind: "app",
          relayId: deployment.relayId,
        }}
        meta={deployment.relayName}
        metaClassName="font-mono"
        name={deployment.appName}
        nameClassName="transition-colors group-hover/app-link:text-primary"
        showFavorite={false}
        showStatus={false}
      />
    </Link>
  )
})

const DeploymentCommit = React.memo(function DeploymentCommit({
  deployment,
}: {
  deployment: Deployment
}) {
  if (!deployment.commitSha) {
    return (
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="type-meta text-muted-foreground">
          {sourceTypeLabels[deployment.sourceType]}
        </span>
        {deployment.imageDigest ? (
          <span
            className="type-meta truncate font-mono text-muted-foreground"
            title={deployment.imageDigest}
          >
            {shortDigest(deployment.imageDigest)}
          </span>
        ) : null}
      </span>
    )
  }
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span
        className="truncate text-[0.8125rem]"
        title={deployment.commitMessage ?? undefined}
      >
        {deployment.commitMessage || "No message"}
      </span>
      <span className="type-meta flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <GitHubMark className="size-3 shrink-0" />
        {deployment.commitUrl ? (
          <a
            href={deployment.commitUrl}
            rel="noreferrer"
            target="_blank"
            className="shrink-0 font-mono hover:text-primary"
          >
            {shortCommit(deployment.commitSha)}
          </a>
        ) : (
          <span className="shrink-0 font-mono">
            {shortCommit(deployment.commitSha)}
          </span>
        )}
        {deployment.branch ? (
          <span className="truncate font-mono">{deployment.branch}</span>
        ) : null}
      </span>
    </span>
  )
})

function DeploymentTrigger({ deployment }: { deployment: Deployment }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[0.8125rem]">
        {deploymentTriggerLabels[deployment.trigger]}
      </span>
      <span className="type-meta truncate text-muted-foreground">
        {deployment.triggeredByName ??
          (deployment.commitAuthor
            ? `by ${deployment.commitAuthor}`
            : deployment.trigger === "update"
              ? "Kiln"
              : "GitHub")}
      </span>
    </span>
  )
}

const DeploymentActions = React.memo(function DeploymentActions({
  deployment,
  onOpenLog,
}: {
  deployment: Deployment
  onOpenLog: (deployment: Deployment) => void
}) {
  const queryClient = useQueryClient()
  const redeploy = useMutation({
    mutationFn: () =>
      redeployAppDeployment({ data: { deploymentId: deployment.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["app-deployments"] })
      showToast({
        message: deployment.commitSha
          ? `Deploying ${shortCommit(deployment.commitSha)} again`
          : deployment.imageDigest
            ? `Deploying ${shortDigest(deployment.imageDigest)} again`
            : "Deploying again",
        type: "success",
      })
    },
    onError: (error) =>
      showToast({ message: error.message, type: "error" }),
  })
  return (
    <DataTableActionGroup>
      {deployment.canReadLogs ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={`Log of ${deployment.appName}'s deployment`}
              className="text-muted-foreground hover:text-primary"
              size="icon-sm"
              type="button"
              variant="ghost"
              onClick={() => onOpenLog(deployment)}
            >
              <ScrollText />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Log</TooltipContent>
        </Tooltip>
      ) : null}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={`More actions for ${deployment.appName}'s deployment`}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                {redeploy.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <EllipsisVertical />
                )}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-48">
          {deployment.canManage ? (
            <DropdownMenuItem
              disabled={redeploy.isPending}
              onSelect={() => redeploy.mutate()}
            >
              <RotateCcw />
              {deployment.commitSha ? "Deploy this commit again" : "Redeploy"}
            </DropdownMenuItem>
          ) : null}
          {deployment.commitUrl ? (
            <DropdownMenuItem asChild>
              <a href={deployment.commitUrl} rel="noreferrer" target="_blank">
                <ExternalLink />
                Open commit on GitHub
              </a>
            </DropdownMenuItem>
          ) : null}
          {deployment.canManage || deployment.commitUrl ? (
            <DropdownMenuSeparator />
          ) : null}
          <CopyIdentifierMenuItem label="Deployment ID" value={deployment.id} />
          {deployment.commitSha ? (
            <CopyIdentifierMenuItem
              label="Commit SHA"
              value={deployment.commitSha}
            />
          ) : null}
          <CopyIdentifierMenuItem label="App ID" value={deployment.appId} />
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
  )
})

// A deployment's log as its Relay kept it. A running one links to the live
// log on the app's page.
function DeploymentLogDialog({
  deployment,
  onClose,
}: {
  deployment: Deployment
  onClose: () => void
}) {
  const log = useQuery(appDeploymentLogQueryOptions(deployment.id))
  const queryClient = useQueryClient()
  // A running deployment's log grows; reopening reads it again.
  React.useEffect(
    () => () => {
      if (deployment.status === "running") {
        queryClient.removeQueries({
          queryKey: queryKeys.appDeployments.log(deployment.id),
        })
      }
    },
    [deployment.id, deployment.status, queryClient]
  )
  const lines = log.data?.log?.lines ?? []
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid max-h-[min(92dvh,52rem)] grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {deployment.appName}
            <StatusIndicator status={deploymentStatusPresentation(deployment)} />
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              <RelativeTime timestamp={Date.parse(deployment.startedAt)} />
            </span>
            {deployment.commitSha ? (
              <span className="font-mono">
                {shortCommit(deployment.commitSha)}{" "}
                {deployment.commitMessage ?? ""}
              </span>
            ) : null}
            {deployment.status === "running" ? (
              <Link
                to="/app/$appId/logs"
                params={{ appId: deployment.appId }}
                search={{ stream: "deployment" }}
                className="text-primary hover:underline"
              >
                Follow it live
              </Link>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-auto border bg-muted/20 p-3 font-mono text-[11px] leading-relaxed">
          {log.isPending ? (
            <div className="grid h-24 place-items-center">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : log.isError ? (
            <p className="text-destructive">{log.error.message}</p>
          ) : !log.data.log ? (
            <p className="text-muted-foreground">
              {log.data.reason ?? "This log is no longer kept"}
            </p>
          ) : (
            <>
              {log.data.log.dropped > 0 ? (
                <p className="mb-1 text-muted-foreground">
                  {log.data.log.dropped.toLocaleString()} earlier lines were
                  dropped
                </p>
              ) : null}
              {lines.map((line) => (
                <div
                  key={line.id}
                  className={cn(
                    "break-words whitespace-pre-wrap",
                    line.level === "error" && "text-destructive",
                    line.level === "warn" && "text-amber-500"
                  )}
                >
                  {line.text}
                </div>
              ))}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
