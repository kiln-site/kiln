import * as React from "react"
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

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

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
  securitySeverityLabels,
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
              key={scope ?? "all"}
              overview={overview}
              resources={resources}
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

// The resource a target belongs to, named for the viewer.
function targetResource(
  target: SecurityTarget,
  resources: ReadonlyMap<string, SecurityResource>
): SecurityResource | undefined {
  return resources.get(target.scope)
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

const FindingsSection = React.memo(function FindingsSection({
  overview,
  resources,
}: {
  overview: SecurityOverview
  resources: ReadonlyMap<string, SecurityResource>
}) {
  const targets = React.useMemo(
    () => new Map(overview.targets.map((target) => [target.targetKey, target])),
    [overview.targets]
  )
  // Rows render a page at a time, so a long list doesn't slow the page.
  const [shown, setShown] = React.useState(findingPage)
  const findings = overview.findings.slice(0, shown)
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="type-section-title">Vulnerabilities</h2>
        <p className="type-meta text-muted-foreground">
          Known exploited first, then by severity, with ones an update fixes
          first.
          {overview.truncated
            ? ` Showing the ${overview.findings.length} most urgent; choose an instance to see all of its own.`
            : null}
        </p>
      </div>
      {overview.findings.length === 0 ? (
        <p className="type-meta rounded-xl border border-border/75 bg-card/45 px-4 py-6 text-center text-muted-foreground">
          {overview.targets.some((target) => target.status === "checked")
            ? "No known vulnerabilities in what's been checked."
            : "Kiln is still checking what it inventoried."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border/75 bg-card/45">
          <table className="w-full min-w-[64rem] text-left text-sm">
            <thead className="type-meta border-b border-border/75 text-muted-foreground">
              <tr>
                <th className="w-24 px-4 py-2.5 font-medium">Severity</th>
                <th className="px-4 py-2.5 font-medium">Vulnerability</th>
                <th className="px-4 py-2.5 font-medium">Package</th>
                <th className="px-4 py-2.5 font-medium">Fix</th>
                <th className="w-64 px-4 py-2.5 font-medium">Found in</th>
                <th className="w-28 px-4 py-2.5 font-medium">First seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {findings.map((finding) => (
                <FindingRow
                  key={`${finding.vulnerabilityId}:${finding.packageName}`}
                  finding={finding}
                  resources={resources}
                  targets={targets}
                />
              ))}
            </tbody>
          </table>
          {overview.findings.length > shown ? (
            <div className="border-t border-border/60 px-4 py-2.5 text-center">
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => setShown((count) => count + findingPage)}
              >
                Show more ({overview.findings.length - shown} left)
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
})

const findingPage = 100

const FindingRow = React.memo(function FindingRow({
  finding,
  resources,
  targets,
}: {
  finding: SecurityFindingSummary
  resources: ReadonlyMap<string, SecurityResource>
  targets: ReadonlyMap<string, Target>
}) {
  const affected = finding.targets.flatMap((key) => {
    const target = targets.get(key)
    return target ? [target] : []
  })
  return (
    <tr className="align-top [contain-intrinsic-size:auto_3.5rem] [content-visibility:auto]">
      <td className="px-4 py-3">
        <SeverityBadge severity={finding.severity} />
      </td>
      <td className="max-w-[26rem] px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {finding.url ? (
            <a
              className="inline-flex items-center gap-1 font-mono text-[0.8125rem] font-medium hover:underline"
              href={finding.url}
              rel="noreferrer"
              target="_blank"
            >
              {finding.vulnerabilityId}
              <ExternalLink className="size-3 opacity-60" />
            </a>
          ) : (
            <span className="font-mono text-[0.8125rem] font-medium">
              {finding.vulnerabilityId}
            </span>
          )}
          {finding.knownExploited ? (
            <Badge variant="destructive" className="h-5 gap-1 text-[0.6875rem]">
              <Siren className="size-3" /> Exploited
            </Badge>
          ) : null}
          {finding.epss !== null && finding.epss >= 0.1 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="h-5 text-[0.6875rem]">
                  {Math.round(finding.epss * 100)}% likely exploited
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                The chance it's exploited in the next 30 days (EPSS)
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        {finding.description ? (
          <p
            className="type-meta mt-1 line-clamp-2 text-muted-foreground"
            title={finding.description}
          >
            {finding.description}
          </p>
        ) : null}
      </td>
      <td className="px-4 py-3">
        <p className="font-medium break-all">{finding.packageName}</p>
        <p className="type-meta font-mono text-muted-foreground">
          {finding.installedVersions.join(", ")}
        </p>
      </td>
      <td className="px-4 py-3">
        {finding.fixedVersion ? (
          <span className="font-mono text-[0.8125rem] text-emerald-300 light:text-emerald-700">
            {finding.fixedVersion}
          </span>
        ) : (
          <span className="type-meta text-muted-foreground">
            {finding.fixState === "wont-fix" ? "Won't be fixed" : "No fix yet"}
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="grid gap-1.5">
          {affected.slice(0, 3).map((target) => (
            <TargetIdentity
              key={target.targetKey}
              resources={resources}
              target={target}
            />
          ))}
          {affected.length > 3 ? (
            <span className="type-meta text-muted-foreground">
              and {affected.length - 3} more
            </span>
          ) : null}
        </div>
      </td>
      <td className="px-4 py-3">
        <RelativeTime
          className="type-meta text-muted-foreground"
          timestamp={finding.firstSeenAt}
        />
      </td>
    </tr>
  )
})

const TargetIdentity = React.memo(function TargetIdentity({
  resources,
  target,
}: {
  resources: ReadonlyMap<string, SecurityResource>
  target: Target
}) {
  const resource = targetResource(target, resources)
  return (
    <InstanceCard
      instance={{
        id: target.resourceId,
        kind: resource?.kind ?? "relay",
        relayId: target.relayId,
      }}
      meta={targetLabel(target) || resource?.relayName}
      name={resource?.name ?? target.resourceId.slice(0, 8)}
      showFavorite={false}
      showStatus={false}
    />
  )
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
      <td className="px-4 py-2.5">
        <TargetIdentity resources={resources} target={target} />
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
