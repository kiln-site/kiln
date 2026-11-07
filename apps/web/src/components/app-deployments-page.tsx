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
import {
  AddFirstRelayButton,
  useAwaitingFirstRelay,
} from "@/components/relay/pair-first-relay"
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
  appDeploymentsQueryOptions,
  appDirectoryQueryOptions,
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
  return (
    <WorkspacePage>
      <DeploymentsScopePicker scope={scope} onScopeChange={onScopeChange} />
      <DataTableWorkspace
        toolbar={<DeploymentsToolbar searchStore={searchStore} />}
      >
        <DeploymentsTable scope={scope} searchStore={searchStore} />
      </DataTableWorkspace>
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
      allLabel="All Apps"
      ariaLabel="Apps and Relays"
      changeLabel="Change scope"
      chooseLabel="Choose app"
      emptyMessage="No Apps found."
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
}: {
  scope: AppDeploymentsScope
  searchStore: DataTableSearchStore
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
          <StatusIndicator
            status={deploymentStatusPresentation(row.original)}
          />
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
          <DeploymentActions deployment={row.original} />
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
  }, [])
  return (
    <DataTable
      definition={definition}
      emptyState={deploymentsEmptyState}
      searchStore={searchStore}
      source={source}
    />
  )
})

function deploymentsEmptyState({ searchActive }: { searchActive: boolean }) {
  return <EmptyDeploymentTable searchActive={searchActive} />
}

function EmptyDeploymentTable({ searchActive }: { searchActive: boolean }) {
  const awaitingFirstRelay = useAwaitingFirstRelay()
  return (
    <DataTableEmptyState
      action={
        !searchActive && awaitingFirstRelay ? <AddFirstRelayButton /> : null
      }
      description={
        <span className="block max-w-sm">
          {searchActive
            ? "Try an app, commit, branch, or who deployed it."
            : awaitingFirstRelay
              ? "Pair a Relay and deploy an app to see its deployments here."
              : "Each time an app deploys, by hand or from a push to GitHub, it shows here."}
        </span>
      }
      icon={
        <Rocket className="size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
      }
      title={
        searchActive ? "No deployments match your search" : "No deployments"
      }
    />
  )
}

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
        nameClassName="transition-colors group-hover/app-link:text-primary-ink"
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
            className="shrink-0 font-mono hover:text-primary-ink"
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
}: {
  deployment: Deployment
}) {
  const queryClient = useQueryClient()
  const redeploy = useMutation({
    mutationFn: () =>
      redeployAppDeployment({ data: { deploymentId: deployment.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["app-deployments"] })
      showToast({
        message: deployment.commitSha
          ? `Deploy of ${shortCommit(deployment.commitSha)} queued`
          : deployment.imageDigest
            ? `Deploy of ${shortDigest(deployment.imageDigest)} queued`
            : "Deploy queued",
        type: "success",
      })
    },
    onError: (error) => showToast({ message: error.message, type: "error" }),
  })
  return (
    <DataTableActionGroup>
      {deployment.canReadLogs ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              className="text-muted-foreground hover:text-primary-ink"
              size="icon-sm"
              variant="ghost"
            >
              <Link
                aria-label={`Log of ${deployment.appName}'s deployment`}
                params={{ appId: deployment.appId }}
                search={{ deployment: deployment.id }}
                to="/app/$appId/logs"
              >
                <ScrollText />
              </Link>
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
