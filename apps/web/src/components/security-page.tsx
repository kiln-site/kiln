import * as React from "react"
import { Link } from "@tanstack/react-router"
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import {
  EllipsisVertical,
  ExternalLink,
  ListFilter,
  LoaderCircle,
  ScanSearch,
  ShieldCheck,
  Siren,
  Wrench,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import {
  DataTableActionGroup,
  DataTableEmptyState,
  DataTableInlineActions,
  DataTablePhoneMenuItems,
  dataTableRowLinkClassName,
  dataTableRowMenuTriggerClassName,
} from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import { CopyIdentifierMenuItem } from "@/components/copy-identifier-menu-item"
import { InfraSyncButton } from "@/components/infra-sync-button"
import { InstanceCard } from "@/components/instance-card"
import { RelativeTime } from "@/components/relative-time"
import { SeverityBadge, severityTone } from "@/components/security-severity"
import {
  ServerScopePicker,
  type ServerPickerOption,
} from "@/components/server-scope-picker"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import { createDataTableSearchStore } from "@/lib/data-table-search"
import type { DataTableSource } from "@/lib/data-table-source"
import {
  securitySeverities,
  securitySeverityLabels,
  severityRank,
  type SecuritySeverity,
  type SecurityFindingSummary,
  type SecurityOverview,
  type SecurityResource,
  type SecurityScopeKind,
  type SecurityTarget,
} from "@/lib/security"
import {
  securityOverviewQueryOptions,
  securityQueryKeys,
} from "@/lib/security-queries"
import { scanSecurityNow } from "@/server/security"

type Target = SecurityOverview["targets"][number]

/**
 * What Kiln knows is vulnerable in the software it runs: each Relay's host,
 * Kiln's services, and every game server, database, and app image, checked
 * against Grype's vulnerability data whenever it changes.
 */
export const SecurityPage = React.memo(function SecurityPage({
  onScopeChange,
  scope,
}: {
  onScopeChange: (scope: string | null) => void
  scope: string | null
}) {
  // The whole view names every resource the picker offers.
  const { data: everything } = useSuspenseQuery(
    securityOverviewQueryOptions(null)
  )
  const { data: scoped } = useQuery({
    ...securityOverviewQueryOptions(scope ?? ""),
    enabled: scope !== null,
    placeholderData: keepPreviousData,
  })
  const overview = scope === null ? everything : (scoped ?? everything)
  const resources = React.useMemo(
    () =>
      new Map(
        everything.resources.map((resource) => [resource.scope, resource])
      ),
    [everything.resources]
  )

  // Laid out as an Info page: the vulnerabilities, and a rail of what's
  // checked. Wide, both fill the page and their tables scroll; narrower,
  // the rail stacks below and the page scrolls.
  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-card xl:overflow-hidden">
      <div className="grid min-h-full xl:h-full xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="flex min-h-0 min-w-0 flex-col gap-4 px-5 py-6 sm:px-7">
          <SecurityScopePicker
            resources={everything.resources}
            scannable={everything.scannable}
            scope={scope}
            onScopeChange={onScopeChange}
          />
          {overview.targets.length === 0 ? (
            <NothingChecked />
          ) : (
            <>
              <SecuritySummary overview={overview} />
              <FindingsSection
                overview={overview}
                resources={resources}
                scope={scope}
              />
            </>
          )}
        </div>
        <aside className="flex min-h-0 min-w-0 flex-col border-t bg-background/30 px-4 py-6 xl:border-t-0 xl:border-l">
          <TargetsRail
            overview={overview}
            resources={resources}
            scannable={everything.scannable}
            scope={scope}
          />
        </aside>
      </div>
    </section>
  )
})

const scopeKinds: ReadonlyArray<SecurityScopeKind> = [
  "relay",
  "server",
  "database",
  "app",
]

const SecurityScopePicker = React.memo(function SecurityScopePicker({
  onScopeChange,
  resources,
  scannable,
  scope,
}: {
  onScopeChange: (scope: string | null) => void
  resources: ReadonlyArray<SecurityResource>
  scannable: ReadonlyArray<string>
  scope: string | null
}) {
  const options = React.useMemo(
    () =>
      [...resources]
        .sort(
          (a, b) =>
            scopeKinds.indexOf(a.kind) - scopeKinds.indexOf(b.kind) ||
            a.name.localeCompare(b.name)
        )
        .map((resource): ServerPickerOption<SecurityScopeKind> => ({
          id: resource.id,
          kind: resource.kind,
          name: resource.name,
          relayId: resource.relayId,
          relayName: resource.relayName,
        })),
    [resources]
  )
  const selected =
    options.find(
      (option) => `${option.kind}:${option.relayId}:${option.id}` === scope
    ) ?? null
  const select = React.useCallback(
    (option: ServerPickerOption<SecurityScopeKind> | null) =>
      onScopeChange(
        option ? `${option.kind}:${option.relayId}:${option.id}` : null
      ),
    [onScopeChange]
  )
  const canScan =
    scope === null ? scannable.length > 0 : scannable.includes(scope)
  return (
    <ServerScopePicker<SecurityScopeKind>
      allLabel="All instances"
      ariaLabel="Checked instances"
      changeLabel="Change instance"
      chooseLabel="Choose instance"
      emptyMessage="Nothing has been checked yet."
      selectedServer={selected}
      servers={options}
      onSelect={select}
      manageSettingsControl={
        <ScanNowButton disabled={!canScan} scope={scope} />
      }
      manageSettingsTooltip={
        canScan
          ? "Check again against the latest vulnerability data"
          : "You can't scan what's selected"
      }
    />
  )
})

// Checks the scope again against the latest vulnerability data.
function useScanNow(scope: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => scanSecurityNow({ data: { scope } }),
    onError: (error: Error) =>
      showToast({ message: `Could not scan: ${error.message}`, type: "error" }),
    onSuccess: () => {
      showToast({
        message: "Scanning. Findings update here as each check finishes.",
        type: "success",
      })
      void queryClient.invalidateQueries({ queryKey: securityQueryKeys.all })
    },
  })
}

function ScanNowButton({
  disabled,
  scope,
}: {
  disabled: boolean
  scope: string | null
}) {
  const { isPending, mutate } = useScanNow(scope)
  return (
    <Button
      aria-label="Scan now"
      disabled={disabled || isPending}
      size="sm"
      type="button"
      variant="outline"
      onClick={() => mutate()}
    >
      {isPending ? <LoaderCircle className="animate-spin" /> : <ScanSearch />}
      <span className="hidden sm:inline">Scan now</span>
    </Button>
  )
}

// Scans one instance, as its row in the rail offers.
const TargetScanButton = React.memo(function TargetScanButton({
  name,
  scope,
}: {
  name: string
  scope: string
}) {
  const { isPending, mutate } = useScanNow(scope)
  return (
    <Button
      aria-label={`Scan ${name} now`}
      disabled={isPending}
      size="xs"
      type="button"
      variant="outline"
      onClick={() => mutate()}
    >
      {isPending ? <LoaderCircle className="animate-spin" /> : <ScanSearch />}
      Scan now
    </Button>
  )
})

function NothingChecked() {
  return (
    <section className="rounded-xl border border-dashed border-border/80 px-5 py-10 text-center">
      <ShieldCheck className="mx-auto size-6 text-muted-foreground" />
      <p className="type-card-title mt-3">Nothing has been checked yet</p>
      <p className="type-meta mx-auto mt-2 max-w-xl text-muted-foreground">
        Each Relay inventories its host and the images it runs within a few
        minutes of connecting, and Kiln checks them against known
        vulnerabilities. Relays older than this Hearth need an update first.
      </p>
    </section>
  )
}

const SecuritySummary = React.memo(function SecuritySummary({
  overview,
}: {
  overview: SecurityOverview
}) {
  const { counts, fixable, knownExploited } = overview.summary
  return (
    <section
      aria-label="Vulnerabilities found"
      className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-6"
    >
      {(["critical", "high", "medium", "low"] as const).map((severity) => (
        <SummaryTile
          key={severity}
          label={securitySeverityLabels[severity]}
          tone={counts[severity] > 0 ? severityTone(severity) : null}
          value={counts[severity].toLocaleString()}
        />
      ))}
      <SummaryTile
        label="An update fixes"
        tone={null}
        value={fixable.toLocaleString()}
      />
      <SummaryTile
        icon={<Siren className="size-3.5" />}
        label="Known exploited"
        tone={knownExploited > 0 ? severityTone("critical") : null}
        value={knownExploited.toLocaleString()}
      />
    </section>
  )
})

function SummaryTile({
  icon,
  label,
  tone,
  value,
}: {
  icon?: React.ReactNode
  label: string
  tone: string | null
  value: string
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border/75 bg-card/45 px-3 py-2",
        tone
      )}
    >
      <p className="type-meta flex items-center gap-1.5 opacity-85">
        {icon}
        {label}
      </p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function targetLabel(target: SecurityTarget): string {
  // An app's services are named; its one service and a game server's or
  // database's container are the resource itself.
  if (target.resourceType !== "relay") {
    return target.component && target.component !== "app"
      ? target.component
      : ""
  }
  return target.component === "host"
    ? `Host${target.distro ? ` · ${target.distro}` : ""}`
    : (target.component ?? "")
}

// One row per vulnerable package in each resource it's found in, so the
// resource can be sorted on and named with its own identity card.
interface FindingRowData {
  finding: SecurityFindingSummary
  id: string
  resource: SecurityResource | null
  target: Target
}

const findingColumnHelper = createDataTableColumnHelper<FindingRowData>()

const findingSearchFields = [
  (row: FindingRowData) => row.finding.vulnerabilityId,
  (row: FindingRowData) => row.finding.packageName,
  (row: FindingRowData) => row.finding.fixedVersion,
  (row: FindingRowData) => row.resource?.name,
  (row: FindingRowData) => row.resource?.relayName,
  (row: FindingRowData) => targetLabel(row.target),
] as const

const findingTableDefinition = defineDataTable<FindingRowData>({
  ariaLabel: "Vulnerabilities",
  columns: findingColumnHelper.columns([
    findingColumnHelper.accessor((row) => severityRank(row.finding.severity), {
      id: "severity",
      header: "Severity",
      sortDescFirst: true,
      // Known exploited ones lead their severity.
      sortFn: (left, right) =>
        severityRank(left.original.finding.severity) -
          severityRank(right.original.finding.severity) ||
        Number(left.original.finding.knownExploited) -
          Number(right.original.finding.knownExploited),
      cell: ({ row }) => (
        <SeverityBadge severity={row.original.finding.severity} />
      ),
      meta: dataTableColumnMeta({ width: "7.25rem" }),
    }),
    findingColumnHelper.accessor((row) => row.resource?.name ?? "", {
      id: "found-in",
      header: "Found in",
      sortFn: "text",
      cell: ({ row }) => (
        <ResourceIdentityLink
          resource={row.original.resource}
          target={row.original.target}
        />
      ),
      meta: dataTableColumnMeta(
        { width: "minmax(9rem,1.2fr)" },
        { cellClassName: "p-0" }
      ),
    }),
    findingColumnHelper.accessor((row) => row.finding.vulnerabilityId, {
      id: "vulnerability",
      header: "Vulnerability",
      sortFn: "text",
      cell: ({ row }) => <VulnerabilityLink finding={row.original.finding} />,
      meta: dataTableColumnMeta({ width: "9.75rem" }),
    }),
    findingColumnHelper.accessor((row) => row.finding.packageName, {
      id: "package",
      header: "Package",
      sortFn: "text",
      cell: ({ row }) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">
            {row.original.finding.packageName}
          </span>
          <span className="type-meta truncate font-mono text-muted-foreground">
            {row.original.finding.installedVersions.join(", ")}
          </span>
        </span>
      ),
      meta: dataTableColumnMeta({
        hideBelow: "md",
        width: "minmax(7rem,1fr)",
      }),
    }),
    findingColumnHelper.accessor((row) => row.finding.fixedVersion ?? "", {
      id: "fix",
      header: "Fix",
      sortFn: "text",
      cell: ({ row }) =>
        row.original.finding.fixedVersion ? (
          <span className="truncate font-mono text-[0.8125rem] text-emerald-300 light:text-emerald-700">
            {row.original.finding.fixedVersion}
          </span>
        ) : (
          <span className="type-meta text-muted-foreground">
            {row.original.finding.fixState === "wont-fix"
              ? "Won't be fixed"
              : "No fix yet"}
          </span>
        ),
      meta: dataTableColumnMeta({ hideBelow: "sm", width: "7rem" }),
    }),
    findingColumnHelper.accessor((row) => row.finding.firstSeenAt, {
      id: "first-seen",
      header: "First seen",
      sortFn: (left, right) =>
        left.original.finding.firstSeenAt - right.original.finding.firstSeenAt,
      cell: ({ row }) => (
        <span className="type-meta text-muted-foreground">
          <RelativeTime timestamp={row.original.finding.firstSeenAt} />
        </span>
      ),
      meta: dataTableColumnMeta({ hideBelow: "lg", width: "7.75rem" }),
    }),
    findingColumnHelper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      cell: ({ row }) => <FindingActions row={row.original} />,
      meta: dataTableColumnMeta(
        { width: { base: "3rem", md: "5.5rem" } },
        { cellClassName: "px-1 sm:px-2", headerClassName: "px-1 sm:px-2" }
      ),
    }),
  ]),
  getRowId: (row) => row.id,
  // Most severe first, known exploited first within each severity.
  model: { initialState: { sorting: [{ desc: true, id: "severity" }] } },
  search: { fields: findingSearchFields },
  virtualization: true,
})

const FindingsSection = React.memo(function FindingsSection({
  overview,
  resources,
  scope,
}: {
  overview: SecurityOverview
  resources: ReadonlyMap<string, SecurityResource>
  scope: string | null
}) {
  const [searchStore] = React.useState(createDataTableSearchStore)
  const [severity, setSeverity] = React.useState<SeverityFilter>("all")
  const rows = React.useMemo(() => {
    const targets = new Map(
      overview.targets.map((target) => [target.targetKey, target])
    )
    return overview.findings.flatMap((finding) => {
      if (severity !== "all" && finding.severity !== severity) return []
      const byResource = new Map<string, Target>()
      for (const key of finding.targets) {
        const target = targets.get(key)
        if (target && !byResource.has(target.scope)) {
          byResource.set(target.scope, target)
        }
      }
      return [...byResource].map(([resourceScope, target]): FindingRowData => ({
        finding,
        id: `${finding.vulnerabilityId}\u0000${finding.packageName}\u0000${target.targetKey}`,
        resource: resources.get(resourceScope) ?? null,
        target,
      }))
    })
  }, [overview.findings, overview.targets, resources, severity])
  const source = React.useMemo(
    (): DataTableSource<FindingRowData> => ({
      body: { kind: "ready" },
      refreshing: false,
      resetKey: `${scope ?? "all"}:${severity}`,
      rows,
    }),
    [rows, scope, severity]
  )
  const checked = overview.targets.some((target) => target.status === "checked")
  return (
    <DataTableWorkspace
      className="h-[min(44rem,75dvh)] flex-none xl:h-auto xl:min-h-[20rem] xl:flex-1"
      toolbar={
        <DataTableToolbar
          controls={
            <SeveritySelect value={severity} onValueChange={setSeverity} />
          }
          leading={<SecurityRefreshButton label="Refresh vulnerabilities" />}
          search={{
            ariaLabel: "Search vulnerabilities",
            closeMobileWhenEmpty: true,
            id: "security-search",
            placeholder: "Search vulnerabilities",
            store: searchStore,
          }}
        />
      }
    >
      <DataTable
        definition={findingTableDefinition}
        emptyState={({ searchActive }) => (
          <DataTableEmptyState
            description={
              searchActive || severity !== "all"
                ? "Try a CVE, package, instance, or another severity."
                : checked
                  ? "Nothing Kiln has checked has a known vulnerability."
                  : "Kiln is still checking what it inventoried."
            }
            icon={
              <ShieldCheck className="size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
            }
            title={
              searchActive || severity !== "all"
                ? "No vulnerabilities match"
                : "No known vulnerabilities"
            }
          />
        )}
        searchStore={searchStore}
        source={source}
      />
    </DataTableWorkspace>
  )
})

type SeverityFilter = SecuritySeverity | "all"

const severityFilterOptions: ReadonlyArray<{
  label: string
  value: SeverityFilter
}> = [
  { label: "All severities", value: "all" },
  ...[...securitySeverities].reverse().map((severity) => ({
    label: securitySeverityLabels[severity],
    value: severity,
  })),
]

// Narrows the vulnerabilities to one severity.
const SeveritySelect = React.memo(function SeveritySelect({
  onValueChange,
  value,
}: {
  onValueChange: (value: SeverityFilter) => void
  value: SeverityFilter
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onValueChange(next as SeverityFilter)}
    >
      <SelectTrigger
        aria-label="Filter by severity"
        className="h-9 w-auto min-w-36 gap-1.5"
      >
        <ListFilter className="size-4 text-muted-foreground" />
        <SelectValue>
          {
            severityFilterOptions.find((option) => option.value === value)
              ?.label
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        {severityFilterOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
})

// Loads what Hearth knows again, as when the page may be out of date.
const SecurityRefreshButton = React.memo(function SecurityRefreshButton({
  label,
}: {
  label: string
}) {
  const queryClient = useQueryClient()
  const refresh = React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: securityQueryKeys.all }),
    [queryClient]
  )
  return <InfraSyncButton label={label} sync={refresh} />
})

// The vulnerability's ID, linking to its advisory.
const VulnerabilityLink = React.memo(function VulnerabilityLink({
  finding,
}: {
  finding: SecurityFindingSummary
}) {
  if (!finding.url) {
    return (
      <span className="truncate font-mono text-[0.8125rem] font-medium">
        {finding.vulnerabilityId}
      </span>
    )
  }
  return (
    <a
      className="inline-flex min-w-0 items-center gap-1 font-mono text-[0.8125rem] font-medium hover:text-primary-ink hover:underline"
      href={finding.url}
      rel="noreferrer"
      target="_blank"
    >
      <span className="truncate">{finding.vulnerabilityId}</span>
      <ExternalLink className="size-3 shrink-0 opacity-60" />
    </a>
  )
})

// The Info page of a target's resource, which says what fixes what it runs.
const ResourceLink = React.forwardRef<
  HTMLAnchorElement,
  Omit<React.ComponentPropsWithoutRef<"a">, "href" | "target"> & {
    inventory: Target
  }
>(function ResourceLink({ inventory: target, ...props }, ref) {
  switch (target.resourceType) {
    case "app":
      return (
        <Link
          ref={ref}
          to="/app/$appId/info"
          params={{ appId: target.resourceId }}
          preload="intent"
          {...props}
        />
      )
    case "database":
      return (
        <Link
          ref={ref}
          to="/db/$databaseId/info"
          params={{ databaseId: target.resourceId }}
          preload="intent"
          {...props}
        />
      )
    case "instance":
      return (
        <Link
          ref={ref}
          to="/server/$serverId/info"
          params={{ serverId: target.resourceId }}
          preload="intent"
          {...props}
        />
      )
    case "relay":
      return (
        <Link
          ref={ref}
          to="/relay/$relayId/info"
          params={{ relayId: target.relayId }}
          preload="intent"
          {...props}
        />
      )
  }
})

// What a target is, named with its resource's identity card and live state,
// opening the resource's Info page.
const ResourceIdentityLink = React.memo(function ResourceIdentityLink({
  resource,
  target,
}: {
  resource: SecurityResource | null
  target: Target
}) {
  const kind =
    resource?.kind ??
    (target.resourceType === "instance" ? "server" : target.resourceType)
  return (
    <ResourceLink
      inventory={target}
      className={cn(
        dataTableRowLinkClassName,
        "group/resource-link flex min-h-14 w-full min-w-0 items-center px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
      )}
    >
      <InstanceCard
        className="min-w-0 flex-1"
        instance={{ id: target.resourceId, kind, relayId: target.relayId }}
        meta={targetLabel(target) || resource?.relayName}
        name={resource?.name ?? target.resourceId.slice(0, 8)}
        nameClassName="transition-colors group-hover/resource-link:text-primary-ink"
        showFavorite={false}
      />
    </ResourceLink>
  )
})

const resourceIdLabels = {
  app: "App ID",
  database: "Database ID",
  instance: "Server ID",
  relay: "Relay ID",
} satisfies Record<SecurityTarget["resourceType"], string>

// Fix, which opens the resource's page for now, and a menu of what to copy.
const FindingActions = React.memo(function FindingActions({
  row,
}: {
  row: FindingRowData
}) {
  const { finding, target } = row
  const name = row.resource?.name ?? target.resourceId.slice(0, 8)
  const packageName = `${finding.packageName} ${finding.installedVersions.join(", ")}`
  return (
    <DataTableActionGroup>
      <DataTableInlineActions>
        <Button asChild size="xs" variant="outline">
          <ResourceLink
            aria-label={`Fix ${finding.vulnerabilityId} in ${name}`}
            inventory={target}
          >
            <Wrench />
            Fix
          </ResourceLink>
        </Button>
      </DataTableInlineActions>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`More actions for ${finding.vulnerabilityId} in ${name}`}
            className={dataTableRowMenuTriggerClassName}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DataTablePhoneMenuItems>
            <DropdownMenuItem asChild>
              <ResourceLink inventory={target}>
                <Wrench />
                Fix
              </ResourceLink>
            </DropdownMenuItem>
          </DataTablePhoneMenuItems>
          {finding.url ? (
            <DropdownMenuItem asChild>
              <a href={finding.url} rel="noreferrer" target="_blank">
                <ExternalLink />
                Open advisory
              </a>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          {target.resourceType !== "relay" ? (
            <CopyIdentifierMenuItem
              label={resourceIdLabels[target.resourceType]}
              value={target.resourceId}
            />
          ) : null}
          <CopyIdentifierMenuItem label="Relay ID" value={target.relayId} />
          <CopyIdentifierMenuItem
            label="Vulnerability ID"
            value={finding.vulnerabilityId}
          />
          <CopyIdentifierMenuItem label="Package" value={packageName} />
          {finding.fixedVersion ? (
            <CopyIdentifierMenuItem
              label="Fixed version"
              value={finding.fixedVersion}
            />
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
  )
})

const targetColumnHelper = createDataTableColumnHelper<Target>()

const targetSearchFields = [
  (target: Target) => target.image,
  (target: Target) => target.distro,
  (target: Target) => targetLabel(target),
] as const

function targetTableDefinition(
  resources: ReadonlyMap<string, SecurityResource>,
  scannable: ReadonlySet<string>
) {
  const name = (target: Target) => resources.get(target.scope)?.name ?? ""
  return defineDataTable<Target>({
    ariaLabel: "What's checked",
    columns: targetColumnHelper.columns([
      targetColumnHelper.accessor(name, {
        id: "instance",
        header: "Instance",
        sortFn: "text",
        cell: ({ row }) => (
          <ResourceIdentityLink
            resource={resources.get(row.original.scope) ?? null}
            target={row.original}
          />
        ),
        meta: dataTableColumnMeta(
          { width: "minmax(0,1fr)" },
          { cellClassName: "p-0" }
        ),
      }),
      targetColumnHelper.display({
        id: "scan",
        header: () => <span className="sr-only">Scan</span>,
        enableSorting: false,
        cell: ({ row }) =>
          scannable.has(row.original.scope) ? (
            <TargetScanButton
              name={name(row.original)}
              scope={row.original.scope}
            />
          ) : null,
        meta: dataTableColumnMeta(
          { width: "6.75rem" },
          { cellClassName: "pl-0 pr-3", headerClassName: "pl-0 pr-3" }
        ),
      }),
    ]),
    getRowId: (target) => target.targetKey,
    model: { initialState: { sorting: [{ desc: false, id: "instance" }] } },
    search: {
      fields: [(target: Target) => name(target), ...targetSearchFields],
    },
    virtualization: true,
  })
}

// Every inventory in view, each with a way to scan it again.
const TargetsRail = React.memo(function TargetsRail({
  overview,
  resources,
  scannable,
  scope,
}: {
  overview: SecurityOverview
  resources: ReadonlyMap<string, SecurityResource>
  scannable: ReadonlyArray<string>
  scope: string | null
}) {
  const [searchStore] = React.useState(createDataTableSearchStore)
  const definition = React.useMemo(
    () => targetTableDefinition(resources, new Set(scannable)),
    [resources, scannable]
  )
  const source = React.useMemo(
    (): DataTableSource<Target> => ({
      body: { kind: "ready" },
      refreshing: false,
      resetKey: scope ?? "all",
      rows: overview.targets,
    }),
    [overview.targets, scope]
  )
  return (
    <section className="flex min-h-0 flex-col xl:flex-1">
      <DataTableWorkspace
        className="h-[28rem] flex-none rounded-none bg-background/45 xl:h-auto xl:min-h-[16rem] xl:flex-1"
        toolbar={
          <DataTableToolbar
            leading={<SecurityRefreshButton label="Refresh inventories" />}
            search={{
              ariaLabel: "Search inventories",
              id: "security-target-search",
              placeholder: "Search inventories",
              store: searchStore,
            }}
          />
        }
      >
        <DataTable
          definition={definition}
          emptyState={({ searchActive }) => (
            <DataTableEmptyState
              description={
                searchActive
                  ? "Try an instance, image, or Relay."
                  : "Relays inventory what they run within a few minutes of connecting."
              }
              title={
                searchActive
                  ? "No inventories match"
                  : "Nothing inventoried yet"
              }
            />
          )}
          searchStore={searchStore}
          source={source}
        />
      </DataTableWorkspace>
    </section>
  )
})
