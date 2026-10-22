import * as React from "react"
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  Check,
  ExternalLink,
  Globe2,
  Pencil,
  Plus,
  Settings2,
  Trash2,
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
import type { IdentityStatusPresentation } from "@/components/identity-name"
import {
  InfoCopyValue,
  InfoFact,
  InfoRailCard,
  InfoRailCardSection,
} from "@/components/info-page"
import { InfraSyncButton } from "@/components/infra-sync-button"
import { InstanceCard } from "@/components/instance-card"
import { statusColumnWidth } from "@/components/instance-name-presentation"
import {
  ServerScopePicker,
  type ServerPickerOption,
} from "@/components/server-scope-picker"
import { StatusIndicator } from "@/components/status-indicator"
import { WorkspaceCopyValueButton } from "@/components/workspace-header"
import {
  cloudflareDnsRecordsUrl,
  domainHostname,
  serverKey,
  showErrorToast,
  strategyOptions,
  type DirectoryServer,
} from "@/components/domains-shared"
import { WorkspacePage } from "@/components/workspace-page"
import type { DomainIntegration, ManagedDomain } from "@/effect/domains"
import { ensuringPromise, forkPromise, tapPromiseError } from "@/effect/promise"
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
  domainSettingsQueryOptions,
  queryKeys,
  serverDirectoryQueryOptions,
} from "@/lib/query-options"
import {
  resyncDomainAssignments,
  type ManagedDomainOverview,
} from "@/server/domains"

type DomainDialog =
  | { kind: "configure" }
  | { kind: "create" }
  | { kind: "delete"; domain: ManagedDomainOverview }
  | { kind: "edit"; domain: ManagedDomainOverview }
  | null

const domainTableColumnHelper =
  createDataTableColumnHelper<ManagedDomainOverview>()
const domainTableSearchFields = [
  (row: ManagedDomainOverview) => domainHostname(row),
  (row: ManagedDomainOverview) => row.address,
  (row: ManagedDomainOverview) => row.server.name,
  (row: ManagedDomainOverview) => row.server.game,
  (row: ManagedDomainOverview) => row.instanceId,
  (row: ManagedDomainOverview) => row.port,
  (row: ManagedDomainOverview) => row.relayName,
  (row: ManagedDomainOverview) => row.relayId,
  (row: ManagedDomainOverview) => row.status,
  (row: ManagedDomainOverview) => srvRecordLabel(row),
] as const

// The dialogs are large and opened rarely, so they load after the page: when
// the browser is idle, or when one first opens.
let dialogsModulePromise:
  | Promise<typeof import("@/components/domains-dialogs")>
  | undefined

function loadDomainDialogs() {
  dialogsModulePromise ??= tapPromiseError(
    () => import("@/components/domains-dialogs"),
    (error) => {
      dialogsModulePromise = undefined
      throw error
    }
  )
  return dialogsModulePromise
}

const CreateDomainDialog = React.lazy(async () => ({
  default: (await loadDomainDialogs()).CreateDomainDialog,
}))
const DeleteDomainDialog = React.lazy(async () => ({
  default: (await loadDomainDialogs()).DeleteDomainDialog,
}))
const DomainConfigurationDialog = React.lazy(async () => ({
  default: (await loadDomainDialogs()).DomainConfigurationDialog,
}))
const EditDomainDialog = React.lazy(async () => ({
  default: (await loadDomainDialogs()).EditDomainDialog,
}))

/** The game server the table is filtered to. */
interface DomainScope {
  instanceId: string
  /** Missing when a link names only the game server. */
  relayId: string | undefined
}

export const DomainsPage = React.memo(function DomainsPage({
  initialScope,
  searchStore,
}: {
  initialScope: DomainScope | null
  searchStore: DataTableSearchStore
}) {
  const { data } = useSuspenseQuery(domainSettingsQueryOptions())
  const [dialog, setDialog] = React.useState<DomainDialog>(null)
  const [scope, setScope] = React.useState(initialScope)
  React.useEffect(() => {
    const idle =
      "requestIdleCallback" in window
        ? // No timeout: forcing it during a busy startup would defeat it.
          window.requestIdleCallback(() => forkPromise(loadDomainDialogs))
        : undefined
    return () => {
      if (idle !== undefined) window.cancelIdleCallback(idle)
    }
  }, [])
  const selectScope = React.useCallback((next: DomainScope | null) => {
    setScope(next)
    // Like the table search, the URL follows without a router render.
    replaceDataTableUrlSearch(next?.instanceId ?? "", "server")
    replaceDataTableUrlSearch(next?.relayId ?? "", "relay")
  }, [])
  const scopedDomains = React.useMemo(
    () =>
      scope
        ? data.managedDomains.filter(
            (domain) =>
              domain.instanceId === scope.instanceId &&
              (!scope.relayId || domain.relayId === scope.relayId)
          )
        : data.managedDomains,
    [data.managedDomains, scope]
  )
  const openConfiguration = React.useCallback(
    () => setDialog({ kind: "configure" }),
    []
  )
  const openCreate = React.useCallback(() => setDialog({ kind: "create" }), [])
  const closeDialog = React.useCallback((open: boolean) => {
    if (!open) setDialog(null)
  }, [])
  const domains = data.integration?.domains
  const enabledDomains = React.useMemo(
    () => domains?.filter((domain) => domain.enabled) ?? [],
    [domains]
  )
  const domainUsage = React.useMemo(() => {
    const usage = new Map<string, number>()
    for (const domain of data.managedDomains) {
      usage.set(domain.domain, (usage.get(domain.domain) ?? 0) + 1)
    }
    return usage
  }, [data.managedDomains])

  return (
    <WorkspacePage
      rail={
        <DomainsRail
          integration={data.integration}
          onConfigure={openConfiguration}
        />
      }
      summary={<DomainScopePicker scope={scope} onSelect={selectScope} />}
    >
      <DataTableWorkspace
        toolbar={
          <DomainsToolbar
            canCreate={enabledDomains.length > 0}
            syncEnabled={data.integration !== null}
            searchStore={searchStore}
            onCreate={openCreate}
          />
        }
      >
        <ManagedDomainsTable
          domains={scopedDomains}
          searchStore={searchStore}
          onDialog={setDialog}
        />
      </DataTableWorkspace>

      <React.Suspense fallback={null}>
        {dialog?.kind === "configure" ? (
          <DomainConfigurationDialog
            domainUsage={domainUsage}
            hearthDomain={data.hearthDomain}
            integration={data.integration}
            onOpenChange={closeDialog}
          />
        ) : null}
        {dialog?.kind === "create" ? (
          <CreateDomainDialog
            domains={enabledDomains}
            initialServerKey={
              scope?.relayId ? serverKey(scope.relayId, scope.instanceId) : null
            }
            managedDomains={data.managedDomains}
            onOpenChange={closeDialog}
          />
        ) : null}
        {dialog?.kind === "edit" ? (
          <EditDomainDialog
            key={dialog.domain.id}
            domain={dialog.domain}
            domains={enabledDomains}
            onOpenChange={closeDialog}
          />
        ) : null}
        {dialog?.kind === "delete" ? (
          <DeleteDomainDialog
            key={dialog.domain.id}
            domain={dialog.domain}
            onOpenChange={closeDialog}
          />
        ) : null}
      </React.Suspense>
    </WorkspacePage>
  )
})

/** Filters the table to one game server, as Backups and Activity do. */
const DomainScopePicker = React.memo(function DomainScopePicker({
  onSelect,
  scope,
}: {
  onSelect: (scope: DomainScope | null) => void
  scope: DomainScope | null
}) {
  const { data: servers = emptyScopeServers } = useQuery({
    ...serverDirectoryQueryOptions(),
    select: selectScopeServers,
  })
  const selectedServer =
    (scope &&
      servers.find(
        (server) =>
          server.id === scope.instanceId &&
          (!scope.relayId || server.relayId === scope.relayId)
      )) ||
    null
  const select = React.useCallback(
    (server: ServerPickerOption | null) =>
      onSelect(
        server ? { instanceId: server.id, relayId: server.relayId } : null
      ),
    [onSelect]
  )
  return (
    <ServerScopePicker
      selectedServer={selectedServer}
      servers={servers}
      onSelect={select}
    />
  )
})

const emptyScopeServers: Array<ServerPickerOption> = []

function selectScopeServers(
  servers: ReadonlyArray<DirectoryServer>
): Array<ServerPickerOption> {
  return servers.map((server) => ({
    id: server.id,
    name: server.name,
    relayId: server.relayId,
    relayName: server.relayName,
  }))
}

/** Reloads the configured domains and the table. */
const DomainsRefreshButton = React.memo(function DomainsRefreshButton() {
  const queryClient = useQueryClient()
  const refresh = React.useCallback(
    () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.domains.settings }),
    [queryClient]
  )
  return (
    <InfraSyncButton
      label="Refresh domains"
      size="icon-sm"
      sync={refresh}
      onError={showErrorToast}
    />
  )
})

/**
 * The configured domains, set apart from the facts above. Beside the table it
 * fills the rail; stacked below it, it shows seven and a half rows so the
 * cut-off row says the list scrolls.
 */
function VanityDomainList({
  domains,
}: {
  domains: ReadonlyArray<ManagedDomain>
}) {
  return (
    <InfoRailCardSection
      action={
        <span className="type-meta text-muted-foreground tabular-nums">
          {domains.length}
        </span>
      }
      className="xl:flex xl:min-h-0 xl:flex-1 xl:flex-col"
      contentClassName="max-h-[calc(7.5*2.25rem)] overflow-y-auto xl:max-h-none xl:min-h-0 xl:flex-1"
      title="Domains"
    >
      <ul aria-label="Vanity domains">
        {domains.map((domain) => (
          // Dividers span the middle 85%, centered.
          <li
            key={domain.domain}
            className="relative after:absolute after:inset-x-[7.5%] after:bottom-0 after:h-px after:bg-border/60 last:after:hidden"
          >
            <a
              aria-label={`View ${domain.domain} on Cloudflare`}
              className={`group flex h-9 items-center gap-2 px-2 font-mono text-[0.8125rem] outline-none hover:bg-muted/60 focus-visible:bg-muted/60 ${
                domain.enabled ? "" : "text-muted-foreground"
              }`}
              href={cloudflareDnsRecordsUrl(domain.zoneName)}
              rel="noreferrer"
              target="_blank"
            >
              <span className="min-w-0 flex-1 truncate">{domain.domain}</span>
              <ExternalLink className="size-3 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-primary-ink group-focus-visible:text-primary-ink" />
            </a>
          </li>
        ))}
      </ul>
    </InfoRailCardSection>
  )
}

/** What vanity is set up to do, beside the table. */
const DomainsRail = React.memo(function DomainsRail({
  integration,
  onConfigure,
}: {
  integration: DomainIntegration | null
  onConfigure: () => void
}) {
  const strategy = strategyOptions.find(
    (option) => option.value === integration?.strategy
  )
  const defaultDomain = integration?.domains.find((domain) => domain.isDefault)
  return (
    <InfoRailCard
      action={
        <div className="flex items-center gap-1.5">
          {integration ? <DomainsRefreshButton /> : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Configure vanity"
                size="icon-sm"
                type="button"
                variant="outline"
                onClick={onConfigure}
              >
                <Settings2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Configure vanity
            </TooltipContent>
          </Tooltip>
        </div>
      }
      // Half the rail beside the table, leaving the rest for more cards. The
      // domain list fills what's left of the card.
      className="xl:flex xl:min-h-0 xl:flex-none xl:basis-1/2 xl:flex-col"
      icon={<Globe2 />}
      sections={
        integration && integration.domains.length > 0 ? (
          <VanityDomainList domains={integration.domains} />
        ) : null
      }
      title="Vanity"
    >
      {integration ? (
        <>
          <InfoFact label="Auto provisioning">
            {integration.enabled ? (strategy?.label ?? "Default only") : "Off"}
          </InfoFact>
          {defaultDomain ? (
            <InfoFact label="Default">
              <span className="truncate font-mono">{defaultDomain.domain}</span>
            </InfoFact>
          ) : null}
        </>
      ) : (
        <InfoFact label="Cloudflare">
          <span className="text-muted-foreground">Not connected</span>
        </InfoFact>
      )}
    </InfoRailCard>
  )
})

const DomainsToolbar = React.memo(function DomainsToolbar({
  canCreate,
  onCreate,
  searchStore,
  syncEnabled,
}: {
  canCreate: boolean
  onCreate: () => void
  searchStore: DataTableSearchStore
  syncEnabled: boolean
}) {
  return (
    <DataTableToolbar
      actions={
        <Button
          aria-label="New domain"
          disabled={!canCreate}
          type="button"
          onClick={onCreate}
        >
          <Plus />
          <span className="hidden sm:inline">New domain</span>
        </Button>
      }
      leading={<DomainSyncButton enabled={syncEnabled} />}
      search={{
        ariaLabel: "Search domains",
        closeMobileWhenEmpty: true,
        id: "domain-search",
        onValueChange: replaceDataTableUrlSearch,
        placeholder: "Search domains",
        store: searchStore,
      }}
    />
  )
})

const DomainSyncButton = React.memo(function DomainSyncButton({
  enabled,
}: {
  enabled: boolean
}) {
  const queryClient = useQueryClient()
  const sync = React.useCallback(async () => {
    const result = await ensuringPromise(
      () => resyncDomainAssignments(),
      () => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.domains.settings,
        })
        void queryClient.invalidateQueries({
          queryKey: queryKeys.relay.snapshot,
        })
      }
    )
    showToast({
      message: `Synced ${result.syncedServerCount} ${
        result.syncedServerCount === 1
          ? "game server address"
          : "game server addresses"
      }`,
      type: "success",
    })
  }, [queryClient])

  return (
    <InfraSyncButton
      disabled={!enabled}
      label="Sync managed domains"
      sync={sync}
      onError={showErrorToast}
    />
  )
})

const ManagedDomainsTable = React.memo(function ManagedDomainsTable({
  domains,
  onDialog,
  searchStore,
}: {
  domains: Array<ManagedDomainOverview>
  onDialog: (dialog: DomainDialog) => void
  searchStore: DataTableSearchStore
}) {
  // The server sorts by domain, so a rename or delete shifts later rows.
  // Match rows by ID instead of position, so only changed rows repaint.
  const [rowCache] = React.useState(
    () => new Map<string, { json: string; row: ManagedDomainOverview }>()
  )
  const source = React.useMemo<DataTableSource<ManagedDomainOverview>>(() => {
    const seen = new Set<string>()
    const rows = domains.map((domain) => {
      const json = JSON.stringify(domain)
      seen.add(domain.id)
      const cached = rowCache.get(domain.id)
      if (cached?.json === json) return cached.row
      rowCache.set(domain.id, { json, row: domain })
      return domain
    })
    for (const key of rowCache.keys()) {
      if (!seen.has(key)) rowCache.delete(key)
    }
    return { body: { kind: "ready" }, refreshing: false, rows }
  }, [domains, rowCache])
  const [initialTableState] = React.useState(() => ({
    sorting: [{ desc: false, id: "domain" }],
  }))
  const definition = React.useMemo(() => {
    const columns = domainTableColumnHelper.columns([
      domainTableColumnHelper.accessor((domain) => domain.status, {
        id: "status",
        header: () => <span className="sr-only sm:not-sr-only">Status</span>,
        sortFn: "text",
        cell: ({ row }) => (
          <StatusIndicator status={domainStatusPresentation(row.original)} />
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
      domainTableColumnHelper.accessor((domain) => domain.server.name, {
        id: "instance",
        header: "Instance",
        sortFn: "text",
        cell: ({ row }) => <DomainServerCell domain={row.original} />,
        meta: dataTableColumnMeta(
          {
            // Phones keep the domain, which this table is about.
            hideBelow: "sm",
            // Keep the game and Brick readable; leave extra space for domains.
            width: "clamp(13rem,18vw,15rem)",
          },
          { cellClassName: "px-0" }
        ),
      }),
      domainTableColumnHelper.accessor((domain) => domainHostname(domain), {
        id: "domain",
        header: "Domain",
        sortFn: "text",
        cell: ({ row }) => <DomainHostnameCell domain={row.original} />,
        meta: dataTableColumnMeta({ width: "minmax(0,1.4fr)" }),
      }),
      domainTableColumnHelper.accessor((domain) => domain.port, {
        id: "port",
        header: "Port",
        sortFn: (left, right) => left.original.port - right.original.port,
        cell: ({ row }) => (
          <InfoCopyValue label="port" value={String(row.original.port)} />
        ),
        meta: dataTableColumnMeta({ hideBelow: "sm", width: "5.75rem" }),
      }),
      domainTableColumnHelper.accessor((domain) => srvRecordLabel(domain), {
        id: "srv",
        header: "SRV",
        sortFn: "text",
        cell: ({ row }) => <SrvRecordCell domain={row.original} />,
        meta: dataTableColumnMeta({ hideBelow: "md", width: "6.5rem" }),
      }),
      domainTableColumnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <DomainActions domain={row.original} onDialog={onDialog} />
        ),
        meta: dataTableColumnMeta(
          { width: "6.5rem" },
          { cellClassName: "px-1 sm:px-2", headerClassName: "px-1 sm:px-2" }
        ),
      }),
    ])
    return defineDataTable({
      ariaLabel: "Managed domains",
      columns,
      getRowId: (domain) => domain.id,
      model: { initialState: initialTableState },
      search: { fields: domainTableSearchFields },
      virtualization: true,
    })
  }, [initialTableState, onDialog])

  return (
    <DataTable
      definition={definition}
      emptyState={renderEmptyDomains}
      searchStore={searchStore}
      source={source}
    />
  )
})

const DomainServerCell = React.memo(function DomainServerCell({
  domain,
}: {
  domain: ManagedDomainOverview
}) {
  const { server } = domain
  return (
    <Link
      to="/server/$serverId/console"
      params={{ serverId: server.routeId }}
      preload="intent"
      className="group/server-link flex min-h-14 w-full min-w-0 items-center px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
    >
      <InstanceCard
        className="min-w-0 flex-1"
        instance={{
          brickId: server.brickId,
          id: domain.instanceId,
          implementation: server.implementation,
          kind: "server",
          relayId: domain.relayId,
        }}
        meta={
          [server.game, server.implementation].filter(Boolean).join(" · ") ||
          domain.instanceId.slice(0, 8)
        }
        metaClassName="font-mono"
        name={server.name}
        nameClassName="transition-colors group-hover/server-link:text-primary-ink"
        showFavorite={false}
        showStatus={false}
      />
    </Link>
  )
})

function DomainHostnameCell({ domain }: { domain: ManagedDomainOverview }) {
  return (
    <div className="type-meta flex w-full min-w-0">
      <WorkspaceCopyValueButton label="domain" value={domainHostname(domain)} />
    </div>
  )
}

function SrvRecordCell({ domain }: { domain: ManagedDomainOverview }) {
  return domain.srvActive ? (
    <span className="type-meta inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
      <Check aria-hidden className="size-3" />
      Active
    </span>
  ) : (
    <span className="type-meta text-muted-foreground">
      {srvRecordLabel(domain)}
    </span>
  )
}

const DomainActions = React.memo(function DomainActions({
  domain,
  onDialog,
}: {
  domain: ManagedDomainOverview
  onDialog: (dialog: DomainDialog) => void
}) {
  const hostname = domainHostname(domain)

  return (
    <DataTableActionGroup>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={`Edit ${hostname}`}
            className="text-muted-foreground hover:text-primary-ink"
            // A domain being deleted can only be deleted again.
            disabled={domain.status === "removing"}
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={() => onDialog({ kind: "edit", domain })}
          >
            <Pencil />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Edit</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={`Delete ${hostname}`}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive light:hover:bg-destructive/20"
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={() => onDialog({ kind: "delete", domain })}
          >
            <Trash2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Delete</TooltipContent>
      </Tooltip>
      {domain.zoneName ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              className="text-muted-foreground hover:text-primary-ink"
              size="icon-sm"
              variant="ghost"
            >
              <a
                aria-label={`View ${hostname} on Cloudflare`}
                href={cloudflareDnsRecordsUrl(domain.zoneName)}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">View on Cloudflare</TooltipContent>
        </Tooltip>
      ) : null}
    </DataTableActionGroup>
  )
})

function renderEmptyDomains({ searchActive }: { searchActive: boolean }) {
  return (
    <DataTableEmptyState
      description={
        <span className="block max-w-sm">
          {searchActive
            ? "Try a vanity address, game server, Relay, port, status, or ID."
            : "Create a domain for a game server, or turn on automatic provisioning to give new game servers one."}
        </span>
      }
      icon={
        <Globe2 className="size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
      }
      title={
        searchActive ? "No domains match your search" : "No Active Domains"
      }
    />
  )
}

function srvRecordLabel(domain: ManagedDomainOverview): string {
  return domain.srvActive
    ? "Active"
    : domain.supportsSrv
      ? "Not set"
      : "Unsupported"
}

function domainStatusPresentation(
  domain: ManagedDomainOverview
): IdentityStatusPresentation {
  if (domain.status === "active") return { label: "Active", tone: "success" }
  if (domain.status === "pending") {
    return { label: "Pending", pulse: true, tone: "warning" }
  }
  // Only stays deleting when Cloudflare refused; deleting again finishes it.
  if (domain.status === "removing") {
    return domain.lastError
      ? { detail: domain.lastError, label: "Delete failed", tone: "danger" }
      : { label: "Deleting", pulse: true, tone: "warning" }
  }
  return {
    detail: domain.lastError ?? undefined,
    label: "Error",
    tone: "danger",
  }
}
