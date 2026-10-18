import * as React from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Effect, Fiber, Result } from "effect"
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  CircleHelp,
  ExternalLink,
  Globe2,
  KeyRound,
  Link2,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"
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
  InstancePickerContent,
  type InstancePickerItem,
} from "@/components/instance-picker"
import {
  ServerScopePicker,
  type ServerPickerOption,
} from "@/components/server-scope-picker"
import { StatusIndicator } from "@/components/status-indicator"
import { WorkspaceCopyValueButton } from "@/components/workspace-header"
import { WorkspacePage } from "@/components/workspace-page"
import type {
  DomainAssignmentStrategy,
  DomainIntegration,
  ManagedDomain,
} from "@/effect/domains"
import { ensuringPromise, promiseEffect } from "@/effect/promise"
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
  defaultDomainBlacklistPatterns,
  domainInZone,
  domainNameSchema,
  validateBlacklistPatterns,
  vanityLabelSchema,
} from "@/lib/domain-schemas"
import {
  domainSettingsQueryOptions,
  queryKeys,
  serverDirectoryQueryOptions,
} from "@/lib/query-options"
import {
  configureDomainIntegration,
  createInstanceDomain,
  discoverCloudflareDomains,
  removeInstanceDomain,
  resyncDomainAssignments,
  updateInstanceDomain,
  type DiscoveredCloudflareZone,
  type ManagedDomainOverview,
} from "@/server/domains"
import type { getInfraServerDirectory } from "@/server/infra-directory"

type DirectoryServer = Awaited<
  ReturnType<typeof getInfraServerDirectory>
>[number]

type DomainDialog =
  | { kind: "configure" }
  | { kind: "create" }
  | { kind: "delete"; domain: ManagedDomainOverview }
  | { kind: "edit"; domain: ManagedDomainOverview }
  | null

const strategyOptions: ReadonlyArray<{
  label: string
  value: DomainAssignmentStrategy
}> = [
  {
    label: "Default only",
    value: "default",
  },
  {
    label: "Random",
    value: "random",
  },
  {
    label: "Spread evenly",
    value: "balanced",
  },
]

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
        <Button size="sm" type="button" variant="outline" onClick={onConfigure}>
          <Settings2 />
          Configure
        </Button>
      }
      icon={<Globe2 />}
      sections={
        integration && integration.domains.length > 0 ? (
          <InfoRailCardSection
            action={
              <div className="flex items-center gap-2">
                <span className="type-meta text-muted-foreground tabular-nums">
                  {integration.domains.length}
                </span>
                <DomainsRefreshButton />
              </div>
            }
            // Seven and a half rows: the cut-off row shows the list scrolls.
            contentClassName="max-h-[calc(7.5*2.5rem)] overflow-y-auto"
            icon={<Link2 />}
            title="Domains"
          >
            {integration.domains.map((domain) => (
              <div
                key={domain.domain}
                className={`flex h-10 items-center gap-2 border-b border-border/60 text-[0.8125rem] last:border-b-0 ${
                  domain.enabled ? "" : "text-muted-foreground"
                }`}
              >
                <dt className="min-w-0 flex-1 truncate font-mono">
                  {domain.domain}
                </dt>
                <dd className="-mr-1.5 shrink-0">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        asChild
                        className="text-muted-foreground hover:text-primary"
                        size="icon-xs"
                        variant="ghost"
                      >
                        <a
                          aria-label={`View ${domain.domain} on Cloudflare`}
                          href={cloudflareDnsRecordsUrl(domain.zoneName)}
                          rel="noreferrer"
                          target="_blank"
                        >
                          <ExternalLink />
                        </a>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">View on Cloudflare</TooltipContent>
                  </Tooltip>
                </dd>
              </div>
            ))}
          </InfoRailCardSection>
        ) : null
      }
      title="Vanity"
    >
      <InfoFact label="Provider">
        {integration ? (
          "Cloudflare"
        ) : (
          <span className="text-muted-foreground">Not connected</span>
        )}
      </InfoFact>
      {integration ? (
        <>
          <InfoFact label="Auto provisioning">
            {integration.enabled ? "On" : "Off"}
          </InfoFact>
          {integration.enabled ? (
            <InfoFact label="New game servers">
              {strategy?.label ?? "Default only"}
            </InfoFact>
          ) : null}
          {defaultDomain ? (
            <InfoFact label="Default">
              <span className="truncate font-mono">{defaultDomain.domain}</span>
            </InfoFact>
          ) : null}
        </>
      ) : null}
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
            width: "minmax(8rem,0.55fr)",
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
        cell: ({ row }) => <DomainPortCell domain={row.original} />,
        meta: dataTableColumnMeta({ hideBelow: "sm", width: "7.75rem" }),
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
        nameClassName="transition-colors group-hover/server-link:text-primary"
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

// With an SRV record, players join by the hostname alone.
function DomainPortCell({ domain }: { domain: ManagedDomainOverview }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <InfoCopyValue label="port" value={String(domain.port)} />
      {domain.srvActive ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="type-technical-label shrink-0 rounded-sm border border-emerald-500/30 px-1 text-emerald-700 dark:text-emerald-300">
              SRV
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Players can join with just the domain
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
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
            className="text-muted-foreground hover:text-primary"
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
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
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
              className="text-muted-foreground hover:text-primary"
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
      icon={<Globe2 className="size-6 text-muted-foreground/45" />}
      title={
        searchActive ? "No domains match your search" : "No Active Domains"
      }
    />
  )
}

function CreateDomainDialog({
  domains,
  initialServerKey,
  managedDomains,
  onOpenChange,
}: {
  domains: Array<ManagedDomain>
  /** The game server the table is filtered to. */
  initialServerKey: string | null
  managedDomains: Array<ManagedDomainOverview>
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const { data: servers = emptyServers } = useQuery(
    serverDirectoryQueryOptions()
  )
  const domainCounts = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const domain of managedDomains) {
      const key = serverKey(domain.relayId, domain.instanceId)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [managedDomains])
  const [selectedKey, setSelectedKey] = React.useState(initialServerKey)
  const [domain, setDomain] = React.useState(domains[0]?.domain ?? "")
  const [vanityLabel, setVanityLabel] = React.useState("")
  const [primary, setPrimary] = React.useState(false)
  const server = selectedKey
    ? servers.find((item) => serverKey(item.relayId, item.id) === selectedKey)
    : undefined
  const existingCount = selectedKey ? (domainCounts.get(selectedKey) ?? 0) : 0
  const label = vanityLabel.trim()
  const parsed = label ? vanityLabelSchema.safeParse(label) : null
  const create = useMutation({
    mutationFn: (target: DirectoryServer) =>
      createInstanceDomain({
        data: {
          domain,
          instanceId: target.id,
          primary,
          relayId: target.relayId,
          vanityLabel: parsed?.success ? parsed.data : undefined,
        },
      }),
    // A failed create can leave a failed row to retry or delete.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.domains.settings }),
    onSuccess: (result) => {
      showToast({ message: `Created ${result.address}`, type: "success" })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open onOpenChange={create.isPending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New domain</DialogTitle>
          <DialogDescription>
            Point a vanity address at a game server.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (server && parsed?.success !== false) create.mutate(server)
          }}
        >
          <div className="type-label space-y-1.5">
            <span id="new-domain-server">Game server</span>
            <GameServerPicker
              domainCounts={domainCounts}
              selectedKey={selectedKey}
              servers={servers}
              onSelect={setSelectedKey}
            />
          </div>

          <VanityNameField
            domain={domain}
            domains={domains}
            error={
              parsed && !parsed.success
                ? (parsed.error.issues[0]?.message ?? "Enter a vanity name")
                : null
            }
            hint="Leave blank and Kiln picks an available name."
            placeholder="generated"
            value={vanityLabel}
            onDomainChange={setDomain}
            onValueChange={setVanityLabel}
          />

          {server && existingCount > 0 ? (
            <PrimaryDomainSwitch
              checked={primary}
              serverName={server.name}
              onCheckedChange={setPrimary}
            />
          ) : server ? (
            <p className="type-meta text-muted-foreground">
              This becomes {server.name}&apos;s connect address.
            </p>
          ) : null}

          {create.error ? <ConfigurationError error={create.error} /> : null}

          <DialogFooter>
            <Button
              disabled={create.isPending}
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                create.isPending || !server || parsed?.success === false
              }
              type="submit"
            >
              {create.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Plus />
              )}
              Create domain
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const emptyServers: Array<DirectoryServer> = []

const GameServerPicker = React.memo(function GameServerPicker({
  domainCounts,
  onSelect,
  selectedKey,
  servers,
}: {
  domainCounts: ReadonlyMap<string, number>
  onSelect: (key: string) => void
  selectedKey: string | null
  servers: ReadonlyArray<DirectoryServer>
}) {
  const [open, setOpen] = React.useState(false)
  const items = React.useMemo(
    () =>
      servers.map((server): InstancePickerItem => {
        const key = serverKey(server.relayId, server.id)
        const count = domainCounts.get(key) ?? 0
        return {
          identity: {
            brickId: server.brickId,
            id: server.id,
            implementation: server.implementation,
            kind: "server",
            relayId: server.relayId,
          },
          key,
          meta: [
            server.relayName,
            server.shortId,
            count > 0 ? `${count} ${count === 1 ? "domain" : "domains"}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
          name: server.name,
          searchText: `${server.id} ${server.relayName} ${server.game}`,
        }
      }),
    [domainCounts, servers]
  )
  const selectedItem = selectedKey
    ? items.find((item) => item.key === selectedKey)
    : undefined
  const selectedKeys = React.useMemo(
    () => new Set(selectedKey ? [selectedKey] : []),
    [selectedKey]
  )
  const selectItem = React.useCallback(
    (item: InstancePickerItem) => {
      onSelect(item.key)
      setOpen(false)
    },
    [onSelect]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          aria-labelledby="new-domain-server"
          className="h-auto min-h-10 w-full justify-between gap-3 px-2 py-1.5 font-normal"
          role="combobox"
          type="button"
          variant="outline"
        >
          {selectedItem ? (
            <InstanceCard
              className="min-w-0 flex-1 gap-2 text-left"
              iconClassName="size-7 border-0 bg-muted/55"
              instance={selectedItem.identity}
              meta={selectedItem.meta}
              metaClassName="font-mono"
              name={selectedItem.name}
              nameClassName="type-control-sm"
              showFavorite={false}
              statusClassName="ring-background"
            />
          ) : (
            <span className="px-1 text-muted-foreground">
              Choose a game server
            </span>
          )}
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="z-[70] w-(--radix-popover-trigger-width) min-w-72 overflow-hidden p-0"
      >
        <InstancePickerContent
          ariaLabel="Game servers"
          emptyMessage="No game servers"
          items={items}
          selectedKeys={selectedKeys}
          onSelect={selectItem}
        />
      </PopoverContent>
    </Popover>
  )
})

function VanityNameField({
  autoFocus = false,
  domain,
  domains,
  error,
  hint,
  onDomainChange,
  onValueChange,
  placeholder,
  value,
}: {
  autoFocus?: boolean
  domain: string
  domains: ReadonlyArray<ManagedDomain>
  error: string | null
  hint: string
  onDomainChange: (domain: string) => void
  onValueChange: (value: string) => void
  placeholder?: string
  value: string
}) {
  return (
    <div className="type-label space-y-1.5">
      <label htmlFor="vanity-label">Vanity name</label>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          autoCapitalize="none"
          autoCorrect="off"
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          className="min-w-0 flex-1 font-mono"
          id="vanity-label"
          maxLength={63}
          name="vanityLabel"
          placeholder={placeholder}
          spellCheck={false}
          value={value}
          onChange={(event) => onValueChange(event.currentTarget.value)}
        />
        {domains.length > 1 ? (
          <Select value={domain} onValueChange={onDomainChange}>
            <SelectTrigger
              aria-label="Domain"
              className="max-w-[60%] min-w-0 gap-0.5 font-mono text-xs [&_[data-slot=select-value]]:truncate"
            >
              <span className="text-muted-foreground">.</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[70]">
              {domains.map((item) => (
                <SelectItem
                  key={item.domain}
                  className="font-mono text-xs"
                  value={item.domain}
                >
                  {item.domain}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="type-code shrink-0 text-muted-foreground">
            .{domain}
          </span>
        )}
      </div>
      <span
        className={
          error
            ? "type-meta block text-destructive"
            : "type-meta block text-muted-foreground"
        }
      >
        {error ?? hint}
      </span>
    </div>
  )
}

function PrimaryDomainSwitch({
  checked,
  onCheckedChange,
  serverName,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  serverName: string
}) {
  return (
    <div className="flex items-center justify-between gap-4 border border-border/75 bg-background/35 p-3">
      <div>
        <p className="text-xs font-medium">Use as connect address</p>
        <p className="type-meta mt-0.5 text-muted-foreground">
          Show this domain on {serverName}&apos;s pages instead of its current
          one.
        </p>
      </div>
      <Switch
        aria-label="Use as connect address"
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  )
}

function EditDomainDialog({
  domain,
  domains,
  onOpenChange,
}: {
  domain: ManagedDomainOverview
  domains: ReadonlyArray<ManagedDomain>
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [vanityLabel, setVanityLabel] = React.useState(domain.vanityLabel)
  const [suffix, setSuffix] = React.useState(domain.domain)
  const [primary, setPrimary] = React.useState(domain.primary)
  const parsed = vanityLabelSchema.safeParse(vanityLabel)
  // Its current domain stays a choice even when it's disabled or no longer
  // configured, so it can be renamed in place.
  const choices = React.useMemo(
    () =>
      domains.some((item) => item.domain === domain.domain)
        ? domains
        : [
            ...domains,
            {
              domain: domain.domain,
              enabled: false,
              isDefault: false,
              zoneId: "",
              zoneName: domain.zoneName ?? domain.domain,
            },
          ],
    [domain.domain, domain.zoneName, domains]
  )
  const unchanged =
    parsed.success &&
    parsed.data === domain.vanityLabel &&
    suffix === domain.domain &&
    primary === domain.primary
  const save = useMutation({
    mutationFn: (label: string) =>
      updateInstanceDomain({
        data: { domain: suffix, id: domain.id, primary, vanityLabel: label },
      }),
    // A failed rename can still clear a failed domain's leftover records.
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.domains.settings,
      }),
    onSuccess: (result) => {
      showToast({ message: `Saved ${result.address}`, type: "success" })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open onOpenChange={save.isPending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit domain</DialogTitle>
          <DialogDescription>
            Choose the vanity address players use to join {domain.server.name}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (parsed.success && !unchanged) save.mutate(parsed.data)
          }}
        >
          <VanityNameField
            autoFocus
            domain={suffix}
            domains={choices}
            error={
              parsed.success
                ? null
                : (parsed.error.issues[0]?.message ?? "Enter a vanity name")
            }
            hint="Kiln updates the DNS records in Cloudflare."
            value={vanityLabel}
            onDomainChange={setSuffix}
            onValueChange={setVanityLabel}
          />

          {domain.primary ? (
            domain.domainCount > 1 ? (
              <p className="type-meta text-muted-foreground">
                This is {domain.server.name}&apos;s connect address. Make
                another of its domains primary to change it.
              </p>
            ) : null
          ) : (
            <PrimaryDomainSwitch
              checked={primary}
              serverName={domain.server.name}
              onCheckedChange={setPrimary}
            />
          )}

          {save.error ? <ConfigurationError error={save.error} /> : null}

          <DialogFooter>
            <Button
              disabled={save.isPending}
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={save.isPending || !parsed.success || unchanged}
              type="submit"
            >
              {save.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Check />
              )}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteDomainDialog({
  domain,
  onOpenChange,
}: {
  domain: ManagedDomainOverview
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const hostname = domainHostname(domain)
  const remove = useMutation({
    mutationFn: () => removeInstanceDomain({ data: { id: domain.id } }),
    // A failed delete marks the domain as failed, so refresh either way.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.domains.settings,
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.relay.snapshot }),
      ]),
    onSuccess: () => {
      showToast({ message: `Deleted ${hostname}`, type: "success" })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open onOpenChange={remove.isPending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete domain</DialogTitle>
          <DialogDescription>
            Kiln deletes <span className="font-mono">{hostname}</span> from
            Cloudflare.{" "}
            {domain.domainCount > 1
              ? domain.primary
                ? `Another of ${domain.server.name}'s domains becomes its connect address.`
                : `${domain.server.name} keeps its other domains.`
              : `Players join ${domain.server.name} by its Relay address instead, and Kiln won't give it a new vanity domain when it starts or syncs.`}
          </DialogDescription>
        </DialogHeader>

        {remove.error ? <ConfigurationError error={remove.error} /> : null}

        <DialogFooter>
          <Button
            disabled={remove.isPending}
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={remove.isPending}
            type="button"
            variant="destructive"
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Trash2 />
            )}
            Delete domain
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A Cloudflare zone in the configuration list. */
interface DomainChoice {
  /** The suffix Kiln uses: the zone itself or a name inside it. */
  domain: string
  /** Configured, but the current token can't reach its zone. */
  missing: boolean
  selected: boolean
  zoneId: string
  zoneName: string
}

type TokenCheck =
  | { status: "idle" }
  | { status: "checking" }
  | { count: number; status: "ready" }
  | { message: string; status: "error" }

function DomainConfigurationDialog({
  domainUsage,
  hearthDomain,
  integration,
  onOpenChange,
}: {
  domainUsage: ReadonlyMap<string, number>
  hearthDomain: string
  integration: DomainIntegration | null
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const hasIntegration = integration !== null
  const [mode, setMode] = React.useState<"settings" | "permissions">("settings")
  const [apiToken, setApiToken] = React.useState("")
  const [choices, setChoices] = React.useState<Array<DomainChoice>>(
    () =>
      integration?.domains.map((domain) => ({
        domain: domain.domain,
        missing: false,
        selected: domain.enabled,
        zoneId: domain.zoneId,
        zoneName: domain.zoneName,
      })) ?? []
  )
  const [defaultZoneId, setDefaultZoneId] = React.useState(
    () => integration?.domains.find((domain) => domain.isDefault)?.zoneId ?? ""
  )
  const [strategy, setStrategy] = React.useState<DomainAssignmentStrategy>(
    integration?.strategy ?? "default"
  )
  const [enabled, setEnabled] = React.useState(integration?.enabled ?? true)
  const [blacklistPatterns, setBlacklistPatterns] = React.useState(() =>
    (
      integration?.blacklistPatterns ?? [...defaultDomainBlacklistPatterns]
    ).join("\n")
  )
  const [tokenCheck, setTokenCheck] = React.useState<TokenCheck>({
    status: "idle",
  })
  // Bumped by the refresh button to list the zones again.
  const [scan, setScan] = React.useState(0)

  // Lists the zones a pasted token, or the saved one, can manage. A newer
  // token interrupts the check before a slow answer can overwrite it.
  React.useEffect(() => {
    const token = apiToken.trim()
    if (token ? token.length < 20 : !hasIntegration) {
      setTokenCheck({ status: "idle" })
      return
    }
    const fiber = Effect.runFork(
      Effect.sleep(token && scan === 0 ? 400 : 0).pipe(
        Effect.andThen(
          Effect.sync(() => setTokenCheck({ status: "checking" }))
        ),
        Effect.andThen(
          promiseEffect(() =>
            discoverCloudflareDomains({
              data: { apiToken: token || undefined },
            })
          )
        ),
        Effect.match({
          onFailure: (cause) =>
            setTokenCheck({ message: errorMessage(cause), status: "error" }),
          onSuccess: ({ zones }) => {
            setChoices((current) => mergeDiscoveredZones(current, zones))
            setTokenCheck({ count: zones.length, status: "ready" })
          },
        })
      )
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [apiToken, hasIntegration, scan])

  const selected = choices.filter((choice) => choice.selected)
  // The first chosen domain stands in until one is picked.
  const effectiveDefault =
    selected.find((choice) => choice.zoneId === defaultZoneId) ?? selected[0]
  const configure = useMutation({
    mutationFn: configureDomainIntegration,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.domains.settings,
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.relay.snapshot }),
      ])
      showToast({
        message: "Cloudflare vanity configuration saved",
        type: "success",
      })
      onOpenChange(false)
    },
  })

  const updateChoice = React.useCallback(
    (zoneId: string, change: Partial<DomainChoice>) =>
      setChoices((current) =>
        current.map((choice) =>
          choice.zoneId === zoneId ? { ...choice, ...change } : choice
        )
      ),
    []
  )

  const save = () => {
    const domains: Array<{ domain: string; zoneId: string }> = []
    for (const choice of selected) {
      const parsed = domainNameSchema.safeParse(choice.domain)
      if (!parsed.success || !domainInZone(parsed.data, choice.zoneName)) {
        showToast({
          message: `Use ${choice.zoneName} or a name ending in .${choice.zoneName}`,
          type: "error",
        })
        return
      }
      domains.push({ domain: parsed.data, zoneId: choice.zoneId })
    }
    const defaultDomain = effectiveDefault
      ? domains[selected.indexOf(effectiveDefault)]?.domain
      : undefined
    if (!defaultDomain) {
      showToast({ message: "Choose at least one domain", type: "error" })
      return
    }
    const patternsResult = Result.try(() =>
      validateBlacklistPatterns(
        blacklistPatterns
          .split(/\r?\n/u)
          .map((pattern) => pattern.trim())
          .filter(Boolean)
      )
    )
    if (Result.isFailure(patternsResult)) {
      showToast({
        message: errorMessage(patternsResult.failure),
        type: "error",
      })
      return
    }
    const token = apiToken.trim()
    configure.mutate({
      data: {
        apiToken: token || undefined,
        blacklistPatterns: patternsResult.success,
        defaultDomain,
        domains,
        enabled,
        strategy,
      },
    })
  }

  const tokenLength = apiToken.trim().length
  const tokenInvalid = tokenLength < 20 && (!hasIntegration || tokenLength > 0)

  return (
    <Dialog open onOpenChange={configure.isPending ? undefined : onOpenChange}>
      <DialogContent
        className={mode === "permissions" ? "sm:max-w-3xl" : "sm:max-w-xl"}
      >
        <DialogHeader>
          {mode === "settings" ? (
            <>
              <DialogTitle>Configure Vanity URLs</DialogTitle>
              <DialogDescription className="sr-only">
                Connect Cloudflare and choose the domains Kiln gives game
                servers addresses under.
              </DialogDescription>
            </>
          ) : (
            <div className="flex items-center gap-3">
              <Button
                className="-ml-2"
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => setMode("settings")}
              >
                <ArrowLeft /> Back
              </Button>
              <DialogTitle>Required Cloudflare permissions</DialogTitle>
              <DialogDescription className="sr-only">
                Cloudflare permissions required by Kiln.
              </DialogDescription>
            </div>
          )}
        </DialogHeader>

        {mode === "settings" ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <label
                  className="type-control-sm"
                  htmlFor="cloudflare-api-token"
                >
                  Cloudflare API token
                </label>
                <a
                  className="type-label inline-flex items-center gap-1 text-primary hover:underline"
                  href="https://dash.cloudflare.com/profile/api-tokens"
                  rel="noreferrer"
                  target="_blank"
                >
                  Create token <ExternalLink className="size-2.5" />
                </a>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  autoComplete="new-password"
                  autoFocus={!hasIntegration}
                  className="min-w-0 flex-1 font-mono"
                  id="cloudflare-api-token"
                  minLength={20}
                  name="apiToken"
                  placeholder={
                    hasIntegration ? "Saved token" : "Paste a Cloudflare token"
                  }
                  required={!hasIntegration}
                  type="password"
                  value={apiToken}
                  onChange={(event) => setApiToken(event.currentTarget.value)}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="Preview required Cloudflare permissions"
                      size="icon"
                      type="button"
                      variant="outline"
                      onClick={() => setMode("permissions")}
                    >
                      <CircleHelp />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    Preview required permissions
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <p className="type-control-sm" id="vanity-domains">
                  Domains
                </p>
                <div className="flex items-center gap-2">
                  {tokenCheck.status === "error" && choices.length > 0 ? (
                    <span className="type-meta flex min-w-0 items-center gap-1 text-destructive">
                      <CircleAlert className="size-3 shrink-0" />
                      <span className="truncate">{tokenCheck.message}</span>
                    </span>
                  ) : choices.length > 0 ? (
                    <span className="type-meta text-muted-foreground tabular-nums">
                      {selected.length} of {choices.length} enabled
                    </span>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label="Refresh domains from Cloudflare"
                        disabled={
                          tokenCheck.status === "checking" ||
                          (tokenLength === 0
                            ? !hasIntegration
                            : tokenLength < 20)
                        }
                        size="icon-xs"
                        type="button"
                        variant="ghost"
                        onClick={() => setScan((current) => current + 1)}
                      >
                        <RefreshCw
                          className={
                            tokenCheck.status === "checking"
                              ? "animate-spin"
                              : undefined
                          }
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      Refresh from Cloudflare
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <div className="max-h-60 overflow-y-auto rounded-md border border-border/75 bg-background/35">
                <table
                  aria-labelledby="vanity-domains"
                  className="w-full table-fixed border-collapse"
                >
                  <thead className="sticky top-0 z-10 bg-[color-mix(in_oklab,var(--surface-overlay)_92%,transparent)] backdrop-blur">
                    <tr className="type-technical-label text-left text-muted-foreground">
                      <th className="w-10 px-3 py-2 font-normal">
                        <span className="sr-only">Use</span>
                      </th>
                      <th className="px-1 py-2 font-normal">Domain</th>
                      <th className="w-20 px-2 py-2 text-right font-normal">
                        In use
                      </th>
                      <th className="w-20 px-3 py-2 text-center font-normal">
                        Default
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60 border-t border-border/60">
                    {choices.length > 0 ? (
                      choices.map((choice) => (
                        <DomainZoneRow
                          key={choice.zoneId}
                          choice={choice}
                          isDefault={choice === effectiveDefault}
                          usage={domainUsage.get(choice.domain) ?? 0}
                          onChange={updateChoice}
                          onMakeDefault={setDefaultZoneId}
                        />
                      ))
                    ) : (
                      <tr>
                        <td
                          className="type-meta px-3 py-6 text-center text-muted-foreground"
                          colSpan={4}
                        >
                          {tokenCheck.status === "checking" ? (
                            "Listing the token's domains…"
                          ) : tokenCheck.status === "error" ? (
                            <span className="text-destructive">
                              {tokenCheck.message}
                            </span>
                          ) : (
                            "Paste a token to list the domains it can manage."
                          )}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex flex-col gap-3 border border-border/75 bg-background/35 p-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="type-control-sm" id="automatic-provisioning">
                  Automatic provisioning
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Select
                  disabled={!enabled}
                  value={strategy}
                  onValueChange={(value) =>
                    setStrategy(value as DomainAssignmentStrategy)
                  }
                >
                  <SelectTrigger
                    aria-label="Domain for new game servers"
                    className="w-36 text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[70]">
                    {strategyOptions.map((option) => (
                      <SelectItem
                        key={option.value}
                        className="text-xs"
                        value={option.value}
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Switch
                  aria-labelledby="automatic-provisioning"
                  checked={enabled}
                  onCheckedChange={setEnabled}
                />
              </div>
            </div>

            <label className="type-label block space-y-1.5">
              Blacklisted vanity names
              <Textarea
                aria-label="Blacklisted vanity name patterns"
                className="min-h-24 font-mono text-xs"
                placeholder={"^(admin|api|www)$\n^staff-"}
                value={blacklistPatterns}
                onChange={(event) =>
                  setBlacklistPatterns(event.currentTarget.value)
                }
              />
              <span className="type-meta block text-muted-foreground">
                One case-insensitive regular expression per line.
              </span>
            </label>

            {configure.error ? (
              <ConfigurationError error={configure.error} />
            ) : null}

            <DialogFooter>
              <Button
                disabled={configure.isPending}
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                disabled={
                  configure.isPending || tokenInvalid || selected.length === 0
                }
                type="button"
                onClick={save}
              >
                {configure.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Check />
                )}
                {tokenLength ? "Verify & save" : "Save configuration"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <CloudflarePermissionsPreview
            domain={effectiveDefault?.zoneName ?? hearthDomain}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

const DomainZoneRow = React.memo(function DomainZoneRow({
  choice,
  isDefault,
  onChange,
  onMakeDefault,
  usage,
}: {
  choice: DomainChoice
  isDefault: boolean
  onChange: (zoneId: string, change: Partial<DomainChoice>) => void
  onMakeDefault: (zoneId: string) => void
  usage: number
}) {
  return (
    <tr className={choice.selected ? undefined : "text-muted-foreground"}>
      <td className="px-3 py-1.5 align-middle">
        <label className="flex cursor-pointer items-center">
          <input
            aria-label={`Use ${choice.zoneName}`}
            checked={choice.selected}
            className="peer sr-only"
            type="checkbox"
            onChange={(event) =>
              onChange(choice.zoneId, { selected: event.currentTarget.checked })
            }
          />
          <span
            className={`grid size-4 place-items-center rounded-sm border peer-focus-visible:ring-2 peer-focus-visible:ring-ring/40 ${
              choice.selected
                ? "border-primary bg-primary text-primary-foreground"
                : "border-input"
            }`}
          >
            {choice.selected ? <Check className="size-3" /> : null}
          </span>
        </label>
      </td>
      <td className="px-1 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="type-code min-w-0 truncate">{choice.domain}</span>
          {!choice.selected && usage > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="type-meta shrink-0 text-muted-foreground">
                  Existing only
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                Its {usage} game server {usage === 1 ? "domain keeps" : "domains keep"}{" "}
                working. New game servers won&apos;t get it.
              </TooltipContent>
            </Tooltip>
          ) : null}
          <span className="flex-1" />
          {choice.missing ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <CircleAlert
                  aria-label="This token can't manage this zone"
                  className="size-3.5 shrink-0 text-amber-600 dark:text-amber-300"
                />
              </TooltipTrigger>
              <TooltipContent side="left">
                This token can&apos;t manage {choice.zoneName}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </td>
      <td className="type-meta px-2 py-1.5 text-right text-muted-foreground tabular-nums">
        {usage > 0 ? usage : "–"}
      </td>
      <td className="px-3 py-1.5 text-center">
        <label
          className={`inline-flex ${choice.selected ? "cursor-pointer" : "cursor-not-allowed opacity-40"}`}
        >
          <input
            aria-label={`Make ${choice.domain} the default`}
            checked={isDefault}
            className="peer sr-only"
            disabled={!choice.selected}
            name="default-domain"
            type="radio"
            onChange={() => onMakeDefault(choice.zoneId)}
          />
          <span
            className={`grid size-4 place-items-center rounded-full border peer-focus-visible:ring-2 peer-focus-visible:ring-ring/40 ${
              isDefault ? "border-primary" : "border-input"
            }`}
          >
            {isDefault ? (
              <span className="size-2 rounded-full bg-primary" />
            ) : null}
          </span>
        </label>
      </td>
    </tr>
  )
})

/**
 * Keeps choices for zones still reachable, adds new zones, and flags chosen
 * zones the token lost. A first setup starts with every zone chosen.
 */
function mergeDiscoveredZones(
  current: ReadonlyArray<DomainChoice>,
  zones: ReadonlyArray<DiscoveredCloudflareZone>
): Array<DomainChoice> {
  const byZone = new Map(current.map((choice) => [choice.zoneId, choice]))
  const selectNew = !current.some((choice) => choice.selected)
  const reachable = new Set(zones.map((zone) => zone.id))
  return [
    ...zones.map((zone): DomainChoice => {
      const existing = byZone.get(zone.id)
      return existing
        ? { ...existing, missing: false, zoneName: zone.name }
        : {
            domain: zone.name,
            missing: false,
            selected: selectNew,
            zoneId: zone.id,
            zoneName: zone.name,
          }
    }),
    ...current
      .filter((choice) => choice.selected && !reachable.has(choice.zoneId))
      .map((choice) => ({ ...choice, missing: true })),
  ]
}

function CloudflarePermissionsPreview({ domain }: { domain: string }) {
  return (
    <div className="space-y-4">
      <CloudflarePermissionPolicy domain={domain} />

      <div className="flex gap-2 border border-amber-500/25 bg-amber-400/8 p-3 text-amber-950/85 dark:border-amber-400/20 dark:bg-amber-400/5 dark:text-amber-100/85">
        <KeyRound className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
        <p className="type-meta">
          Add every zone Kiln should use to the token, or choose all zones.
          Kiln encrypts the token at rest, never returns it to the browser, and
          keeps every managed record DNS-only.
        </p>
      </div>
    </div>
  )
}

function CloudflarePermissionPolicy({ domain }: { domain: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-black/15 bg-[#fafafa] text-[#191919] shadow-lg shadow-black/10 dark:border-white/12 dark:bg-[#101010] dark:text-[#ededed] dark:shadow-black/15">
      <div className="flex items-center justify-between border-b border-black/10 bg-[#f1f1f1] px-3 py-2.5 dark:border-white/10 dark:bg-[#141414]">
        <p className="type-label">Edit policy</p>
        <span className="type-meta text-stone-600 dark:text-stone-300">
          Custom
        </span>
      </div>

      <div className="grid gap-2 border-b border-black/10 p-3 sm:grid-cols-[minmax(9rem,0.8fr)_minmax(0,1.35fr)] dark:border-white/10">
        <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-black/15 bg-white px-3 py-2.5 dark:border-white/15 dark:bg-white/[0.025]">
          <span className="type-label">Specified domains</span>
          <ChevronDown className="size-3.5 shrink-0 text-black/45 dark:text-white/45" />
        </div>
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-black/20 bg-white px-3 py-2.5 dark:border-white/20 dark:bg-white/[0.045]">
          <Globe2 className="size-3.5 shrink-0 text-black/70 dark:text-white/70" />
          <span className="type-code truncate text-stone-900 dark:text-stone-100">
            {domain}
          </span>
          <ChevronDown className="ml-auto size-3.5 shrink-0 text-black/45 dark:text-white/45" />
        </div>
      </div>

      <VisualPermissionGroup label="Developer Platform" total={4} />
      <VisualPermissionGroup label="AI & Machine Learning" total={4} />
      <VisualPermissionGroup label="DNS & Zones" selected={2} total={12}>
        <CloudflarePermissionRow
          description="Grants write access to DNS"
          edit
          name="DNS"
        />
        <CloudflarePermissionRow
          description="Grants read access to zone management"
          name="Zone"
          read
        />
        <CloudflarePermissionRow
          description="Grants read access to zone custom assets"
          name="Zone Custom Asset"
        />
        <CloudflarePermissionRow
          description="Grants access to Zone DNS Settings"
          name="Zone DNS Settings"
        />
        <CloudflarePermissionRow
          description="Grants access to zone settings"
          name="Zone Settings"
        />
      </VisualPermissionGroup>
      <VisualPermissionGroup label="App Security" total={25} />
    </div>
  )
}

function VisualPermissionGroup({
  children,
  label,
  selected = 0,
  total,
}: {
  children?: React.ReactNode
  label: string
  selected?: number
  total: number
}) {
  const expanded = children !== undefined

  return (
    <div className="border-b border-black/10 last:border-b-0 dark:border-white/10">
      <div className="flex items-center gap-2 bg-black/[0.015] px-3 py-2.5 dark:bg-white/[0.015]">
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-black/75 dark:text-white/75" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-black/30 dark:text-white/30" />
        )}
        <span
          className={
            expanded
              ? "type-label text-stone-900 dark:text-stone-100"
              : "type-label text-stone-600 dark:text-stone-300"
          }
        >
          {label}
        </span>
        <span className="type-meta ml-auto font-mono text-stone-600 dark:text-stone-300">
          {selected}/{total}
        </span>
      </div>
      {children}
    </div>
  )
}

function CloudflarePermissionRow({
  description,
  edit = false,
  name,
  read = false,
}: {
  description: string
  edit?: boolean
  name: string
  read?: boolean
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-t border-dashed border-black/10 px-3 py-2.5 sm:grid-cols-[minmax(8rem,0.8fr)_minmax(10rem,1.25fr)_auto] sm:items-center dark:border-white/10">
      <p className="type-label col-start-1 row-start-1 truncate text-stone-900 dark:text-stone-100">
        {name}
      </p>
      <p className="type-meta col-start-1 row-start-2 mt-0.5 truncate text-stone-600 sm:col-start-2 sm:row-start-1 sm:mt-0 dark:text-stone-300">
        {description}
      </p>
      <div className="col-start-2 row-span-2 row-start-1 flex items-center rounded-md border border-black/12 bg-black/[0.035] p-1 sm:col-start-3 sm:row-span-1 dark:border-white/12 dark:bg-black/25">
        <PermissionAccess active={read} label="Read" />
        <PermissionAccess active={edit} label="Edit" />
      </div>
    </div>
  )
}

function PermissionAccess({
  active,
  label,
}: {
  active: boolean
  label: string
}) {
  return (
    <span
      className={
        active
          ? "type-label flex items-center gap-1.5 rounded px-1.5 py-1 text-stone-900 dark:text-stone-100"
          : "type-meta flex items-center gap-1.5 rounded px-1.5 py-1 text-stone-600 dark:text-stone-300"
      }
    >
      <span
        className={
          active
            ? "grid size-3.5 place-items-center rounded-[3px] border border-black bg-black text-white dark:border-white dark:bg-white dark:text-black"
            : "size-3.5 rounded-[3px] border border-black/20 bg-black/[0.025] dark:border-white/15 dark:bg-black/20"
        }
      >
        {active ? <Check className="size-2.5" strokeWidth={3} /> : null}
      </span>
      {label}
      <span className="sr-only">{active ? "selected" : "not selected"}</span>
    </span>
  )
}

function ConfigurationError({ error }: { error: Error }) {
  return (
    <p className="border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      {errorMessage(error)}
    </p>
  )
}

function serverKey(relayId: string, instanceId: string): string {
  return `${relayId}:${instanceId}`
}

function domainHostname(domain: ManagedDomainOverview): string {
  return `${domain.vanityLabel}.${domain.domain}`
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
  return {
    detail: domain.lastError ?? undefined,
    label: "Error",
    tone: "danger",
  }
}

// Cloudflare resolves `:account` to the signed-in account that owns the zone.
function cloudflareDnsRecordsUrl(zoneName: string): string {
  return `https://dash.cloudflare.com/?to=/:account/${encodeURIComponent(zoneName)}/dns/records`
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not save the domain"
}

function showErrorToast(cause: Error) {
  showToast({ message: errorMessage(cause), type: "error" })
}
