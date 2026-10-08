import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Link } from "@tanstack/react-router"
import {
  ArrowRight,
  Check,
  Database,
  Layers,
  ListFilter,
  LoaderCircle,
  Minus,
  RadioTower,
  Search,
  Server as ServerIcon,
  Star,
} from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import { cn } from "@workspace/ui/lib/utils"

import { useInstanceFavoriteKeys } from "@/components/instance-favorite"
import { InstanceName } from "@/components/instance-name"
import { instanceFavoriteKey } from "@/lib/instance-favorites"
import {
  availableInstancePickerFilters,
  defaultInstancePickerFilterIdsSnapshot,
  favoriteInstancePickerFilter,
  filterInstancePickerItems,
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

/** A whole type of instance, including ones added later. */
export type InstancePickerGroup = "all" | InstancePickerKind

interface InstancePickerContentProps {
  ariaLabel?: string
  emptyMessage?: string
  items: ReadonlyArray<InstancePickerItem>
  /** Multi-select shows checkboxes and keeps the picker open on select. */
  multiple?: boolean
  /** Called after the footer link navigates, usually to close the popover. */
  onNavigate?: () => void
  onSelect: (item: InstancePickerItem) => void
  /**
   * Enables the split "All servers | All databases | All Relays" row. Unlike
   * selecting every row, a group also covers instances added later.
   */
  onSelectGroup?: (group: InstancePickerGroup) => void
  /** Enables the "Select all" bar in multi-select pickers. */
  onSelectMany?: (keys: ReadonlyArray<string>, selected: boolean) => void
  /** Adds an "All instances" segment to the group row. */
  includeAllGroup?: boolean
  /** Adds "All servers", "All databases", and "All Relays" segments. */
  includeKindGroups?: boolean
  /** Row being saved; shows a spinner and locks every row until it settles. */
  pendingKey?: string
  selectedGroups?: ReadonlySet<InstancePickerGroup>
  selectedKeys: ReadonlySet<string>
  /** Shows a "View all" footer that follows the active type filter. */
  viewAll?: boolean
}

const kindPresentation: Record<
  InstancePickerKind,
  { Icon: typeof ServerIcon; label: string; plural: string }
> = {
  database: { Icon: Database, label: "Database", plural: "databases" },
  relay: { Icon: RadioTower, label: "Relay", plural: "Relays" },
  server: { Icon: ServerIcon, label: "Server", plural: "servers" },
}

const kindOrder: ReadonlyArray<InstancePickerKind> = [
  "server",
  "database",
  "relay",
]
const emptyGroups: ReadonlySet<InstancePickerGroup> = new Set()
const emptyGroupList: ReadonlyArray<InstancePickerGroup> = []

export const InstancePickerContent = React.memo(function InstancePickerContent({
  ariaLabel = "Instances",
  emptyMessage = "No instances found",
  includeAllGroup = false,
  includeKindGroups = true,
  items: sourceItems,
  multiple = false,
  onNavigate,
  onSelect,
  onSelectGroup,
  onSelectMany,
  pendingKey,
  selectedGroups = emptyGroups,
  selectedKeys,
  viewAll = false,
}: InstancePickerContentProps) {
  const listId = React.useId()
  const [search, setSearch] = React.useState("")
  const [activeIndex, setActiveIndex] = React.useState(-1)
  const { filterIds, setFilterIds } = useInstancePickerFilterIds()
  const favoriteKeys = useInstanceFavoriteKeys()
  const items = React.useMemo(
    () =>
      favoriteKeys.size === 0
        ? sourceItems
        : sourceItems.map((item) =>
            favoriteKeys.has(instanceFavoriteKey(item.identity))
              ? { ...item, favorite: true }
              : item
          ),
    [favoriteKeys, sourceItems]
  )
  const availableFilters = React.useMemo(
    () => availableInstancePickerFilters(items),
    [items]
  )
  const typeFilters = React.useMemo(
    () => availableFilters.filter((filter) => filter.group === "type"),
    [availableFilters]
  )
  const activeFilters = React.useMemo(
    () => availableFilters.filter((filter) => filterIds.includes(filter.id)),
    [availableFilters, filterIds]
  )
  const activeTypeFilters = React.useMemo(
    () => activeFilters.filter((filter) => filter.group === "type"),
    [activeFilters]
  )
  const favoritesOnly = activeFilters.includes(favoriteInstancePickerFilter)
  const noFavorites =
    favoritesOnly && !items.some((item) => item.favorite === true)
  const showKind = typeFilters.length > 0
  const query = search.trim().toLocaleLowerCase()
  const visibleItems = React.useMemo(() => {
    const filtered = filterInstancePickerItems(items, activeFilters)
    return query
      ? filtered.filter((item) => matchesInstancePickerSearch(item, query))
      : filtered
  }, [activeFilters, items, query])
  const selectableIndexes = React.useMemo(
    () => visibleItems.flatMap((item, index) => (item.disabled ? [] : [index])),
    [visibleItems]
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
  const toggleFavorites = React.useCallback(
    () => toggleFilter(favoriteInstancePickerFilter.id, !favoritesOnly),
    [favoritesOnly, toggleFilter]
  )
  const showAllTypes = React.useCallback(
    () =>
      setFilterIds(
        filterIds.filter(
          (id) => !typeFilters.some((filter) => filter.id === id)
        )
      ),
    [filterIds, setFilterIds, typeFilters]
  )
  const clearFilters = React.useCallback(() => setFilterIds([]), [setFilterIds])
  const groups = React.useMemo(() => {
    if (!onSelectGroup) return emptyGroupList
    const kinds = includeKindGroups
      ? kindOrder.filter((kind) =>
          items.some((item) => item.identity.kind === kind)
        )
      : []
    return includeAllGroup ? (["all", ...kinds] as const) : kinds
  }, [includeAllGroup, includeKindGroups, items, onSelectGroup])
  const activeItemIndex =
    activeIndex >= 0 && activeIndex < visibleItems.length ? activeIndex : -1

  const scrollElementRef = React.useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: visibleItems.length,
    estimateSize: () => 46,
    getItemKey: (index) => visibleItems[index]?.key ?? index,
    getScrollElement: () => scrollElementRef.current,
    overscan: 4,
  })

  const moveActive = React.useCallback(
    (direction: 1 | -1) => {
      if (selectableIndexes.length === 0) return
      const position = selectableIndexes.indexOf(activeItemIndex)
      const next =
        position === -1
          ? direction === 1
            ? 0
            : selectableIndexes.length - 1
          : (position + direction + selectableIndexes.length) %
            selectableIndexes.length
      const index = selectableIndexes[next] ?? -1
      setActiveIndex(index)
      if (index >= 0) rowVirtualizer.scrollToIndex(index)
    },
    [activeItemIndex, rowVirtualizer, selectableIndexes]
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
      const item =
        visibleItems[activeItemIndex] ??
        (query ? visibleItems[selectableIndexes[0] ?? -1] : undefined)
      if (!item || item.disabled || pendingKey !== undefined) return
      event.preventDefault()
      onSelect(item)
    },
    [
      activeItemIndex,
      moveActive,
      onSelect,
      pendingKey,
      query,
      selectableIndexes,
      visibleItems,
    ]
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
  const activeKind =
    activeTypeFilters.length === 1
      ? (activeTypeFilters[0]?.id as InstancePickerKind)
      : undefined
  const activeItem = visibleItems[activeItemIndex]

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
              activeItem
                ? instancePickerOptionId(listId, activeItem.key)
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
        <InstancePickerToolButton
          active={favoritesOnly}
          label="Show favorites only"
          onClick={toggleFavorites}
        >
          <Star
            className={cn(
              "size-3.5",
              favoritesOnly && "fill-amber-400 text-amber-400"
            )}
            aria-hidden="true"
          />
        </InstancePickerToolButton>
        {typeFilters.length > 0 ? (
          <InstancePickerTypeMenu
            activeFilters={activeTypeFilters}
            filters={typeFilters}
            onShowAll={showAllTypes}
            onToggle={toggleFilter}
          />
        ) : null}
      </div>
      {multiple && onSelectMany ? (
        <InstancePickerBulkBar
          itemKeys={selectableVisibleKeys}
          kind={activeKind}
          selectedKeys={selectedKeys}
          onSelectMany={onSelectMany}
        />
      ) : null}
      {onSelectGroup && groups.length > 0 && query.length === 0 ? (
        <InstancePickerGroupRow
          groups={groups}
          selectedGroups={selectedGroups}
          onSelect={onSelectGroup}
        />
      ) : null}
      {visibleItems.length > 0 ? (
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
              const item = visibleItems[virtualRow.index]
              if (!item) return null
              return (
                <div
                  key={virtualRow.key}
                  ref={rowVirtualizer.measureElement}
                  className={cn(
                    "absolute top-0 left-0 w-full pb-0.5",
                    virtualRow.index < visibleItems.length - 1 &&
                      "border-b border-border/50"
                  )}
                  data-index={virtualRow.index}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <InstancePickerRowButton
                    active={virtualRow.index === activeItemIndex}
                    id={instancePickerOptionId(listId, item.key)}
                    item={item}
                    locked={pendingKey !== undefined}
                    multiple={multiple}
                    pending={pendingKey === item.key}
                    selected={selectedKeys.has(item.key)}
                    showKind={showKind}
                    onSelect={onSelect}
                  />
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <InstancePickerEmptyState
          favoritesOnly={noFavorites}
          filtered={activeFilters.length > 0 && items.length > 0}
          message={items.length === 0 ? emptyMessage : undefined}
          searching={query.length > 0}
          onClearFilters={noFavorites ? toggleFavorites : clearFilters}
        />
      )}
      {viewAll ? (
        <InstancePickerViewAll
          activeKind={activeKind}
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

const toolButtonClassName =
  "relative grid size-8 shrink-0 place-items-center rounded-md border border-border/70 text-muted-foreground transition-colors outline-none hover:bg-muted/55 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-muted/55 data-[state=open]:text-foreground"
const activeToolButtonClassName = "border-primary/45 bg-primary/8 text-primary"

const InstancePickerToolButton = React.memo(function InstancePickerToolButton({
  active,
  children,
  label,
  onClick,
}: {
  active: boolean
  children: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(toolButtonClassName, active && activeToolButtonClassName)}
      onClick={onClick}
    >
      {children}
    </button>
  )
})

const InstancePickerTypeMenu = React.memo(function InstancePickerTypeMenu({
  activeFilters,
  filters,
  onShowAll,
  onToggle,
}: {
  activeFilters: ReadonlyArray<InstancePickerFilter>
  filters: ReadonlyArray<InstancePickerFilter>
  onShowAll: () => void
  onToggle: (filterId: string, checked: boolean) => void
}) {
  const filtered = activeFilters.length > 0

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={
            filtered
              ? `Filter by type, showing ${activeFilters
                  .map((filter) => filter.label.toLocaleLowerCase())
                  .join(" and ")}`
              : "Filter by type"
          }
          title="Filter by type"
          className={cn(
            toolButtonClassName,
            filtered && activeToolButtonClassName
          )}
        >
          <ListFilter className="size-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[80] w-44 p-1">
        {filters.map((filter) => {
          const { Icon } = kindPresentation[filter.id as InstancePickerKind]
          return (
            <DropdownMenuCheckboxItem
              key={filter.id}
              checked={activeFilters.includes(filter)}
              className="gap-2 py-1.5"
              onCheckedChange={(checked) =>
                onToggle(filter.id, checked === true)
              }
              onSelect={(event) => event.preventDefault()}
            >
              <Icon
                className="size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              {filter.label}
            </DropdownMenuCheckboxItem>
          )
        })}
        {filtered ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="py-1.5 text-muted-foreground"
              onSelect={onShowAll}
            >
              Show all types
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

const InstancePickerBulkBar = React.memo(function InstancePickerBulkBar({
  itemKeys,
  kind,
  onSelectMany,
  selectedKeys,
}: {
  itemKeys: ReadonlyArray<string>
  kind?: InstancePickerKind
  onSelectMany: (keys: ReadonlyArray<string>, selected: boolean) => void
  selectedKeys: ReadonlySet<string>
}) {
  const selectedVisible = itemKeys.filter((key) => selectedKeys.has(key)).length
  const state =
    selectedVisible === 0
      ? "none"
      : selectedVisible === itemKeys.length
        ? "all"
        : "some"

  return (
    <div className="flex items-center gap-2 border-b border-border/70 px-2 py-1.5">
      <button
        type="button"
        role="checkbox"
        aria-checked={
          state === "all" ? true : state === "some" ? "mixed" : false
        }
        disabled={itemKeys.length === 0}
        className="type-control-sm flex items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-popover-accent focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
        onClick={() => onSelectMany(itemKeys, state !== "all")}
      >
        <InstancePickerCheckbox state={state} />
        Select all {kind ? kindPresentation[kind].plural : "shown"}
      </button>
      <span className="type-meta ml-auto text-muted-foreground">
        {selectedKeys.size} selected
      </span>
      {selectedKeys.size > 0 ? (
        <button
          type="button"
          className="type-meta mr-1.5 text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline"
          onClick={() => onSelectMany(Array.from(selectedKeys), false)}
        >
          Clear
        </button>
      ) : null}
    </div>
  )
})

const InstancePickerRowButton = React.memo(function InstancePickerRowButton({
  active,
  id,
  item,
  locked,
  multiple,
  onSelect,
  pending,
  selected,
  showKind,
}: {
  active: boolean
  id: string
  item: InstancePickerItem
  locked: boolean
  multiple: boolean
  onSelect: (item: InstancePickerItem) => void
  pending: boolean
  selected: boolean
  showKind: boolean
}) {
  const kind = kindPresentation[item.identity.kind]

  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-busy={pending || undefined}
      aria-selected={selected}
      tabIndex={-1}
      disabled={item.disabled || locked}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-[color,background-color,box-shadow] duration-100 outline-none hover:bg-popover-accent hover:text-popover-accent-foreground focus-visible:bg-popover-accent focus-visible:text-popover-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50",
        active && "bg-popover-accent text-popover-accent-foreground",
        selected &&
          !multiple &&
          "bg-primary/8 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_35%,transparent)]"
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
      {pending ? (
        <LoaderCircle
          className="size-3.5 shrink-0 animate-spin text-primary"
          aria-hidden="true"
        />
      ) : showKind ? (
        <span className="shrink-0 text-muted-foreground/70">
          <kind.Icon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{kind.label}</span>
        </span>
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

const groupPresentation: Record<
  InstancePickerGroup,
  { Icon: typeof ServerIcon; label: string }
> = {
  all: { Icon: Layers, label: "All instances" },
  database: { Icon: Database, label: "All databases" },
  relay: { Icon: RadioTower, label: "All Relays" },
  server: { Icon: ServerIcon, label: "All servers" },
}

const InstancePickerGroupRow = React.memo(function InstancePickerGroupRow({
  groups,
  onSelect,
  selectedGroups,
}: {
  groups: ReadonlyArray<InstancePickerGroup>
  onSelect: (group: InstancePickerGroup) => void
  selectedGroups: ReadonlySet<InstancePickerGroup>
}) {
  return (
    <div className="border-b border-border/70 p-1.5">
      <div
        role="group"
        aria-label="Whole instance types"
        className="flex divide-x divide-border/70 overflow-hidden rounded-md border border-border/70 bg-muted/25"
      >
        {groups.map((group) => {
          const { Icon, label } = groupPresentation[group]
          const selected = selectedGroups.has(group)
          return (
            <button
              key={group}
              type="button"
              aria-pressed={selected}
              className={cn(
                "type-control-sm flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 px-2 text-muted-foreground transition-colors duration-100 outline-none hover:bg-popover-accent hover:text-popover-accent-foreground focus-visible:bg-popover-accent focus-visible:text-popover-accent-foreground",
                selected &&
                  "bg-primary/8 text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_35%,transparent)]"
              )}
              onClick={() => onSelect(group)}
            >
              <Icon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
})

function InstancePickerEmptyState({
  favoritesOnly,
  filtered,
  message,
  onClearFilters,
  searching,
}: {
  favoritesOnly: boolean
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
            : favoritesOnly
              ? "No favorites yet"
              : "Nothing matches these filters")}
      </p>
      {filtered ? (
        <button
          type="button"
          className="type-meta mt-1 text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground"
          onClick={onClearFilters}
        >
          {favoritesOnly ? "Show everything" : "Clear filters"}
        </button>
      ) : message === undefined ? (
        <p className="type-meta mt-1 text-muted-foreground">
          Try a name, version, or ID.
        </p>
      ) : null}
    </div>
  )
}

const viewAllDestinations = {
  database: { label: "View all databases", to: "/infra/databases" },
  relay: { label: "View all Relays", to: "/infra/relays" },
  server: { label: "View all servers", to: "/infra/servers" },
} as const

const InstancePickerViewAll = React.memo(function InstancePickerViewAll({
  activeKind,
  items,
  onNavigate,
  search,
}: {
  activeKind?: InstancePickerKind
  items: ReadonlyArray<InstancePickerItem>
  onNavigate?: () => void
  search: string
}) {
  const kind = activeKind ?? items[0]?.identity.kind ?? "server"
  const destination = viewAllDestinations[kind]
  const { Icon } = kindPresentation[kind]

  return (
    <div className="border-t border-border/70 p-1.5">
      <Link
        to={destination.to}
        search={search ? { search } : {}}
        onClick={onNavigate}
        className="type-control-sm group flex h-9 w-full items-center gap-2 rounded-md bg-muted/45 px-2.5 text-foreground transition-colors outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span>{destination.label}</span>
        <ArrowRight
          className="ml-auto size-3.5 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5"
          aria-hidden="true"
        />
      </Link>
    </div>
  )
})
