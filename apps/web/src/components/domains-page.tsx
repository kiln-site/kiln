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
  KeyRound,
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
  type DomainConnectionOverview,
  type DomainSettings,
  type VanityDomainChoice,
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
import {
  domainSettingsQueryOptions,
  queryKeys,
  serverDirectoryQueryOptions,
} from "@/lib/query-options"
import {
  resyncDomainAssignments,
  type ManagedDomainOverview,
  type WebHostnameOverview,
} from "@/server/domains"

type DomainDialog =
  | { connection: DomainConnectionOverview | null; kind: "connection" }
  | { kind: "create" }
  | { kind: "delete"; domain: ManagedDomainOverview }
  | { kind: "edit"; domain: ManagedDomainOverview }
  | { hostname: WebHostnameOverview; kind: "release" }
  | { kind: "vanity" }
  | null

/** Which table shows: game servers' vanity addresses, or web hostnames. */
type DomainView = "servers" | "web"

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
const DomainConnectionDialog = React.lazy(async () => ({
  default: (await loadDomainDialogs()).DomainConnectionDialog,
}))
const ReleaseHostnameDialog = React.lazy(async () => ({
  default: (await loadDomainDialogs()).ReleaseHostnameDialog,
}))
const VanitySettingsDialog = React.lazy(async () => ({
  default: (await loadDomainDialogs()).VanitySettingsDialog,
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
  const scopedHostnames = React.useMemo(
    () =>
      scope
        ? data.webHostnames.filter(
            (hostname) =>
              hostname.resource.id === scope.instanceId &&
              (!scope.relayId || hostname.relayId === scope.relayId)
          )
        : data.webHostnames,
    [data.webHostnames, scope]
  )
  const [view, setView] = React.useState<DomainView>("servers")
  const openCreate = React.useCallback(() => setDialog({ kind: "create" }), [])
  const openVanity = React.useCallback(() => setDialog({ kind: "vanity" }), [])
  const openConnection = React.useCallback(
    (connection: DomainConnectionOverview | null) =>
      setDialog({ connection, kind: "connection" }),
    []
  )
  const closeDialog = React.useCallback((open: boolean) => {
    if (!open) setDialog(null)
  }, [])
  const vanityDomains = React.useMemo(
    () => vanityDomainChoices(data),
    [data]
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
        <>
          <CloudflareRail
            connections={data.connections}
            onOpen={openConnection}
          />
          <VanityRail
            settings={data}
            vanityDomains={vanityDomains}
            onConfigure={openVanity}
          />
        </>
      }
      summary={<DomainScopePicker scope={scope} onSelect={selectScope} />}
    >
      <DataTableWorkspace
        toolbar={
          <DomainsToolbar
            canCreate={view === "servers" && vanityDomains.length > 0}
            counts={{
              servers: scopedDomains.length,
              web: scopedHostnames.length,
            }}
            searchStore={searchStore}
            view={view}
            onCreate={openCreate}
            onViewChange={setView}
          />
        }
      >
        {view === "servers" ? (
          <ManagedDomainsTable
            domains={scopedDomains}
            searchStore={searchStore}
            onDialog={setDialog}
          />
        ) : (
          <WebHostnamesTable
            hostnames={scopedHostnames}
            searchStore={searchStore}
            onDialog={setDialog}
          />
        )}
      </DataTableWorkspace>

      <React.Suspense fallback={null}>
        {dialog?.kind === "connection" ? (
          <DomainConnectionDialog
            key={dialog.connection?.id ?? "new"}
            canManagePlatform={data.canManagePlatform}
            connection={dialog.connection}
            domainUsage={domainUsage}
            hearthDomain={data.hearthDomain}
            onOpenChange={closeDialog}
          />
        ) : null}
        {dialog?.kind === "vanity" ? (
          <VanitySettingsDialog
            platformSettings={data.settings.platform}
            personalSettings={data.settings.personal}
            onOpenChange={closeDialog}
          />
        ) : null}
        {dialog?.kind === "create" ? (
          <CreateDomainDialog
            domains={vanityDomains}
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

/**
 * The vanity domains the person may put addresses under: their own, then the
 * platform's. An administrator's platform connections count as the
 * platform's.
 */
function vanityDomainChoices(data: DomainSettings): Array<VanityDomainChoice> {
  const choices = new Map<string, VanityDomainChoice>()
  for (const connection of data.connections) {
    if (connection.platform) continue
    for (const domain of connection.domains) {
      if (domain.enabled) {
        choices.set(domain.domain, { domain: domain.domain, platform: false })
      }
    }
  }
  for (const domain of data.platformDomains) {
    if (!choices.has(domain.domain)) {
      choices.set(domain.domain, { domain: domain.domain, platform: true })
    }
  }
  return [...choices.values()]
}

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

/** The person's Cloudflare connections, and the platform's for admins. */
const CloudflareRail = React.memo(function CloudflareRail({
  connections,
  onOpen,
}: {
  connections: DomainSettings["connections"]
  onOpen: (connection: DomainConnectionOverview | null) => void
}) {
  return (
    <InfoRailCard
      action={
        <div className="flex items-center gap-1.5">
          {connections.length > 0 ? <DomainsRefreshButton /> : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Connect Cloudflare"
                size="icon-sm"
                type="button"
                variant="outline"
                onClick={() => onOpen(null)}
              >
                <Plus />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Connect Cloudflare
            </TooltipContent>
          </Tooltip>
        </div>
      }
      className="xl:flex-none"
      icon={<KeyRound />}
      sections={
        connections.length > 0 ? (
          <InfoRailCardSection
            action={
              <span className="type-meta text-muted-foreground tabular-nums">
                {connections.length}
              </span>
            }
            contentClassName="max-h-[calc(4.5*3rem)] overflow-y-auto"
            title="Connections"
          >
            <ul aria-label="Cloudflare connections">
              {connections.map((connection) => (
                <li
                  key={connection.id}
                  className="relative after:absolute after:inset-x-[7.5%] after:bottom-0 after:h-px after:bg-border/60 last:after:hidden"
                >
                  <button
                    aria-label={`Edit ${connection.name}`}
                    className="group flex h-12 w-full items-center gap-2 px-2 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
                    type="button"
                    onClick={() => onOpen(connection)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5 text-[0.8125rem]">
                        <span className="truncate">{connection.name}</span>
                        {connection.platform ? (
                          <span className="type-technical-label shrink-0 border border-border/70 px-1 text-muted-foreground">
                            Everyone
                          </span>
                        ) : null}
                      </span>
                      <span className="type-meta block truncate text-muted-foreground">
                        {connectionSummary(connection)}
                      </span>
                    </span>
                    {connection.lastError ? (
                      <CircleAlert
                        aria-label={connection.lastError}
                        className="size-3.5 shrink-0 text-destructive"
                      />
                    ) : null}
                    <Pencil className="size-3 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-primary-ink group-focus-visible:text-primary-ink" />
                  </button>
                </li>
              ))}
            </ul>
          </InfoRailCardSection>
        ) : null
      }
      title="Cloudflare"
    >
      {connections.length === 0 ? (
        <p className="type-meta py-2 text-muted-foreground">
          Connect a Cloudflare API token and Kiln creates DNS records for web
          routes in its zones, and addresses for new game servers and apps
          under the domains you choose.
        </p>
      ) : (
        <InfoFact label="Zones">
          <span className="tabular-nums">
            {new Set(
              connections.flatMap((connection) =>
                connection.zones.map((zone) => zone.id)
              )
            ).size}
          </span>
        </InfoFact>
      )}
    </InfoRailCard>
  )
})

function connectionSummary(connection: DomainConnectionOverview): string {
  const zones = connection.zones.length
  const vanity = connection.domains.filter((domain) => domain.enabled).length
  return [
    `${zones} ${zones === 1 ? "zone" : "zones"}`,
    vanity > 0 ? `${vanity} vanity` : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

/**
 * How new game servers and apps get addresses: under the person's own vanity
 * domains when they have any, otherwise the platform's.
 */
const VanityRail = React.memo(function VanityRail({
  onConfigure,
  settings,
  vanityDomains,
}: {
  onConfigure: () => void
  settings: Pick<DomainSettings, "connections" | "platformDomains" | "settings">
  vanityDomains: ReadonlyArray<VanityDomainChoice>
}) {
  const own = vanityDomains.filter((domain) => !domain.platform)
  const applied = own.length > 0 ? settings.settings.personal : null
  const strategy = strategyOptions.find(
    (option) => option.value === applied?.strategy
  )
  const ownDefault = settings.connections
    .filter((connection) => !connection.platform)
    .flatMap((connection) => connection.domains)
    .find((domain) => domain.isDefault && domain.enabled)?.domain
  const platformDefault =
    settings.platformDomains.find((domain) => domain.isDefault)?.domain ??
    settings.platformDomains[0]?.domain
  return (
    <InfoRailCard
      action={
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
      }
      // The domain list fills what's left of the rail.
      className="xl:flex xl:min-h-0 xl:flex-1 xl:flex-col"
      icon={<Globe2 />}
      sections={
        vanityDomains.length > 0 ? (
          <VanityDomainList domains={vanityDomains} />
        ) : null
      }
      title="Vanity"
    >
      {vanityDomains.length === 0 ? (
        <InfoFact label="New addresses">
          <span className="text-muted-foreground">No vanity domains</span>
        </InfoFact>
      ) : applied ? (
        <>
          <InfoFact label="New addresses">
            {applied.autoAssign
              ? `Yours · ${strategy?.label ?? "Default only"}`
              : "Off"}
          </InfoFact>
          {ownDefault ? (
            <InfoFact label="Default">
              <span className="truncate font-mono">{ownDefault}</span>
            </InfoFact>
          ) : null}
        </>
      ) : (
        <>
          <InfoFact label="New addresses">Kiln&apos;s domains</InfoFact>
          {platformDefault ? (
            <InfoFact label="Default">
              <span className="truncate font-mono">{platformDefault}</span>
            </InfoFact>
          ) : null}
        </>
      )}
    </InfoRailCard>
  )
})

/**
 * The vanity domains the person may use. Beside the table it fills the
 * rail; stacked below it, it shows seven and a half rows so the cut-off row
 * says the list scrolls.
 */
function VanityDomainList({
  domains,
}: {
  domains: ReadonlyArray<VanityDomainChoice>
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
            className="relative flex h-9 items-center gap-2 px-2 font-mono text-[0.8125rem] after:absolute after:inset-x-[7.5%] after:bottom-0 after:h-px after:bg-border/60 last:after:hidden"
          >
            <span className="min-w-0 flex-1 truncate">{domain.domain}</span>
            {domain.platform ? (
              <span className="type-technical-label shrink-0 font-sans text-muted-foreground">
                Kiln
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </InfoRailCardSection>
  )
}

const DomainsToolbar = React.memo(function DomainsToolbar({
  canCreate,
  counts,
  onCreate,
  onViewChange,
  searchStore,
  view,
}: {
  canCreate: boolean
  counts: Record<DomainView, number>
  onCreate: () => void
  onViewChange: (view: DomainView) => void
  searchStore: DataTableSearchStore
  view: DomainView
}) {
  return (
    <DataTableToolbar
      actions={
        view === "servers" ? (
          <Button
            aria-label="New domain"
            disabled={!canCreate}
            type="button"
            onClick={onCreate}
          >
            <Plus />
            <span className="hidden sm:inline">New domain</span>
          </Button>
        ) : null
      }
      leading={
        <div className="flex items-center gap-2">
          <DomainSyncButton />
          <div
            aria-label="Domains to show"
            className="flex h-8 items-center border border-border/75 bg-background/35 p-0.5"
            role="radiogroup"
          >
            {domainViews.map((option) => (
              <button
                key={option.value}
                aria-checked={view === option.value}
                className="type-control-sm flex h-full items-center gap-1.5 px-2.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 aria-checked:bg-muted aria-checked:text-foreground"
                role="radio"
                type="button"
                onClick={() => onViewChange(option.value)}
              >
                <span className="hidden 2xl:inline">{option.label}</span>
                <span className="2xl:hidden">{option.short}</span>
                <span className="type-meta tabular-nums text-muted-foreground">
                  {counts[option.value]}
                </span>
              </button>
            ))}
          </div>
        </div>
      }
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

const domainViews: ReadonlyArray<{
  label: string
  short: string
  value: DomainView
}> = [
  { label: "Game servers", short: "Servers", value: "servers" },
  { label: "Web hostnames", short: "Web", value: "web" },
]

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
      message: `Synced ${synced} ${synced === 1 ? "address" : "addresses"}`,
      type: "success",
    })
  }, [queryClient])

  return (
    <InfraSyncButton
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
            disabled={!domain.canManage || domain.status === "removing"}
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
            disabled={!domain.canManage}
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

const webHostnameColumnHelper =
  createDataTableColumnHelper<WebHostnameOverview>()
const webHostnameSearchFields = [
  (row: WebHostnameOverview) => row.hostname,
  (row: WebHostnameOverview) => row.resource.name,
  (row: WebHostnameOverview) => row.resource.id,
  (row: WebHostnameOverview) => row.relayName,
  (row: WebHostnameOverview) => row.target,
  (row: WebHostnameOverview) => row.connectionName,
  (row: WebHostnameOverview) => row.status,
] as const

/** Web route hostnames and generated app addresses whose records Kiln keeps. */
const WebHostnamesTable = React.memo(function WebHostnamesTable({
  hostnames,
  onDialog,
  searchStore,
}: {
  hostnames: Array<WebHostnameOverview>
  onDialog: (dialog: DomainDialog) => void
  searchStore: DataTableSearchStore
}) {
  // Match rows by ID instead of position, so only changed rows repaint.
  const [rowCache] = React.useState(
    () => new Map<string, { json: string; row: WebHostnameOverview }>()
  )
  const source = React.useMemo<DataTableSource<WebHostnameOverview>>(() => {
    const seen = new Set<string>()
    const rows = hostnames.map((hostname) => {
      const json = JSON.stringify(hostname)
      seen.add(hostname.id)
      const cached = rowCache.get(hostname.id)
      if (cached?.json === json) return cached.row
      rowCache.set(hostname.id, { json, row: hostname })
      return hostname
    })
    for (const key of rowCache.keys()) {
      if (!seen.has(key)) rowCache.delete(key)
    }
    return { body: { kind: "ready" }, refreshing: false, rows }
  }, [hostnames, rowCache])
  const [initialTableState] = React.useState(() => ({
    sorting: [{ desc: false, id: "hostname" }],
  }))
  const definition = React.useMemo(() => {
    const columns = webHostnameColumnHelper.columns([
      webHostnameColumnHelper.accessor((row) => row.status, {
        id: "status",
        header: () => <span className="sr-only sm:not-sr-only">Status</span>,
        sortFn: "text",
        cell: ({ row }) => (
          <StatusIndicator status={hostnameStatusPresentation(row.original)} />
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
      webHostnameColumnHelper.accessor((row) => row.resource.name, {
        id: "instance",
        header: "Instance",
        sortFn: "text",
        cell: ({ row }) => <HostnameResourceCell hostname={row.original} />,
        meta: dataTableColumnMeta(
          { hideBelow: "sm", width: "clamp(13rem,18vw,15rem)" },
          { cellClassName: "px-0" }
        ),
      }),
      webHostnameColumnHelper.accessor((row) => row.hostname, {
        id: "hostname",
        header: "Hostname",
        sortFn: "text",
        cell: ({ row }) => (
          <div className="type-meta flex w-full min-w-0 flex-col items-start">
            <WorkspaceCopyValueButton
              label="hostname"
              value={row.original.hostname}
            />
            <span className="type-meta max-w-full truncate text-muted-foreground">
              {[
                row.original.generated ? "Kiln address" : null,
                row.original.target ? `→ ${row.original.target}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        ),
        meta: dataTableColumnMeta({ width: "minmax(0,1.6fr)" }),
      }),
      webHostnameColumnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <HostnameActions hostname={row.original} onDialog={onDialog} />
        ),
        meta: dataTableColumnMeta(
          { width: "6.5rem" },
          { cellClassName: "px-1 sm:px-2", headerClassName: "px-1 sm:px-2" }
        ),
      }),
    ])
    return defineDataTable({
      ariaLabel: "Web hostnames",
      columns,
      getRowId: (row) => row.id,
      model: { initialState: initialTableState },
      search: { fields: webHostnameSearchFields },
      virtualization: true,
    })
  }, [initialTableState, onDialog])

  return (
    <DataTable
      definition={definition}
      emptyState={renderEmptyHostnames}
      searchStore={searchStore}
      source={source}
    />
  )
})

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

const HostnameActions = React.memo(function HostnameActions({
  hostname,
  onDialog,
}: {
  hostname: WebHostnameOverview
  onDialog: (dialog: DomainDialog) => void
}) {
  return (
    <DataTableActionGroup>
      {hostname.generated ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={`Release ${hostname.hostname}`}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive light:hover:bg-destructive/20"
              disabled={!hostname.canManage}
              size="icon-sm"
              type="button"
              variant="ghost"
              onClick={() => onDialog({ hostname, kind: "release" })}
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Release</TooltipContent>
        </Tooltip>
      ) : null}
      {hostname.zoneName ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              className="text-muted-foreground hover:text-primary-ink"
              size="icon-sm"
              variant="ghost"
            >
              <a
                aria-label={`View ${hostname.hostname} on Cloudflare`}
                href={cloudflareDnsRecordsUrl(hostname.zoneName)}
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

function renderEmptyHostnames({ searchActive }: { searchActive: boolean }) {
  return (
    <DataTableEmptyState
      description={
        <span className="block max-w-sm">
          {searchActive
            ? "Try a hostname, game server, app, Relay, or status."
            : "Add a web route whose hostname is in a connected Cloudflare zone, or under a vanity domain, and Kiln keeps its DNS record pointed at the Relay."}
        </span>
      }
      icon={
        <Globe2 className="size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
      }
      title={searchActive ? "No hostnames match your search" : "No Web Hostnames"}
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

function renderEmptyDomains({ searchActive }: { searchActive: boolean }) {
  return (
    <DataTableEmptyState
      description={
        <span className="block max-w-sm">
          {searchActive
            ? "Try a vanity address, game server, Relay, port, status, or ID."
            : "Create a domain for a game server, or add a vanity domain so new game servers get one."}
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
