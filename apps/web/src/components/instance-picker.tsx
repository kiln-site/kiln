import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Link } from "@tanstack/react-router"
import {
  ArrowRight,
  Check,
  Database,
  ListFilter,
  Minus,
  RadioTower,
  Search,
  Server as ServerIcon,
} from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import { cn } from "@workspace/ui/lib/utils"

import { InstanceName } from "@/components/instance-name"
import {
  availableInstancePickerFilters,
  defaultInstancePickerFilterIdsSnapshot,
  filterInstancePickerItems,
  instancePickerFilterGroups,
  instancePickerFilterIdsFromSnapshot,
  instancePickerFilterIdsSnapshot,
  subscribeInstancePickerFilterIds,
  writeInstancePickerFilterIds,
  type InstancePickerFilter,
  type InstancePickerItem,
  type InstancePickerKind,
} from "@/lib/instance-picker-filters"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

export type { InstancePickerItem } from "@/lib/instance-picker-filters"

interface InstancePickerAllOption {
  description: string
  label: string
  onSelect: () => void
  selected: boolean
}

interface InstancePickerContentProps {
  /** Pinned "no scope" row for single-select pickers. Hidden while searching. */
  allOption?: InstancePickerAllOption
  ariaLabel?: string
  emptyMessage?: string
  items: ReadonlyArray<InstancePickerItem>
  /** Multi-select shows checkboxes and keeps the picker open on select. */
  multiple?: boolean
  /** Called after the footer link navigates, usually to close the popover. */
  onNavigate?: () => void
  onSelect: (item: InstancePickerItem) => void
  /** Enables "Select all" controls in multi-select pickers. */
  onSelectMany?: (keys: ReadonlyArray<string>, selected: boolean) => void
  selectedKeys: ReadonlySet<string>
  /** Shows a "View all" footer that follows the active type filter. */
  viewAll?: boolean
}

type InstancePickerRow =
  | {
      kind: InstancePickerKind
      label: string
      type: "header"
    }
  | { item: InstancePickerItem; type: "item" }

const kindLabels: Record<InstancePickerKind, string> = {
  database: "Databases",
  relay: "Relays",
  server: "Servers",
}
const kindOrder: ReadonlyArray<InstancePickerKind> = [
  "server",
  "database",
  "relay",
]

export const InstancePickerContent = React.memo(function InstancePickerContent({
  allOption,
  ariaLabel = "Instances",
  emptyMessage = "No instances found",
  items,
  multiple = false,
  onNavigate,
  onSelect,
  onSelectMany,
  selectedKeys,
  viewAll = false,
}: InstancePickerContentProps) {
  const listId = React.useId()
  const [search, setSearch] = React.useState("")
  const [activeIndex, setActiveIndex] = React.useState(-1)
  const { filterIds, setFilterIds } = useInstancePickerFilterIds()
  const availableFilters = React.useMemo(
    () => availableInstancePickerFilters(items),
    [items]
  )
  const activeFilters = React.useMemo(
    () => availableFilters.filter((filter) => filterIds.includes(filter.id)),
    [availableFilters, filterIds]
  )
  const query = search.trim().toLocaleLowerCase()
  const visibleItems = React.useMemo(() => {
    const filtered = filterInstancePickerItems(items, activeFilters)
    return query
      ? filtered.filter((item) => matchesInstancePickerSearch(item, query))
      : filtered
  }, [activeFilters, items, query])
  const rows = React.useMemo(
    () => instancePickerRows(visibleItems),
    [visibleItems]
  )
  const itemRowIndexes = React.useMemo(
    () =>
      rows.flatMap((row, index) =>
        row.type === "item" && !row.item.disabled ? [index] : []
      ),
    [rows]
  )
  const toggleFilter = React.useCallback(
    (filterId: string, checked: boolean) => {
      setFilterIds(
        checked
          ? [...filterIds.filter((id) => id !== filterId), filterId]
          : filterIds.filter((id) => id !== filterId)
      )
    },
    [filterIds, setFilterIds]
  )
  const clearFilters = React.useCallback(() => setFilterIds([]), [setFilterIds])
  const showAllOption = allOption !== undefined && query.length === 0
  const activeRowIndex =
    activeIndex >= 0 && activeIndex < rows.length ? activeIndex : -1

  const scrollElementRef = React.useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: (index) => (rows[index]?.type === "header" ? 28 : 46),
    getItemKey: (index) => {
      const row = rows[index]
      if (!row) return index
      return row.type === "header" ? `header:${row.kind}` : row.item.key
    },
    getScrollElement: () => scrollElementRef.current,
    overscan: 4,
  })

  const moveActive = React.useCallback(
    (direction: 1 | -1) => {
      if (itemRowIndexes.length === 0) return
      const position = itemRowIndexes.indexOf(activeRowIndex)
      const next =
        position === -1
          ? direction === 1
            ? 0
            : itemRowIndexes.length - 1
          : (position + direction + itemRowIndexes.length) %
            itemRowIndexes.length
      const rowIndex = itemRowIndexes[next] ?? -1
      setActiveIndex(rowIndex)
      if (rowIndex >= 0) rowVirtualizer.scrollToIndex(rowIndex)
    },
    [activeRowIndex, itemRowIndexes, rowVirtualizer]
  )
  const handleSearchKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        moveActive(event.key === "ArrowDown" ? 1 : -1)
        return
      }
      if (event.key !== "Enter") return
      // Without an arrow-key selection, Enter picks the first search result.
      const row =
        rows[activeRowIndex] ??
        (query ? rows[itemRowIndexes[0] ?? -1] : undefined)
      if (row?.type !== "item" || row.item.disabled) return
      event.preventDefault()
      onSelect(row.item)
    },
    [activeRowIndex, itemRowIndexes, moveActive, onSelect, query, rows]
  )
  const handleSearchChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(event.currentTarget.value)
      setActiveIndex(-1)
    },
    []
  )

  const selectableVisibleKeys = React.useMemo(
    () => visibleItems.flatMap((item) => (item.disabled ? [] : [item.key])),
    [visibleItems]
  )
  const showBulkBar = multiple && onSelectMany !== undefined
  const showHeaderBulk = showBulkBar && rows[0]?.type === "header"
  const activeOption = rows[activeRowIndex]

  return (
    <>
      <div className="flex items-center gap-1.5 border-b border-border/70 p-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            autoFocus
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded="true"
            aria-activedescendant={
              activeOption?.type === "item"
                ? instancePickerOptionId(listId, activeOption.item.key)
                : undefined
            }
            value={search}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            placeholder={`Search ${ariaLabel.toLocaleLowerCase()}`}
            aria-label={`Search ${ariaLabel.toLocaleLowerCase()}`}
            className="h-8 bg-input/14 pr-2 pl-8 text-sm"
          />
        </div>
        {availableFilters.length > 0 ? (
          <InstancePickerFilterMenu
            activeFilters={activeFilters}
            availableFilters={availableFilters}
            items={items}
            onClear={clearFilters}
            onToggle={toggleFilter}
          />
        ) : null}
      </div>
      {showBulkBar ? (
        <InstancePickerBulkBar
          itemKeys={selectableVisibleKeys}
          selectedKeys={selectedKeys}
          totalCount={items.length}
          onSelectMany={onSelectMany}
        />
      ) : null}
      {showAllOption ? (
        <div className="border-b border-border/50 p-1.5">
          <InstancePickerAllRow option={allOption} />
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div
          ref={scrollElementRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          aria-multiselectable={multiple || undefined}
          className="max-h-72 overflow-y-auto overscroll-contain p-1.5"
        >
          <div
            className="relative w-full"
            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]
              if (!row) return null
              const next = rows[virtualRow.index + 1]
              return (
                <div
                  key={virtualRow.key}
                  ref={rowVirtualizer.measureElement}
                  className={cn(
                    "absolute top-0 left-0 w-full",
                    row.type === "item" && next?.type === "item"
                      ? "border-b border-border/50 pb-0.5"
                      : row.type === "item"
                        ? "pb-0.5"
                        : ""
                  )}
                  data-index={virtualRow.index}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {row.type === "header" ? (
                    <InstancePickerGroupHeader
                      groupKind={row.kind}
                      items={visibleItems}
                      label={row.label}
                      selectedKeys={selectedKeys}
                      onSelectMany={showHeaderBulk ? onSelectMany : undefined}
                    />
                  ) : (
                    <InstancePickerRowButton
                      active={virtualRow.index === activeRowIndex}
                      id={instancePickerOptionId(listId, row.item.key)}
                      item={row.item}
                      multiple={multiple}
                      selected={selectedKeys.has(row.item.key)}
                      onSelect={onSelect}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <InstancePickerEmptyState
          filtered={activeFilters.length > 0 && items.length > 0}
          message={items.length === 0 ? emptyMessage : undefined}
          searching={query.length > 0}
          onClearFilters={clearFilters}
        />
      )}
      {viewAll ? (
        <InstancePickerViewAll
          activeFilters={activeFilters}
          items={items}
          search={search.trim()}
          onNavigate={onNavigate}
        />
      ) : null}
    </>
  )
})

function useInstancePickerFilterIds() {
  const { data: userId } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) => capabilities.user.id,
  })
  const getSnapshot = React.useCallback(
    () =>
      userId
        ? instancePickerFilterIdsSnapshot(userId)
        : defaultInstancePickerFilterIdsSnapshot(),
    [userId]
  )
  const snapshot = React.useSyncExternalStore(
    subscribeInstancePickerFilterIds,
    getSnapshot,
    defaultInstancePickerFilterIdsSnapshot
  )
  const filterIds = React.useMemo(
    () => instancePickerFilterIdsFromSnapshot(snapshot),
    [snapshot]
  )
  const setFilterIds = React.useCallback(
    (next: ReadonlyArray<string>) => {
      if (userId) writeInstancePickerFilterIds(userId, next)
    },
    [userId]
  )
  return { filterIds, setFilterIds }
}

function instancePickerRows(
  items: ReadonlyArray<InstancePickerItem>
): Array<InstancePickerRow> {
  const groups = new Map<InstancePickerKind, Array<InstancePickerItem>>()
  for (const item of items) {
    const group = groups.get(item.identity.kind)
    if (group) group.push(item)
    else groups.set(item.identity.kind, [item])
  }
  if (groups.size < 2) {
    return items.map((item) => ({ item, type: "item" }))
  }
  const rows: Array<InstancePickerRow> = []
  for (const kind of kindOrder) {
    const group = groups.get(kind)
    if (!group) continue
    rows.push({ kind, label: kindLabels[kind], type: "header" })
    for (const item of group) rows.push({ item, type: "item" })
  }
  return rows
}

function matchesInstancePickerSearch(
  item: InstancePickerItem,
  query: string
): boolean {
  return `${item.name} ${item.meta} ${item.searchText ?? ""}`
    .toLocaleLowerCase()
    .includes(query)
}

function instancePickerOptionId(listId: string, key: string) {
  return `${listId}-${key.replace(/[^\w-]/g, "_")}`
}

const InstancePickerFilterMenu = React.memo(function InstancePickerFilterMenu({
  activeFilters,
  availableFilters,
  items,
  onClear,
  onToggle,
}: {
  activeFilters: ReadonlyArray<InstancePickerFilter>
  availableFilters: ReadonlyArray<InstancePickerFilter>
  items: ReadonlyArray<InstancePickerItem>
  onClear: () => void
  onToggle: (filterId: string, checked: boolean) => void
}) {
  const activeCount = activeFilters.length
  const counts = React.useMemo(
    () =>
      new Map(
        availableFilters.map((filter) => [
          filter.id,
          items.reduce(
            (count, item) => (filter.matches(item) ? count + 1 : count),
            0
          ),
        ])
      ),
    [availableFilters, items]
  )

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={
            activeCount > 0
              ? `Filter instances, ${activeCount} active`
              : "Filter instances"
          }
          className={cn(
            "relative grid size-8 shrink-0 place-items-center rounded-md border text-muted-foreground transition-colors outline-none hover:bg-muted/55 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-muted/55 data-[state=open]:text-foreground",
            activeCount > 0
              ? "border-primary/45 bg-primary/8 text-foreground"
              : "border-border/70"
          )}
        >
          <ListFilter className="size-3.5" aria-hidden="true" />
          {activeCount > 0 ? (
            <span className="absolute -top-1.5 -right-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[0.625rem] leading-none font-semibold text-primary-foreground">
              {activeCount}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[80] w-48">
        {instancePickerFilterGroups.map((group, index) => {
          const filters = availableFilters.filter(
            (filter) => filter.group === group.id
          )
          if (filters.length === 0) return null
          return (
            <React.Fragment key={group.id}>
              {index > 0 &&
              availableFilters.some(
                (filter) =>
                  filter.group === instancePickerFilterGroups[index - 1]?.id
              ) ? (
                <DropdownMenuSeparator />
              ) : null}
              <DropdownMenuGroup>
                <DropdownMenuLabel className="type-technical-label text-muted-foreground">
                  {group.label}
                </DropdownMenuLabel>
                {filters.map((filter) => (
                  <DropdownMenuCheckboxItem
                    key={filter.id}
                    checked={activeFilters.includes(filter)}
                    onCheckedChange={(checked) =>
                      onToggle(filter.id, checked === true)
                    }
                    onSelect={(event) => event.preventDefault()}
                  >
                    <span className="flex-1">{filter.label}</span>
                    <span className="type-meta font-mono text-muted-foreground">
                      {counts.get(filter.id) ?? 0}
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </React.Fragment>
          )
        })}
        {activeCount > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-muted-foreground"
              onSelect={onClear}
            >
              Clear filters
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

const InstancePickerBulkBar = React.memo(function InstancePickerBulkBar({
  itemKeys,
  onSelectMany,
  selectedKeys,
  totalCount,
}: {
  itemKeys: ReadonlyArray<string>
  onSelectMany: (keys: ReadonlyArray<string>, selected: boolean) => void
  selectedKeys: ReadonlySet<string>
  totalCount: number
}) {
  const selectedVisible = itemKeys.filter((key) => selectedKeys.has(key)).length
  const state =
    selectedVisible === 0
      ? "none"
      : selectedVisible === itemKeys.length
        ? "all"
        : "some"

  return (
    <div className="flex items-center gap-2 border-b border-border/70 px-3.5 py-2">
      <button
        type="button"
        role="checkbox"
        aria-checked={
          state === "all" ? true : state === "some" ? "mixed" : false
        }
        aria-label="Select all shown instances"
        disabled={itemKeys.length === 0}
        className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
        onClick={() => onSelectMany(itemKeys, state !== "all")}
      >
        <InstancePickerCheckbox state={state} />
      </button>
      <span className="type-meta text-muted-foreground">
        <span className="font-semibold text-foreground">
          {selectedKeys.size}
        </span>{" "}
        of {totalCount} selected
      </span>
      {selectedKeys.size > 0 ? (
        <button
          type="button"
          className="type-meta ml-auto text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline"
          onClick={() => onSelectMany(Array.from(selectedKeys), false)}
        >
          Clear
        </button>
      ) : null}
    </div>
  )
})

const InstancePickerGroupHeader = React.memo(
  function InstancePickerGroupHeader({
    groupKind,
    items,
    label,
    onSelectMany,
    selectedKeys,
  }: {
    groupKind: InstancePickerKind
    items: ReadonlyArray<InstancePickerItem>
    label: string
    onSelectMany?: (keys: ReadonlyArray<string>, selected: boolean) => void
    selectedKeys: ReadonlySet<string>
  }) {
    const groupItems = items.filter((item) => item.identity.kind === groupKind)
    const selectableKeys = groupItems.flatMap((item) =>
      item.disabled ? [] : [item.key]
    )
    const allSelected =
      selectableKeys.length > 0 &&
      selectableKeys.every((key) => selectedKeys.has(key))

    return (
      <div className="flex h-7 items-center justify-between px-2 pt-1.5">
        <span className="type-technical-label flex items-center gap-1.5 text-muted-foreground">
          {label}
          <span className="font-mono tracking-normal opacity-70">
            {groupItems.length}
          </span>
        </span>
        {onSelectMany && selectableKeys.length > 0 ? (
          <button
            type="button"
            className="type-meta text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline"
            onClick={() => onSelectMany(selectableKeys, !allSelected)}
          >
            {allSelected ? "Deselect all" : "Select all"}
          </button>
        ) : null}
      </div>
    )
  }
)

const InstancePickerRowButton = React.memo(function InstancePickerRowButton({
  active,
  id,
  item,
  multiple,
  onSelect,
  selected,
}: {
  active: boolean
  id: string
  item: InstancePickerItem
  multiple: boolean
  onSelect: (item: InstancePickerItem) => void
  selected: boolean
}) {
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      disabled={item.disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-[color,background-color,box-shadow] duration-100 outline-none hover:bg-popover-accent hover:text-popover-accent-foreground focus-visible:bg-popover-accent focus-visible:text-popover-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50",
        active && "bg-popover-accent text-popover-accent-foreground",
        selected &&
          !multiple &&
          "bg-primary/8 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_14%,transparent)]"
      )}
      onClick={() => onSelect(item)}
    >
      {multiple ? (
        <InstancePickerCheckbox state={selected ? "all" : "none"} />
      ) : null}
      <InstanceName
        className="min-w-0 flex-1 gap-2"
        iconClassName="border-0 bg-muted/55"
        instance={item.identity}
        meta={item.meta}
        metaClassName="font-mono"
        name={item.name}
        nameClassName="type-control-sm"
        statusClassName="ring-popover"
      />
      {selected && !multiple ? (
        <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />
      ) : null}
    </button>
  )
})

function InstancePickerCheckbox({ state }: { state: "all" | "none" | "some" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-sm border",
        state === "all"
          ? "border-primary bg-primary text-primary-foreground"
          : state === "some"
            ? "border-primary text-primary"
            : "border-input"
      )}
    >
      {state === "all" ? (
        <Check className="size-3" strokeWidth={3} />
      ) : state === "some" ? (
        <Minus className="size-3" strokeWidth={3} />
      ) : null}
    </span>
  )
}

const InstancePickerAllRow = React.memo(function InstancePickerAllRow({
  option,
}: {
  option: InstancePickerAllOption
}) {
  return (
    <button
      type="button"
      aria-pressed={option.selected}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-100 outline-none hover:bg-popover-accent hover:text-popover-accent-foreground focus-visible:bg-popover-accent focus-visible:ring-2 focus-visible:ring-ring/35",
        option.selected &&
          "bg-primary/8 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_14%,transparent)]"
      )}
      onClick={option.onSelect}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted/55 text-muted-foreground">
        <ServerIcon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="type-control-sm block truncate">{option.label}</span>
        <span className="type-meta block truncate text-muted-foreground">
          {option.description}
        </span>
      </span>
      {option.selected ? (
        <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />
      ) : null}
    </button>
  )
})

function InstancePickerEmptyState({
  filtered,
  message,
  onClearFilters,
  searching,
}: {
  filtered: boolean
  message?: string
  onClearFilters: () => void
  searching: boolean
}) {
  return (
    <div className="px-4 py-6 text-center">
      <p className="type-control-sm">
        {message ??
          (searching
            ? "Nothing matches your search"
            : "Nothing matches these filters")}
      </p>
      {filtered ? (
        <button
          type="button"
          className="type-meta mt-1 text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground"
          onClick={onClearFilters}
        >
          Clear filters
        </button>
      ) : message === undefined ? (
        <p className="type-meta mt-1 text-muted-foreground">
          Try a name, version, ID, or status.
        </p>
      ) : null}
    </div>
  )
}

const viewAllDestinations = {
  database: {
    Icon: Database,
    label: "View all databases",
    to: "/infra/databases",
  },
  relay: { Icon: RadioTower, label: "View all Relays", to: "/infra/relays" },
  server: { Icon: ServerIcon, label: "View all servers", to: "/infra/servers" },
} as const

const InstancePickerViewAll = React.memo(function InstancePickerViewAll({
  activeFilters,
  items,
  onNavigate,
  search,
}: {
  activeFilters: ReadonlyArray<InstancePickerFilter>
  items: ReadonlyArray<InstancePickerItem>
  onNavigate?: () => void
  search: string
}) {
  const activeKinds = activeFilters.flatMap((filter) =>
    filter.group === "type" ? [filter.id as InstancePickerKind] : []
  )
  const kind =
    activeKinds.length === 1
      ? activeKinds[0]
      : kindOrder.find((candidate) =>
          items.some((item) => item.identity.kind === candidate)
        )
  const destination = viewAllDestinations[kind ?? "server"]

  return (
    <div className="border-t border-border/70 p-1.5">
      <Link
        to={destination.to}
        search={search ? { search } : {}}
        onClick={onNavigate}
        className="type-control-sm group flex h-9 w-full items-center gap-2 rounded-md bg-muted/45 px-2.5 text-foreground transition-colors outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <destination.Icon
          className="size-3.5 text-muted-foreground"
          aria-hidden="true"
        />
        <span>{destination.label}</span>
        <ArrowRight
          className="ml-auto size-3.5 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5"
          aria-hidden="true"
        />
      </Link>
    </div>
  )
})
