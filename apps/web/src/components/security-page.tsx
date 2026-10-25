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
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  ScanSearch,
  ShieldCheck,
  Siren,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import {
  DataTableEmptyState,
  dataTableRowLinkClassName,
} from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import { InstanceCard } from "@/components/instance-card"
import { RelativeTime } from "@/components/relative-time"
import {
  SeverityBadge,
  SeverityCountChips,
  severityTone,
} from "@/components/security-severity"
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
  securitySeverityLabels,
  severityRank,
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

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="mx-auto grid w-full max-w-[90rem] gap-5 px-3 pt-4 pb-10 sm:px-5">
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
            <TargetsSection overview={overview} resources={resources} />
            <SecurityFootnote overview={overview} />
          </>
        )}
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

function ScanNowButton({
  disabled,
  scope,
}: {
  disabled: boolean
  scope: string | null
}) {
  const queryClient = useQueryClient()
  const { isPending, mutate } = useMutation({
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
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
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
        "rounded-xl border border-border/75 bg-card/45 px-4 py-3",
        tone
      )}
    >
      <p className="type-meta flex items-center gap-1.5 opacity-85">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
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
      // Known exploited ones lead their severity.
      sortFn: (left, right) =>
        severityRank(left.original.finding.severity) -
          severityRank(right.original.finding.severity) ||
        Number(left.original.finding.knownExploited) -
          Number(right.original.finding.knownExploited),
      cell: ({ row }) => (
        <SeverityBadge severity={row.original.finding.severity} />
      ),
      meta: dataTableColumnMeta({ width: "7rem" }),
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
        { width: "minmax(12rem,1.2fr)" },
        { cellClassName: "p-0" }
      ),
    }),
    findingColumnHelper.accessor((row) => row.finding.vulnerabilityId, {
      id: "vulnerability",
      header: "Vulnerability",
      sortFn: "text",
      cell: ({ row }) => <VulnerabilityLink finding={row.original.finding} />,
      meta: dataTableColumnMeta({ width: "minmax(11rem,0.8fr)" }),
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
        width: "minmax(10rem,1fr)",
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
      meta: dataTableColumnMeta({ hideBelow: "sm", width: "8rem" }),
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
      meta: dataTableColumnMeta({ hideBelow: "lg", width: "8.25rem" }),
    }),
  ]),
  getRowId: (row) => row.id,
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
  const rows = React.useMemo(() => {
    const targets = new Map(
      overview.targets.map((target) => [target.targetKey, target])
    )
    return overview.findings.flatMap((finding) => {
      const byResource = new Map<string, Target>()
      for (const key of finding.targets) {
        const target = targets.get(key)
        if (target && !byResource.has(target.scope)) {
          byResource.set(target.scope, target)
        }
      }
      return [...byResource].map(([resourceScope, target]): FindingRowData => ({
        finding,
        id: `${finding.vulnerabilityId}\u0000${finding.packageName}\u0000${resourceScope}`,
        resource: resources.get(resourceScope) ?? null,
        target,
      }))
    })
  }, [overview.findings, overview.targets, resources])
  const source = React.useMemo(
    (): DataTableSource<FindingRowData> => ({
      body: { kind: "ready" },
      refreshing: false,
      resetKey: scope ?? "all",
      rows,
    }),
    [rows, scope]
  )
  const checked = overview.targets.some((target) => target.status === "checked")
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="type-section-title">Vulnerabilities</h2>
        {overview.truncated ? (
          <p className="type-meta text-muted-foreground">
            The {overview.findings.length.toLocaleString()} most urgent; choose
            an instance to see all of its own.
          </p>
        ) : null}
      </div>
      <DataTableWorkspace
        className="h-[min(44rem,75dvh)] flex-none"
        toolbar={
          <DataTableToolbar
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
                searchActive
                  ? "Try a CVE, package, or instance."
                  : checked
                    ? "Nothing Kiln has checked has a known vulnerability."
                    : "Kiln is still checking what it inventoried."
              }
              icon={
                <ShieldCheck className="size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
              }
              title={
                searchActive
                  ? "No vulnerabilities match your search"
                  : "No known vulnerabilities"
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

// What a target is, named with its resource's identity card and live state,
// opening the resource's Info page, which says what fixes it.
const ResourceIdentityLink = React.memo(function ResourceIdentityLink({
  resource,
  target,
}: {
  resource: SecurityResource | null
  target: Target
}) {
  const kind = resource?.kind ?? "relay"
  const card = (
    <InstanceCard
      className="min-w-0 flex-1"
      instance={{ id: target.resourceId, kind, relayId: target.relayId }}
      meta={targetLabel(target) || resource?.relayName}
      name={resource?.name ?? target.resourceId.slice(0, 8)}
      nameClassName="transition-colors group-hover/resource-link:text-primary-ink"
      showFavorite={false}
    />
  )
  const className = cn(
    dataTableRowLinkClassName,
    "group/resource-link flex min-h-14 w-full min-w-0 items-center px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
  )
  switch (kind) {
    case "app":
      return (
        <Link
          to="/app/$appId/info"
          params={{ appId: target.resourceId }}
          preload="intent"
          className={className}
        >
          {card}
        </Link>
      )
    case "database":
      return (
        <Link
          to="/db/$databaseId/info"
          params={{ databaseId: target.resourceId }}
          preload="intent"
          className={className}
        >
          {card}
        </Link>
      )
    case "server":
      return (
        <Link
          to="/server/$serverId/info"
          params={{ serverId: target.resourceId }}
          preload="intent"
          className={className}
        >
          {card}
        </Link>
      )
    case "relay":
      return (
        <Link
          to="/relay/$relayId/info"
          params={{ relayId: target.relayId }}
          preload="intent"
          className={className}
        >
          {card}
        </Link>
      )
  }
})

const TargetsSection = React.memo(function TargetsSection({
  overview,
  resources,
}: {
  overview: SecurityOverview
  resources: ReadonlyMap<string, SecurityResource>
}) {
  const targets = React.useMemo(
    () =>
      [...overview.targets].sort(
        (a, b) =>
          b.knownExploited - a.knownExploited ||
          b.counts.critical - a.counts.critical ||
          b.counts.high - a.counts.high ||
          b.counts.medium - a.counts.medium ||
          a.targetKey.localeCompare(b.targetKey)
      ),
    [overview.targets]
  )
  const pending = targets.filter((target) => target.status === "pending").length
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="type-section-title">What's checked</h2>
        <p className="type-meta text-muted-foreground">
          {targets.length} {targets.length === 1 ? "inventory" : "inventories"}
          {pending ? `, ${pending} still being checked` : ""}
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border/75 bg-card/45">
        <table className="w-full min-w-[48rem] text-left text-sm">
          <thead className="type-meta border-b border-border/75 text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">Instance</th>
              <th className="px-4 py-2.5 font-medium">Image</th>
              <th className="px-4 py-2.5 font-medium">Found</th>
              <th className="w-36 px-4 py-2.5 font-medium">Inventoried</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {targets.map((target) => (
              <TargetRow
                key={target.targetKey}
                resources={resources}
                target={target}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
})

const TargetRow = React.memo(function TargetRow({
  resources,
  target,
}: {
  resources: ReadonlyMap<string, SecurityResource>
  target: Target
}) {
  return (
    <tr className="align-middle [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]">
      <td className="p-0">
        <ResourceIdentityLink
          resource={resources.get(target.scope) ?? null}
          target={target}
        />
      </td>
      <td className="max-w-[22rem] px-4 py-2.5">
        <p
          className="truncate font-mono text-[0.8125rem]"
          title={target.image ?? undefined}
        >
          {target.image ?? target.distro ?? "Host packages"}
        </p>
        {target.packages !== null ? (
          <p className="type-meta text-muted-foreground">
            {target.packages} packages
            {target.running ? "" : " · not running"}
          </p>
        ) : null}
      </td>
      <td className="px-4 py-2.5">
        {target.status === "checked" ? (
          <div className="flex flex-wrap items-center gap-2">
            <SeverityCountChips counts={target.counts} />
            {target.fixable > 0 ? (
              <span className="type-meta text-muted-foreground">
                {target.fixable} fixable
              </span>
            ) : null}
          </div>
        ) : target.status === "failed" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="type-meta inline-flex items-center gap-1.5 text-amber-300 light:text-amber-700">
                <CircleAlert className="size-3.5" />
                Couldn't check
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm">{target.error}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="type-meta inline-flex items-center gap-1.5 text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" />
            {target.collectedAt === null ? "Waiting for inventory" : "Checking"}
          </span>
        )}
      </td>
      <td className="px-4 py-2.5">
        {target.collectedAt !== null ? (
          <RelativeTime
            className="type-meta text-muted-foreground"
            timestamp={target.collectedAt}
          />
        ) : (
          <span className="type-meta text-muted-foreground">Not yet</span>
        )}
      </td>
    </tr>
  )
})

function SecurityFootnote({ overview }: { overview: SecurityOverview }) {
  return (
    <p className="type-meta text-muted-foreground">
      Each Relay inventories its host and each image once with Syft, at the
      lowest priority; Hearth keeps the inventories and checks them again with
      Grype whenever its vulnerability data changes, even while a Relay is
      offline.
      {overview.databaseBuiltAt ? (
        <>
          {" "}
          Vulnerability data from{" "}
          <RelativeTime timestamp={overview.databaseBuiltAt} />.
        </>
      ) : null}
    </p>
  )
}
