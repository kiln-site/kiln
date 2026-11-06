import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  ScanSearch,
  Siren,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import { WorkspaceSummaryCard } from "@/components/workspace-summary-card"
import { instanceKindIcons } from "@/components/instance-kind-icon"
import {
  SecurityFixPanel,
  SecurityResourceLink,
  securityFixSource,
  securityFixTitle,
} from "@/components/security-fix"
import {
  SeverityBadge,
  SeverityCountChips,
  VerdictBadge,
} from "@/components/security-severity"
import {
  securityItemInstance,
  securityItemKind,
  securityItemTitle,
  securityVerdictReason,
  type SecurityItem,
  type SecurityPackage,
} from "@/lib/security"
import {
  securityPackagesQueryOptions,
  securityQueryKeys,
} from "@/lib/security-queries"
import { scanSecurityNow } from "@/server/security"

/**
 * One image or host: which resource, what it moves to, what's wrong with it,
 * and one button that says what it does. The dialog keeps one size whatever
 * loads in it, and its vulnerabilities scroll in the space between.
 */
export function SecurityDialog({
  item,
  onClose,
}: {
  item: SecurityItem
  onClose: () => void
}) {
  const [selected, setSelected] = React.useState(0)
  const use = item.uses[selected] ?? item.uses[0]
  const instance = securityItemInstance(item, use)
  const Icon = instanceKindIcons[instance.kind]
  const source = use ? securityFixSource(item, use.fix) : null
  const summary = (
    <WorkspaceSummaryCard
      action={
        use ? (
          <ChevronRight className="hidden size-4 shrink-0 text-muted-foreground transition-transform group-hover/resource:translate-x-0.5 sm:block" />
        ) : null
      }
      className="transition-colors group-hover/resource:border-primary-ink/50"
      icon={<Icon className="size-5" />}
      title={use?.name ?? securityItemTitle(item)}
      titleAccessory={
        <>
          {use ? (
            <Badge variant="outline" className="type-meta font-mono">
              {use.relayName}
            </Badge>
          ) : null}
          {item.verdict ? <VerdictBadge verdict={item.verdict} /> : null}
        </>
      }
    >
      <p className="type-meta mt-1 truncate font-mono text-muted-foreground">
        {[securityItemKind(item, use), source?.name, source?.detail]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </WorkspaceSummaryCard>
  )
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(36rem,calc(100dvh-2rem))] flex-col gap-3 sm:max-w-2xl">
        <DialogHeader className="min-w-0 pr-6">
          <DialogTitle className="truncate">
            {use ? securityFixTitle(use.fix, use) : securityItemTitle(item)}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {item.verdict
              ? securityVerdictReason(item)
              : "Kiln is still checking this"}
          </DialogDescription>
        </DialogHeader>
        {use ? (
          <SecurityResourceLink
            aria-label={`Open ${use.name}`}
            className="group/resource block shrink-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            use={use}
          >
            {summary}
          </SecurityResourceLink>
        ) : (
          summary
        )}
        {item.uses.length > 1 ? (
          <UsePicker item={item} selected={selected} onSelect={setSelected} />
        ) : null}
        {item.verdict === null ? (
          item.status === "failed" ? (
            <ScanAgain item={item} />
          ) : (
            <div className="grid flex-1 place-items-center">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            </div>
          )
        ) : use ? (
          <SecurityFixPanel
            item={item}
            use={use}
            vulnerabilities={<AffectedPackages item={item} />}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

// Each resource running the image has its own fix, one at a time.
function UsePicker({
  item,
  onSelect,
  selected,
}: {
  item: SecurityItem
  onSelect: (index: number) => void
  selected: number
}) {
  return (
    <div className="flex min-w-0 gap-1 overflow-x-auto" role="group">
      {item.uses.map((use, index) => (
        <Button
          key={`${use.scope}:${use.component ?? ""}`}
          aria-pressed={index === selected}
          size="xs"
          type="button"
          variant={index === selected ? "secondary" : "ghost"}
          onClick={() => onSelect(index)}
        >
          {use.component ?? use.name}
        </Button>
      ))}
    </div>
  )
}

// A check that failed, tried again on request.
function ScanAgain({ item }: { item: SecurityItem }) {
  const queryClient = useQueryClient()
  const scope = item.uses[0]?.scope ?? null
  const { isPending, mutate } = useMutation({
    mutationFn: () => scanSecurityNow({ data: { scope } }),
    onError: (error: Error) =>
      showToast({ message: `Could not scan: ${error.message}`, type: "error" }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: securityQueryKeys.all }),
  })
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2">
      <p className="type-meta text-center text-muted-foreground">
        {item.error ?? "Kiln couldn't check this"}
      </p>
      <Button
        disabled={isPending || scope === null}
        size="sm"
        type="button"
        variant="outline"
        onClick={() => mutate()}
      >
        {isPending ? <LoaderCircle className="animate-spin" /> : <ScanSearch />}
        Scan now
      </Button>
    </div>
  )
}

// By package, since one update clears a package's all at once, in a space
// of its own: loading or opening one moves nothing around it.
function AffectedPackages({ item }: { item: SecurityItem }) {
  const { data, error } = useQuery(securityPackagesQueryOptions(item.inventory))
  const total = Object.values(item.counts).reduce((sum, n) => sum + n, 0)
  return (
    <section
      aria-label="Vulnerabilities"
      className="flex min-h-0 flex-1 flex-col gap-1.5"
    >
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h3 className="text-[0.8125rem] font-medium">
          {total.toLocaleString()}{" "}
          {total === 1 ? "vulnerability" : "vulnerabilities"}
        </h3>
        <SeverityCountChips counts={item.counts} empty={null} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border">
        {error ? (
          <p className="type-meta p-3 text-destructive">{error.message}</p>
        ) : !data ? (
          <div className="grid h-full place-items-center">
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : data.length === 0 ? (
          <p className="type-meta grid h-full place-items-center text-muted-foreground">
            No known vulnerabilities
          </p>
        ) : (
          <>
            <div
              aria-hidden
              className="type-meta sticky top-0 z-10 flex items-center gap-2 border-b bg-popover px-2.5 py-1 text-muted-foreground"
            >
              <span className="flex-1 pl-5.5">Package</span>
              <span className="shrink-0">Fixed in</span>
              <span className="w-16 shrink-0 text-center">Worst</span>
              <span className="w-7 shrink-0 text-right">CVEs</span>
            </div>
            <ul className="divide-y divide-border/60">
              {data.map((found) => (
                <PackageRow key={found.name} found={found} />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}

// A package, its worst, and what fixes it, with its vulnerabilities behind it.
const PackageRow = React.memo(function PackageRow({
  found,
}: {
  found: SecurityPackage
}) {
  const [open, setOpen] = React.useState(false)
  const [fixedVersion, ...others] = found.fixedVersions
  const hidden = found.total - found.vulnerabilities.length
  return (
    <li>
      <button
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left outline-none hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
          {found.name}
        </span>
        {found.knownExploited > 0 ? (
          <Siren
            aria-label="Known to be exploited"
            className="size-3.5 shrink-0 text-red-400 light:text-red-700"
          />
        ) : null}
        <span className="type-meta max-w-[35%] shrink-0 truncate font-mono text-emerald-300 light:text-emerald-700">
          {fixedVersion ? (
            `${fixedVersion}${others.length ? ` +${others.length}` : ""}`
          ) : (
            <span className="text-muted-foreground">No fix</span>
          )}
        </span>
        <SeverityBadge className="w-16 justify-center" severity={found.worst} />
        <span className="type-meta w-7 shrink-0 text-right text-muted-foreground tabular-nums">
          {found.total.toLocaleString()}
        </span>
      </button>
      {open ? (
        <ul className="border-t border-border/60 bg-background/30 px-2.5 py-1">
          {found.vulnerabilities.map((vulnerability) => (
            <li
              key={vulnerability.vulnerabilityId}
              className="flex min-w-0 items-center gap-2 py-1"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {vulnerability.url ? (
                  <a
                    className="inline-flex items-center gap-1 hover:text-primary-ink hover:underline"
                    href={vulnerability.url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {vulnerability.vulnerabilityId}
                    <ExternalLink className="size-3 shrink-0 opacity-60" />
                  </a>
                ) : (
                  vulnerability.vulnerabilityId
                )}
              </span>
              <span className="type-meta max-w-[35%] shrink-0 truncate font-mono text-muted-foreground">
                {vulnerability.fixedVersion ?? "No fix"}
              </span>
              <SeverityBadge
                className="w-16 justify-center"
                severity={vulnerability.severity}
              />
            </li>
          ))}
          {hidden > 0 ? (
            <li className="type-meta py-1 text-muted-foreground">
              And {hidden.toLocaleString()} more
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  )
})
