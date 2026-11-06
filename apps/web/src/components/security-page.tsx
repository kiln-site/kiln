import * as React from "react"
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { LoaderCircle, ScanSearch, ShieldCheck } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import { DataTableEmptyState } from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import { InfraSyncButton } from "@/components/infra-sync-button"
import { InstanceCard } from "@/components/instance-card"
import { RelativeTime } from "@/components/relative-time"
import { SecurityDialog } from "@/components/security-dialog"
import { securityFixLabel } from "@/components/security-fix"
import { VerdictBadge } from "@/components/security-severity"
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
  securityItemDetail,
  securityItemInstance,
  securityItemTitle,
  securityVerdictReason,
  securityVerdicts,
  securityVerdictSentences,
  type SecurityItem,
  type SecurityOverview,
  type SecurityResource,
  type SecurityScopeKind,
} from "@/lib/security"
import {
  securityOverviewQueryOptions,
  securityQueryKeys,
} from "@/lib/security-queries"
import { scanSecurityNow } from "@/server/security"

/**
 * Whether what Kiln runs is safe: each instance and Relay host, worst first,
 * with one word on it and one way to fix it. What to do, and what's affected,
 * are in the dialog each row opens.
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
  const [selected, setSelected] = React.useState<string | null>(null)
  // By key, so the dialog follows what a later check finds.
  const selectedItem = overview.items.find((item) => item.key === selected)
  const close = React.useCallback(() => setSelected(null), [])

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-card px-5 py-6 sm:px-7">
      <SecurityScopePicker
        resources={everything.resources}
        scannable={everything.scannable}
        scope={scope}
        onScopeChange={onScopeChange}
      />
      {overview.items.length === 0 ? (
        <NothingChecked />
      ) : (
        <>
          <Verdict overview={overview} />
          <ItemsSection
            items={overview.items}
            scope={scope}
            onSelect={setSelected}
          />
        </>
      )}
      {selectedItem ? (
        <SecurityDialog item={selectedItem} onClose={close} />
      ) : null}
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

// The page's answer in a sentence: what needs someone, and how much of it
// Kiln can fix.
const Verdict = React.memo(function Verdict({
  overview,
}: {
  overview: SecurityOverview
}) {
  const { items } = overview
  const unsafe = items.filter((item) => item.verdict === "unsafe").length
  const risky = items.filter((item) => item.verdict === "risky").length
  const unfinished = items.filter((item) => item.verdict === null).length
  const checkedAt = Math.max(0, ...items.map((item) => item.checkedAt ?? 0))
  const attention = unsafe + risky
  const [only] = items
  const headline =
    items.length === 1 && only?.verdict
      ? securityVerdictSentences[only.verdict]
      : attention > 0
        ? `${(unsafe || risky).toLocaleString()} of ${items.length.toLocaleString()} ${items.length === 1 ? "is" : "are"} ${unsafe > 0 ? "unsafe" : "risky"}`
        : unfinished === items.length
          ? "Kiln is still checking"
          : "Nothing needs attention"
  return (
    <section aria-label="Verdict" className="flex shrink-0 flex-col gap-0.5">
      <h2
        className={cn(
          "text-lg font-semibold",
          unsafe > 0
            ? "text-red-300 light:text-red-700"
            : risky > 0
              ? "text-orange-300 light:text-orange-700"
              : attention === 0 && unfinished < items.length
                ? "text-emerald-300 light:text-emerald-700"
                : ""
        )}
      >
        {headline}
      </h2>
      <p className="type-meta text-muted-foreground">
        {[
          unsafe > 0 && risky > 0
            ? `${risky.toLocaleString()} more risky`
            : null,
          overview.summary.fixable > 0
            ? `${overview.summary.fixable.toLocaleString()} ${overview.summary.fixable === 1 ? "vulnerability has" : "vulnerabilities have"} a fix`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        {checkedAt > 0 ? (
          <>
            {unsafe > 0 || overview.summary.fixable > 0 ? " · " : ""}
            {"checked "}
            <RelativeTime timestamp={checkedAt} />
          </>
        ) : null}
      </p>
    </section>
  )
})

// Worst first; among equals, what's being exploited, then the most critical.
function itemRank(item: SecurityItem): number {
  const verdict =
    item.verdict === null
      ? securityVerdicts.length
      : securityVerdicts.indexOf(item.verdict)
  return (
    verdict * 1e9 -
    item.knownExploited * 1e6 -
    item.counts.critical * 1e3 -
    item.counts.high
  )
}

const needsAttention = (item: SecurityItem) =>
  item.verdict === "unsafe" || item.verdict === "risky"

// The button a row offers: what fixes it, when there's one thing that does.
function rowAction(item: SecurityItem): string {
  if (item.verdict === null || !needsAttention(item)) return "View"
  const kinds = new Set(item.uses.map((use) => use.fix.kind))
  const [use] = item.uses
  return kinds.size === 1 && use ? securityFixLabel(use.fix) : "Fix"
}

const columnHelper = createDataTableColumnHelper<SecurityItem>()

// Opening a row is the one thing to do on this page, so the name and the
// button both do.
const SelectContext = React.createContext<(key: string) => void>(
  () => undefined
)

// The instance by name, with what it runs beneath. A host is its Relay's, as
// Kiln's own services are.
const ItemName = React.memo(function ItemName({
  item,
}: {
  item: SecurityItem
}) {
  const select = React.use(SelectContext)
  return (
    <button
      className="group/item flex min-h-14 w-full min-w-0 items-center px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
      type="button"
      onClick={() => select(item.key)}
    >
      <InstanceCard
        className="min-w-0 flex-1"
        instance={securityItemInstance(item)}
        meta={securityItemDetail(item)}
        name={securityItemTitle(item)}
        nameClassName="transition-colors group-hover/item:text-primary-ink"
        showFavorite={false}
      />
    </button>
  )
})

const ItemAction = React.memo(function ItemAction({
  item,
}: {
  item: SecurityItem
}) {
  const select = React.use(SelectContext)
  const label = rowAction(item)
  return (
    <Button
      aria-label={`${label}: ${item.name}`}
      size="xs"
      type="button"
      variant={needsAttention(item) ? "default" : "outline"}
      onClick={() => select(item.key)}
    >
      <span className="sm:hidden">{needsAttention(item) ? "Fix" : "View"}</span>
      <span className="hidden sm:inline">{label}</span>
    </Button>
  )
})

const itemTableDefinition = defineDataTable<SecurityItem>({
  ariaLabel: "Instances and hosts",
  columns: columnHelper.columns([
    columnHelper.accessor((item) => -itemRank(item), {
      id: "verdict",
      header: "Verdict",
      sortDescFirst: true,
      sortFn: (left, right) =>
        itemRank(right.original) - itemRank(left.original),
      cell: ({ row }) =>
        row.original.verdict ? (
          <VerdictBadge verdict={row.original.verdict} />
        ) : (
          <span className="type-meta text-muted-foreground">
            {row.original.status === "failed" ? "Failed" : "Checking"}
          </span>
        ),
      meta: dataTableColumnMeta({ width: { base: "5.75rem", sm: "6.5rem" } }),
    }),
    columnHelper.accessor((item) => item.name, {
      id: "instance",
      header: "Instance",
      sortFn: "text",
      cell: ({ row }) => <ItemName item={row.original} />,
      meta: dataTableColumnMeta(
        { width: "minmax(11rem,1.4fr)" },
        { cellClassName: "p-0" }
      ),
    }),
    columnHelper.display({
      id: "why",
      header: "Why",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="type-meta truncate text-muted-foreground">
          {row.original.verdict
            ? securityVerdictReason(row.original)
            : (row.original.error ?? "Waiting for its check")}
        </span>
      ),
      meta: dataTableColumnMeta({ hideBelow: "md", width: "minmax(9rem,1fr)" }),
    }),
    columnHelper.display({
      id: "fix",
      header: () => <span className="sr-only">Fix</span>,
      enableSorting: false,
      cell: ({ row }) => <ItemAction item={row.original} />,
      meta: dataTableColumnMeta(
        { width: { base: "3.75rem", sm: "11rem" } },
        {
          cellClassName: "justify-end px-1 sm:pr-3",
          headerClassName: "px-1 sm:pr-3",
        }
      ),
    }),
  ]),
  getRowId: (item) => item.key,
  model: { initialState: { sorting: [{ desc: true, id: "verdict" }] } },
  search: {
    fields: [
      (item: SecurityItem) => item.name,
      (item: SecurityItem) => securityItemTitle(item),
      (item: SecurityItem) =>
        item.uses.map((use) => `${use.name} ${use.relayName}`).join(" "),
    ],
  },
  virtualization: true,
})

type ItemFilter = "all" | "attention"

const ItemsSection = React.memo(function ItemsSection({
  items,
  onSelect,
  scope,
}: {
  items: ReadonlyArray<SecurityItem>
  onSelect: (key: string) => void
  scope: string | null
}) {
  const [searchStore] = React.useState(createDataTableSearchStore)
  const attention = React.useMemo(() => items.filter(needsAttention), [items])
  // Everything, once nothing needs attention, rather than an empty table.
  const [chosen, setChosen] = React.useState<ItemFilter>("attention")
  const filter = attention.length === 0 ? "all" : chosen
  const source = React.useMemo(
    (): DataTableSource<SecurityItem> => ({
      body: { kind: "ready" },
      refreshing: false,
      resetKey: `${scope ?? "all"}:${filter}`,
      rows: filter === "all" ? [...items] : attention,
    }),
    [attention, filter, items, scope]
  )
  return (
    <SelectContext.Provider value={onSelect}>
      <DataTableWorkspace
        className="min-h-[20rem] flex-1"
        toolbar={
          <DataTableToolbar
            controls={
              <div
                aria-label="Show"
                className="flex h-9 items-center rounded-md border p-0.5"
                role="group"
              >
                {(
                  [
                    ["attention", `Needs attention (${attention.length})`],
                    ["all", `All (${items.length})`],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    aria-pressed={filter === value}
                    className={cn(
                      "type-control-sm h-full rounded-sm px-2.5 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      filter === value
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                    type="button"
                    onClick={() => setChosen(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            }
            leading={<SecurityRefreshButton label="Refresh" />}
            search={{
              ariaLabel: "Search instances and images",
              closeMobileWhenEmpty: true,
              id: "security-search",
              placeholder: "Search instances and images",
              store: searchStore,
            }}
          />
        }
      >
        <DataTable
          definition={itemTableDefinition}
          emptyState={() => (
            <DataTableEmptyState
              description="Try an image, instance, or Relay."
              icon={
                <ShieldCheck className="size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
              }
              title="Nothing matches"
            />
          )}
          searchStore={searchStore}
          source={source}
        />
      </DataTableWorkspace>
    </SelectContext.Provider>
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
