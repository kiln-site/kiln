import * as React from "react"
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  Check,
  CircleAlert,
  ExternalLink,
  Globe2,
  Info,
  Pencil,
  Plus,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Zap,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  DataTableActionGroup,
  DataTableEmptyState,
} from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { InfoCopyValue, InfoRailCard } from "@/components/info-page"
import { HearthMark } from "@/components/hearth-mark"
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
  domainStatusPresentation,
  showErrorToast,
  vanityDomainChoices,
  type DomainConnectionOverview,
  type DomainSettings,
} from "@/components/domains-shared"
import { WorkspacePage } from "@/components/workspace-page"
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
import { appRouteIdentifier } from "@/lib/app-route"
import {
  appDirectoryQueryOptions,
  domainSettingsQueryOptions,
  manualWebHostnamesQueryOptions,
  queryKeys,
  serverDirectoryQueryOptions,
} from "@/lib/query-options"
import { relayInstanceRouteId } from "@/lib/relay-fleet"
import {
  resyncDomainAssignments,
  type ManagedDomainOverview,
  type WebHostnameOverview,
} from "@/server/domains"

type DomainDialog =
  | { connection: DomainConnectionOverview | null; kind: "connection" }
  | { kind: "delete"; domain: ManagedDomainOverview }
  | { kind: "edit"; domain: ManagedDomainOverview }
  | { hostname: WebHostnameOverview; kind: "release" }
  | null

/**
 * A row of the table: a game server's vanity address, or a web route
 * hostname, whether Kiln keeps its DNS record or not.
 */
type DomainRow =
  | { domain: ManagedDomainOverview; id: string; kind: "server" }
  | { hostname: WebHostnameOverview; id: string; kind: "web" }

/** Which rows the table shows. */
interface DomainFilter {
  dns: "all" | "kiln" | "manual"
  kind: "all" | "server" | "web"
}

const allDomains: DomainFilter = { dns: "all", kind: "all" }

const domainKindFilters: ReadonlyArray<{
  label: string
  value: DomainFilter["kind"]
}> = [
  { label: "Everything", value: "all" },
  { label: "Game server addresses", value: "server" },
  { label: "Web routes", value: "web" },
]

const domainDnsFilters: ReadonlyArray<{
  label: string
  value: DomainFilter["dns"]
}> = [
  { label: "Any", value: "all" },
  { label: "Managed by Kiln", value: "kiln" },
  { label: "Manual", value: "manual" },
]

function rowMatches(row: DomainRow, filter: DomainFilter): boolean {
  if (filter.kind !== "all" && row.kind !== filter.kind) return false
  if (filter.dns === "all") return true
  const manual = row.kind === "web" && row.hostname.status === "manual"
  return manual === (filter.dns === "manual")
}

const domainTableColumnHelper = createDataTableColumnHelper<DomainRow>()
const domainTableSearchFields = [
  (row: DomainRow) => rowHostname(row),
  (row: DomainRow) =>
    row.kind === "server" ? row.domain.server.name : row.hostname.resource.name,
  (row: DomainRow) =>
    row.kind === "server" ? row.domain.server.game : row.hostname.target,
  (row: DomainRow) =>
    row.kind === "server" ? row.domain.instanceId : row.hostname.resource.id,
  (row: DomainRow) => (row.kind === "server" ? row.domain.port : null),
  (row: DomainRow) =>
    row.kind === "server" ? row.domain.relayName : row.hostname.relayName,
  (row: DomainRow) => rowStatus(row).label,
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

const DeleteDomainDialog = React.lazy(async () => ({
  default: (await loadDomainDialogs()).DeleteDomainDialog,
}))
const DomainConnectionDialog = React.lazy(async () => ({
  default: (await loadDomainDialogs()).DomainConnectionDialog,
}))
const ReleaseHostnameDialog = React.lazy(async () => ({
  default: (await loadDomainDialogs()).ReleaseHostnameDialog,
}))
const EditDomainDialog = React.lazy(async () => ({
  default: (await loadDomainDialogs()).EditDomainDialog,
}))

/** The game server or app the table is filtered to. */
interface DomainScope {
  instanceId: string
  kind: "app" | "server"
  /** Missing when a link names only the instance. */
  relayId: string | undefined
}

/** A game server or app to scope to, with where its domains are managed. */
type ScopeOption = ServerPickerOption<"app" | "server"> & {
  kind: "app" | "server"
  /** The `/server/$serverId` or `/app/$appId` param. */
  routeId: string
}

export const DomainsPage = React.memo(function DomainsPage({
  initialScope,
  searchStore,
}: {
  initialScope: DomainScope | null
  searchStore: DataTableSearchStore
}) {
  const { data } = useSuspenseQuery(domainSettingsQueryOptions())
  // From the Relays, so it fills in after the page.
  const { data: manualHostnames = noManualHostnames } = useQuery(
    manualWebHostnamesQueryOptions()
  )
  const [dialog, setDialog] = React.useState<DomainDialog>(null)
  const [scope, setScope] = React.useState(initialScope)
  const [filter, setFilter] = React.useState(allDomains)
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
  const scopeOptions = useScopeOptions()
  const scopeTarget = React.useMemo(
    () =>
      (scope &&
        scopeOptions.find(
          (option) =>
            option.kind === scope.kind &&
            option.id === scope.instanceId &&
            (!scope.relayId || option.relayId === scope.relayId)
        )) ||
      null,
    [scope, scopeOptions]
  )
  const selectScope = React.useCallback(
    (next: ServerPickerOption<"app" | "server"> | null) => {
      const kind = next?.kind === "app" ? "app" : "server"
      setScope(
        next ? { instanceId: next.id, kind, relayId: next.relayId } : null
      )
      // Like the table search, the URL follows without a router render.
      replaceDataTableUrlSearch(
        next && kind === "server" ? next.id : "",
        "server"
      )
      replaceDataTableUrlSearch(next && kind === "app" ? next.id : "", "app")
      replaceDataTableUrlSearch(next?.relayId ?? "", "relay")
    },
    []
  )
  const rows = React.useMemo(() => {
    const inScope = (
      kind: DomainScope["kind"],
      resourceId: string,
      relayId: string
    ) =>
      !scope ||
      (kind === scope.kind &&
        resourceId === scope.instanceId &&
        (!scope.relayId || relayId === scope.relayId))
    const result: Array<DomainRow> = []
    for (const domain of data.managedDomains) {
      if (inScope("server", domain.instanceId, domain.relayId)) {
        result.push({ domain, id: `server:${domain.id}`, kind: "server" })
      }
    }
    for (const hostname of [...data.webHostnames, ...manualHostnames]) {
      if (
        inScope(hostname.resource.kind, hostname.resource.id, hostname.relayId)
      ) {
        result.push({ hostname, id: `web:${hostname.id}`, kind: "web" })
      }
    }
    return result.filter((row) => rowMatches(row, filter))
  }, [data.managedDomains, data.webHostnames, filter, manualHostnames, scope])
  const openConnection = React.useCallback(
    (connection: DomainConnectionOverview | null) =>
      setDialog({ connection, kind: "connection" }),
    []
  )
  const closeDialog = React.useCallback((open: boolean) => {
    if (!open) setDialog(null)
  }, [])
  const vanityDomains = React.useMemo(() => vanityDomainChoices(data), [data])

  return (
    <WorkspacePage
      rail={<DomainsRail settings={data} onOpenConnection={openConnection} />}
      railClassName="xl:w-76 2xl:w-88"
      summary={
        <ServerScopePicker<"app" | "server">
          allLabel="All instances"
          ariaLabel="Game servers and apps"
          changeLabel="Change instance"
          chooseLabel="Choose game server or app"
          emptyMessage="No game servers or apps found."
          selectedServer={scopeTarget}
          servers={scopeOptions}
          onSelect={selectScope}
        />
      }
    >
      <DataTableWorkspace
        toolbar={
          <DomainsToolbar
            filter={filter}
            scopeTarget={scopeTarget}
            searchStore={searchStore}
            onFilterChange={setFilter}
          />
        }
      >
        <DomainsTable
          rows={rows}
          searchStore={searchStore}
          onDialog={setDialog}
        />
      </DataTableWorkspace>

      <React.Suspense fallback={null}>
        {dialog?.kind === "connection" ? (
          <DomainConnectionDialog
            key={dialog.connection?.id ?? "new"}
            canManagePlatform={data.canManagePlatform}
            connection={dialog.connection}
            connections={data.connections}
            hearthDomain={data.hearthDomain}
            onOpenChange={closeDialog}
          />
        ) : null}
        {dialog?.kind === "edit" ? (
          <EditDomainDialog
            key={dialog.domain.id}
            domain={dialog.domain}
            domains={vanityDomains}
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
        {dialog?.kind === "release" ? (
          <ReleaseHostnameDialog
            key={dialog.hostname.id}
            hostname={dialog.hostname}
            onOpenChange={closeDialog}
          />
        ) : null}
      </React.Suspense>
    </WorkspacePage>
  )
})

const noManualHostnames: Array<WebHostnameOverview> = []

/** The game servers and apps the table can be scoped to. */
function useScopeOptions(): Array<ScopeOption> {
  const { data: servers } = useQuery(serverDirectoryQueryOptions())
  const { data: apps } = useQuery(appDirectoryQueryOptions())
  return React.useMemo(
    () => [
      ...(servers ?? []).map((server): ScopeOption => ({
        id: server.id,
        kind: "server",
        name: server.name,
        relayId: server.relayId,
        relayName: server.relayName,
        routeId: relayInstanceRouteId(server.relayId, server.id),
      })),
      ...(apps ?? []).map((app, _index, all): ScopeOption => ({
        id: app.id,
        kind: "app",
        name: app.name,
        relayId: app.relayId,
        relayName: app.relayName,
        routeId: appRouteIdentifier(all, app),
      })),
    ],
    [apps, servers]
  )
}

/** A domain in the rail. */
interface RailDomain {
  /** Opens to edit it; null when the person can't. */
  connection: DomainConnectionOverview | null
  error: string | null
  key: string
  name: string
  /** On a Kiln connection; Kiln provides the vanity ones to everyone. */
  shared: boolean
  vanity: boolean
}

/**
 * Every domain Kiln keeps DNS on for the person: the zones on their
 * connections (and the shared ones, for administrators), then the shared
 * vanity domains.
 */
function railDomains(
  data: Pick<DomainSettings, "connections" | "platformDomains">
): Array<RailDomain> {
  const domains: Array<RailDomain> = []
  const listed = new Set<string>()
  for (const connection of data.connections) {
    const vanity = new Map(
      connection.domains.map((domain) => [domain.zoneId, domain])
    )
    const zoneIds = new Set(connection.zones.map((zone) => zone.id))
    const add = (
      name: string,
      domain: (typeof connection.domains)[number] | undefined
    ) => {
      listed.add(name)
      domains.push({
        connection,
        error: connection.lastError,
        key: `${connection.id}:${name}`,
        name,
        shared: connection.platform,
        vanity: Boolean(domain?.enabled),
      })
    }
    for (const zone of connection.zones) {
      const domain = vanity.get(zone.id)
      add(domain?.domain ?? zone.name, domain)
    }
    // A vanity domain whose zone the token no longer reaches.
    for (const domain of connection.domains) {
      if (!zoneIds.has(domain.zoneId)) add(domain.domain, domain)
    }
    // A connection that reaches nothing still needs a way in.
    if (connection.zones.length === 0 && connection.domains.length === 0) {
      domains.push({
        connection,
        error: connection.lastError ?? "No zones",
        key: connection.id,
        name: connection.name,
        shared: connection.platform,
        vanity: false,
      })
    }
  }
  for (const domain of data.platformDomains) {
    if (listed.has(domain.domain)) continue
    domains.push({
      connection: null,
      error: null,
      key: `shared:${domain.domain}`,
      name: domain.domain,
      shared: true,
      vanity: true,
    })
  }
  // The person's own first, then Kiln's.
  return domains.sort(
    (left, right) =>
      Number(left.shared) - Number(right.shared) ||
      left.name.localeCompare(right.name)
  )
}

/** The domains Kiln keeps DNS records on, the person's own then Kiln's. */
const DomainsRail = React.memo(function DomainsRail({
  onOpenConnection,
  settings,
}: {
  onOpenConnection: (connection: DomainConnectionOverview | null) => void
  settings: Pick<DomainSettings, "connections" | "platformDomains">
}) {
  const domains = React.useMemo(() => railDomains(settings), [settings])
  return (
    <InfoRailCard
      action={
        <div className="flex items-center gap-1.5">
          {settings.connections.length > 0 ? <DomainsRefreshButton /> : null}
          <RailButton
            label="Connect Cloudflare"
            onClick={() => onOpenConnection(null)}
          >
            <Plus />
          </RailButton>
        </div>
      }
      className="xl:flex xl:min-h-0 xl:flex-1 xl:flex-col"
      icon={<Zap />}
      sections={
        domains.length > 0 ? (
          <div className="max-h-[calc(8.5*2.5rem)] overflow-y-auto xl:max-h-none xl:min-h-0 xl:flex-1">
            <table
              aria-label="Automatic DNS domains"
              className="w-full table-fixed"
            >
              <thead>
                <tr className="border-b border-border/60">
                  <th className="type-technical-label px-3 py-2 text-left font-normal text-muted-foreground">
                    Domain
                  </th>
                </tr>
              </thead>
              <tbody>
                {domains.map((domain) => (
                  <RailDomainRow
                    key={domain.key}
                    domain={domain}
                    onOpen={onOpenConnection}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : null
      }
      title={
        <span className="flex items-center gap-1.5">
          Automatic DNS
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="About Automatic DNS"
                className="inline-flex text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
                type="button"
              >
                <Info className="text-current" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Kiln can set up and manage DNS records via Cloudflare
            </TooltipContent>
          </Tooltip>
        </span>
      }
    >
      {domains.length === 0 ? (
        <p className="type-meta py-2 text-muted-foreground">
          Connect Cloudflare to get started.
        </p>
      ) : null}
    </InfoRailCard>
  )
})

function RailButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          size="icon-sm"
          type="button"
          variant="outline"
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * A domain, as `<vanity>.domain` when new names go under it, with an icon on
 * the right when something limits it.
 */
const RailDomainRow = React.memo(function RailDomainRow({
  domain,
  onOpen,
}: {
  domain: RailDomain
  onOpen: (connection: DomainConnectionOverview) => void
}) {
  const content = (
    <>
      <span
        className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]"
        title={domain.vanity ? `<vanity>.${domain.name}` : domain.name}
      >
        {/* Names are made under a vanity domain; the prefix says so. */}
        {domain.vanity ? (
          <span className="text-muted-foreground">&lt;vanity&gt;.</span>
        ) : null}
        {domain.name}
      </span>
      {domain.error ? (
        <RailIcon tooltip={domain.error}>
          <CircleAlert className="size-3.5 text-destructive" />
        </RailIcon>
      ) : null}
      {domain.vanity ? (
        <RailIcon
          tooltip={`Vanity domain: new game servers and apps get an address like amber-forge.${domain.name}`}
        >
          <Info className="size-3.5 text-muted-foreground" />
        </RailIcon>
      ) : null}
      {domain.shared && domain.vanity ? (
        <RailIcon tooltip="Kiln provided">
          <HearthMark className="size-3.5" />
        </RailIcon>
      ) : null}
    </>
  )
  const className =
    "flex h-10 w-full items-center gap-2 px-3 text-left outline-none"
  const { connection } = domain
  return (
    <tr className="border-b border-border/60 last:border-b-0">
      <td className="p-0">
        {connection ? (
          <button
            aria-label={`Edit ${domain.name}`}
            className={`${className} hover:bg-muted/60 focus-visible:bg-muted/60`}
            type="button"
            onClick={() => onOpen(connection)}
          >
            {content}
          </button>
        ) : (
          <div className={className}>{content}</div>
        )}
      </td>
    </tr>
  )
})

function RailIcon({
  children,
  tooltip,
}: {
  children: React.ReactNode
  tooltip: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span aria-label={tooltip} className="inline-flex shrink-0" role="img">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="left">{tooltip}</TooltipContent>
    </Tooltip>
  )
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

const DomainsToolbar = React.memo(function DomainsToolbar({
  filter,
  onFilterChange,
  scopeTarget,
  searchStore,
}: {
  filter: DomainFilter
  onFilterChange: (filter: DomainFilter) => void
  scopeTarget: ScopeOption | null
  searchStore: DataTableSearchStore
}) {
  return (
    <DataTableToolbar
      actions={
        scopeTarget ? <ManageDomainsButton target={scopeTarget} /> : undefined
      }
      controls={<DomainFilterMenu value={filter} onChange={onFilterChange} />}
      leading={<DomainSyncButton />}
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

/** Domains are added where they're used: the instance's network page. */
function ManageDomainsButton({ target }: { target: ScopeOption }) {
  const content = (
    <>
      <Settings2 />
      <span className="hidden sm:inline">Manage domains</span>
    </>
  )
  return (
    <Button asChild aria-label={`Manage ${target.name}'s domains`}>
      {target.kind === "app" ? (
        <Link
          to="/app/$appId/network"
          params={{ appId: target.routeId }}
          preload="intent"
        >
          {content}
        </Link>
      ) : (
        <Link
          to="/server/$serverId/network"
          params={{ serverId: target.routeId }}
          preload="intent"
        >
          {content}
        </Link>
      )}
    </Button>
  )
}

const DomainFilterMenu = React.memo(function DomainFilterMenu({
  onChange,
  value,
}: {
  onChange: (filter: DomainFilter) => void
  value: DomainFilter
}) {
  const filtered = value.kind !== "all" || value.dns !== "all"
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Filter domains"
              className="relative shrink-0"
              type="button"
              variant={filtered ? "secondary" : "outline"}
            >
              <SlidersHorizontal />
              {filtered ? (
                <span
                  aria-hidden
                  className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
                />
              ) : null}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Filter</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Show</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value.kind}
          onValueChange={(kind) =>
            onChange({ ...value, kind: kind as DomainFilter["kind"] })
          }
        >
          {domainKindFilters.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>DNS</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value.dns}
          onValueChange={(dns) =>
            onChange({ ...value, dns: dns as DomainFilter["dns"] })
          }
        >
          {domainDnsFilters.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

const DomainSyncButton = React.memo(function DomainSyncButton() {
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
    const synced = result.syncedServerCount + result.syncedHostnameCount
    showToast({
      message: `Synced ${synced} ${synced === 1 ? "domain" : "domains"}`,
      type: "success",
    })
  }, [queryClient])

  return (
    <InfraSyncButton
      label="Sync DNS records"
      sync={sync}
      onError={showErrorToast}
    />
  )
})

const DomainsTable = React.memo(function DomainsTable({
  onDialog,
  rows: domainRows,
  searchStore,
}: {
  onDialog: (dialog: DomainDialog) => void
  rows: Array<DomainRow>
  searchStore: DataTableSearchStore
}) {
  // The server sorts by domain, so a rename or delete shifts later rows.
  // Match rows by ID instead of position, so only changed rows repaint.
  const [rowCache] = React.useState(
    () => new Map<string, { json: string; row: DomainRow }>()
  )
  const source = React.useMemo<DataTableSource<DomainRow>>(() => {
    const seen = new Set<string>()
    const rows = domainRows.map((row) => {
      const json = JSON.stringify(row)
      seen.add(row.id)
      const cached = rowCache.get(row.id)
      if (cached?.json === json) return cached.row
      rowCache.set(row.id, { json, row })
      return row
    })
    for (const key of rowCache.keys()) {
      if (!seen.has(key)) rowCache.delete(key)
    }
    return { body: { kind: "ready" }, refreshing: false, rows }
  }, [domainRows, rowCache])
  const [initialTableState] = React.useState(() => ({
    sorting: [{ desc: false, id: "domain" }],
  }))
  const definition = React.useMemo(() => {
    const columns = domainTableColumnHelper.columns([
      domainTableColumnHelper.accessor((row) => rowStatus(row).label, {
        id: "status",
        header: () => <span className="sr-only sm:not-sr-only">Status</span>,
        sortFn: "text",
        cell: ({ row }) => <StatusIndicator status={rowStatus(row.original)} />,
        meta: dataTableColumnMeta(
          { width: { base: "2.5rem", sm: statusColumnWidth } },
          {
            cellClassName: "px-2 sm:px-3",
            headerClassName: "px-2 sm:px-3",
            headerLabelClassName: "shrink-0 overflow-visible text-clip",
          }
        ),
      }),
      domainTableColumnHelper.accessor(
        (row) =>
          row.kind === "server"
            ? row.domain.server.name
            : row.hostname.resource.name,
        {
          id: "instance",
          header: "Instance",
          sortFn: "text",
          cell: ({ row }) =>
            row.original.kind === "server" ? (
              <DomainServerCell domain={row.original.domain} />
            ) : (
              <HostnameResourceCell hostname={row.original.hostname} />
            ),
          meta: dataTableColumnMeta(
            {
              // Phones keep the domain, which this table is about.
              hideBelow: "sm",
              // Keep the name readable; leave the rest to domains.
              width: "clamp(9rem,11vw,15rem)",
            },
            { cellClassName: "px-0" }
          ),
        }
      ),
      domainTableColumnHelper.accessor((row) => rowHostname(row), {
        id: "domain",
        header: "Domain",
        sortFn: "text",
        cell: ({ row }) => (
          <div className="type-meta flex w-full min-w-0">
            <WorkspaceCopyValueButton
              label="domain"
              value={rowHostname(row.original)}
            />
          </div>
        ),
        meta: dataTableColumnMeta({ width: "minmax(0,1.4fr)" }),
      }),
      domainTableColumnHelper.accessor(
        (row) => (row.kind === "server" ? row.domain.port : -1),
        {
          id: "port",
          header: "Port",
          sortFn: (left, right) =>
            portOf(left.original) - portOf(right.original),
          // A web route has neither; its cell stays empty.
          cell: ({ row }) =>
            row.original.kind === "server" ? (
              <PortCell domain={row.original.domain} />
            ) : null,
          meta: dataTableColumnMeta({ hideBelow: "sm", width: "6rem" }),
        }
      ),
      domainTableColumnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <DomainRowActions row={row.original} onDialog={onDialog} />
        ),
        meta: dataTableColumnMeta(
          { width: "6.5rem" },
          { cellClassName: "px-1 sm:px-2", headerClassName: "px-1 sm:px-2" }
        ),
      }),
    ])
    return defineDataTable({
      ariaLabel: "Domains",
      columns,
      getRowId: (row) => row.id,
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

function rowHostname(row: DomainRow): string {
  return row.kind === "server"
    ? domainHostname(row.domain)
    : row.hostname.hostname
}

function portOf(row: DomainRow): number {
  return row.kind === "server" ? row.domain.port : -1
}

function rowStatus(row: DomainRow): IdentityStatusPresentation {
  return row.kind === "server"
    ? domainStatusPresentation(row.domain)
    : hostnameStatusPresentation(row.hostname)
}

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

/** The game server's port, with whether its SRV record lets players skip it. */
function PortCell({ domain }: { domain: ManagedDomainOverview }) {
  return (
    <div className="flex min-w-0 flex-col items-start">
      <InfoCopyValue label="port" value={String(domain.port)} />
      {domain.srvActive ? (
        <span className="type-meta inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
          <Check aria-hidden className="size-3" />
          SRV
        </span>
      ) : domain.supportsSrv ? (
        <span className="type-meta text-muted-foreground">No SRV</span>
      ) : null}
    </div>
  )
}

const HostnameResourceCell = React.memo(function HostnameResourceCell({
  hostname,
}: {
  hostname: WebHostnameOverview
}) {
  const { resource } = hostname
  const card = (
    <InstanceCard
      className="min-w-0 flex-1"
      instance={
        resource.kind === "app"
          ? { id: resource.id, kind: "app", relayId: hostname.relayId }
          : {
              brickId: resource.brickId,
              id: resource.id,
              implementation: resource.implementation,
              kind: "server",
              relayId: hostname.relayId,
            }
      }
      meta={hostname.relayName}
      name={resource.name}
      nameClassName="transition-colors group-hover/server-link:text-primary-ink"
      showFavorite={false}
      showStatus={false}
    />
  )
  const className =
    "group/server-link flex min-h-14 w-full min-w-0 items-center px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
  return resource.kind === "app" ? (
    <Link
      to="/app/$appId/network"
      params={{ appId: resource.routeId }}
      preload="intent"
      className={className}
    >
      {card}
    </Link>
  ) : (
    <Link
      to="/server/$serverId/network"
      params={{ serverId: resource.routeId }}
      preload="intent"
      className={className}
    >
      {card}
    </Link>
  )
})

/**
 * The same three actions on every row, so they line up. One the person
 * can't take stays visible, disabled, with the reason as its tooltip.
 */
const DomainRowActions = React.memo(function DomainRowActions({
  onDialog,
  row,
}: {
  onDialog: (dialog: DomainDialog) => void
  row: DomainRow
}) {
  const hostname = rowHostname(row)
  const zoneName =
    row.kind === "server" ? row.domain.zoneName : row.hostname.zoneName
  return (
    <DataTableActionGroup>
      {row.kind === "server" ? (
        <RowActionButton
          disabledReason={
            !row.domain.canManage
              ? "Needs network access to this game server"
              : row.domain.status === "removing"
                ? "Being deleted"
                : null
          }
          label={`Edit ${hostname}`}
          tooltip="Edit"
          onClick={() => onDialog({ domain: row.domain, kind: "edit" })}
        >
          <Pencil />
        </RowActionButton>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              className="text-muted-foreground hover:text-primary-ink"
              size="icon-sm"
              variant="ghost"
            >
              <ResourceNetworkLink
                aria-label={`Edit web routes for ${hostname}`}
                hostname={row.hostname}
              >
                <Pencil />
              </ResourceNetworkLink>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Edit web routes</TooltipContent>
        </Tooltip>
      )}
      <RowActionButton
        destructive
        disabledReason={deleteDisabledReason(row)}
        label={`Delete ${hostname}`}
        tooltip="Delete"
        onClick={() =>
          onDialog(
            row.kind === "server"
              ? { domain: row.domain, kind: "delete" }
              : { hostname: row.hostname, kind: "release" }
          )
        }
      >
        <Trash2 />
      </RowActionButton>
      {zoneName ? (
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
                href={cloudflareDnsRecordsUrl(zoneName)}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">View on Cloudflare</TooltipContent>
        </Tooltip>
      ) : (
        <span aria-hidden className="size-8 shrink-0" />
      )}
    </DataTableActionGroup>
  )
})

function deleteDisabledReason(row: DomainRow): string | null {
  if (row.kind === "server") {
    return row.domain.canManage
      ? null
      : "Needs network access to this game server"
  }
  // A route's record follows the route; deleting it alone would come back.
  if (!row.hostname.generated || row.hostname.routed) {
    return "Remove its web route to delete it"
  }
  return row.hostname.canManage ? null : "Needs access to manage this app"
}

function RowActionButton({
  children,
  destructive = false,
  disabledReason,
  label,
  onClick,
  tooltip,
}: {
  children: React.ReactNode
  destructive?: boolean
  disabledReason: string | null
  label: string
  onClick: () => void
  tooltip: string
}) {
  const disabled = disabledReason !== null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button shows no tooltip; its wrapper does. */}
        <span className="inline-flex" tabIndex={disabled ? 0 : undefined}>
          <Button
            aria-label={label}
            className={
              destructive
                ? "text-destructive hover:bg-destructive/10 hover:text-destructive light:hover:bg-destructive/20"
                : "text-muted-foreground hover:text-primary-ink"
            }
            disabled={disabled}
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={onClick}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{disabledReason ?? tooltip}</TooltipContent>
    </Tooltip>
  )
}

function ResourceNetworkLink({
  children,
  hostname,
  ...props
}: Omit<React.ComponentProps<"a">, "href"> & {
  hostname: WebHostnameOverview
}) {
  const { resource } = hostname
  return resource.kind === "app" ? (
    <Link
      {...props}
      to="/app/$appId/network"
      params={{ appId: resource.routeId }}
      preload="intent"
    >
      {children}
    </Link>
  ) : (
    <Link
      {...props}
      to="/server/$serverId/network"
      params={{ serverId: resource.routeId }}
      preload="intent"
    >
      {children}
    </Link>
  )
}

function renderEmptyDomains({ searchActive }: { searchActive: boolean }) {
  return (
    <DataTableEmptyState
      description={
        <span className="block max-w-sm">
          {searchActive
            ? "Try a domain, game server, app, Relay, or status."
            : "Game server addresses and web routes show here."}
        </span>
      }
      icon={
        <Globe2 className="size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
      }
      title={searchActive ? "No domains match your search" : "No Domains Yet"}
    />
  )
}

function hostnameStatusPresentation(
  hostname: WebHostnameOverview
): IdentityStatusPresentation {
  if (hostname.status === "active") return { label: "Active", tone: "success" }
  if (hostname.status === "pending") {
    return { label: "Pending", pulse: true, tone: "warning" }
  }
  if (hostname.status === "manual") {
    return {
      detail: "Not on a domain Kiln manages. Point it at the Relay yourself.",
      label: "Manual DNS",
      tone: "neutral",
    }
  }
  if (hostname.status === "external") {
    return {
      detail: hostname.lastError ?? undefined,
      label: "Existing record",
      tone: "warning",
    }
  }
  if (hostname.status === "removing") {
    return hostname.lastError
      ? { detail: hostname.lastError, label: "Delete failed", tone: "danger" }
      : { label: "Deleting", pulse: true, tone: "warning" }
  }
  return {
    detail: hostname.lastError ?? undefined,
    label: "Error",
    tone: "danger",
  }
}
