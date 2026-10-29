import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Link } from "@tanstack/react-router"
import {
  ArrowRight,
  Check,
  Layers,
  ListFilter,
  LoaderCircle,
  Minus,
  Search,
  Star,
} from "lucide-react"
import type { LucideProps } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { cn } from "@workspace/ui/lib/utils"

import { useDrawerPopoverIsDrawer } from "@/components/drawer-popover"
import { useInstanceFavoriteKeys } from "@/components/instance-favorite"
import { HearthMark } from "@/components/hearth-mark"
import { InstanceCard, isKilnIdentity } from "@/components/instance-card"
import {
  AppKindIcon,
  DatabaseKindIcon,
  RelayKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"
import { instanceFavoriteKey, kilnFavorite } from "@/lib/instance-favorites"
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
  /** Shows the "Show favorites only" filter. Off ignores a saved choice. */
  favoritesFilter?: boolean
  items: ReadonlyArray<InstancePickerItem>
  /** Multi-select shows checkboxes and keeps the picker open on select. */
  multiple?: boolean
  /** Called after the footer link navigates, usually to close the popover. */
  onNavigate?: () => void
  onSelect: (item: InstancePickerItem) => void
  /**
   * Enables the split "All game servers | All databases | All Relays" row. Unlike
   * selecting every row, a group also covers instances added later.
   */
  onSelectGroup?: (group: InstancePickerGroup) => void
  /** Enables the "Select all" bar in multi-select pickers. */
  onSelectMany?: (keys: ReadonlyArray<string>, selected: boolean) => void
  /** Adds an "All instances" segment to the group row. */
  includeAllGroup?: boolean
  /** Adds "All game servers", "All databases", and "All Relays" segments. */
  includeKindGroups?: boolean
  /** Row being saved; shows a spinner and locks every row until it settles. */
  pendingKey?: string
  selectedGroups?: ReadonlySet<InstancePickerGroup>
  selectedKeys: ReadonlySet<string>
  /** Shows a "View all" footer that follows the active type filter. */
  viewAll?: boolean
}

// Kind `server` is shown to users as "Game Server". See AGENTS.md Naming.
const kindPresentation: Record<
  InstancePickerKind,
  { Icon: typeof ServerKindIcon; label: string; plural: string }
> = {
  app: { Icon: AppKindIcon, label: "App", plural: "apps" },
  database: {
    Icon: DatabaseKindIcon,
    label: "Database",
    plural: "databases",
  },
  relay: { Icon: RelayKindIcon, label: "Relay", plural: "Relays" },
  server: {
    Icon: ServerKindIcon,
    label: "Game Server",
    plural: "game servers",
  },
}

const kindOrder: ReadonlyArray<InstancePickerKind> = [
  "server",
  "database",
  "app",
  "relay",
]
const emptyGroups: ReadonlySet<InstancePickerGroup> = new Set()
const emptyGroupList: ReadonlyArray<InstancePickerGroup> = []
const emptyFilterList: ReadonlyArray<InstancePickerFilter> = []

export const InstancePickerContent = React.memo(function InstancePickerContent({
  ariaLabel = "Instances",
  emptyMessage = "No instances found",
  favoritesFilter = true,
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
            favoriteKeys.has(instancePickerFavoriteKey(item))
              ? { ...item, favorite: true }
              : item
          ),
    [favoriteKeys, sourceItems]
  )
  const availableFilters = React.useMemo(() => {
    const filters = availableInstancePickerFilters(items)
    return favoritesFilter
      ? filters
      : filters.filter((filter) => filter !== favoriteInstancePickerFilter)
  }, [favoritesFilter, items])
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
  const showKind = typeFilters.length > 0
  const query = search.trim().toLocaleLowerCase()
  // Search looks through everything; the saved filters return when it clears.
  const appliedFilters = query ? emptyFilterList : activeFilters
  const noFavorites =
    appliedFilters.includes(favoriteInstancePickerFilter) &&
    !items.some((item) => item.favorite === true)
  const visibleItems = React.useMemo(
    () =>
      query
        ? items.filter((item) => matchesInstancePickerSearch(item, query))
        : filterInstancePickerItems(items, activeFilters),
    [activeFilters, items, query]
  )
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
  const filteredKind =
    activeTypeFilters.length === 1
      ? (activeTypeFilters[0]?.id as InstancePickerKind)
      : undefined
  // Search results span every type, so a type filter can't name them.
  const activeKind = query ? undefined : filteredKind
  // "View all" follows the top search result, then the type filter.
  const viewAllKind = query
    ? (visibleItems.find((item) => !isKilnIdentity(item.identity))?.identity
        .kind ?? filteredKind)
    : filteredKind
  const activeItem = visibleItems[activeItemIndex]
  // In a phone drawer the search field sits last, next to the keyboard, and
  // the list fills the drawer.
  const searchAtBottom = useDrawerPopoverIsDrawer()

  const searchBar = (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1.5 border-border/70 p-2",
        searchAtBottom ? "border-t" : "border-b"
      )}
    >
      <div className="relative min-w-0 flex-1">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          // On phones, wait for a tap so the keyboard doesn't cover the list.
          autoFocus={!searchAtBottom}
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
          className={cn(
            "bg-input/14 pr-2 pl-8",
            searchAtBottom ? "h-10" : "h-8 text-sm"
          )}
        />
      </div>
      {favoritesFilter ? (
        <InstancePickerToolButton
          active={favoritesOnly}
          label="Show favorites only"
          touch={searchAtBottom}
          onClick={toggleFavorites}
        >
          <Star
            className={cn(
              "size-3.5",
              favoritesOnly &&
                "fill-amber-400 text-amber-400 light:text-amber-500"
            )}
            aria-hidden="true"
          />
        </InstancePickerToolButton>
      ) : null}
      {typeFilters.length > 0 ? (
        <InstancePickerTypeMenu
          activeFilters={activeTypeFilters}
          filters={typeFilters}
          touch={searchAtBottom}
          onShowAll={showAllTypes}
          onToggle={toggleFilter}
        />
      ) : null}
    </div>
  )

  return (
    <>
      {searchAtBottom ? null : searchBar}
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
          className={cn(
            "overflow-y-auto overscroll-contain p-1.5",
            searchAtBottom ? "min-h-0" : "max-h-72"
          )}
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
          filtered={appliedFilters.length > 0 && items.length > 0}
          message={items.length === 0 ? emptyMessage : undefined}
          searching={query.length > 0}
          onClearFilters={noFavorites ? toggleFavorites : clearFilters}
        />
      )}
      {viewAll ? (
        <InstancePickerViewAll
          activeKind={viewAllKind}
          items={items}
          search={search.trim()}
          onNavigate={onNavigate}
        />
      ) : null}
      {searchAtBottom ? searchBar : null}
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

const kilnFavoriteKey = instanceFavoriteKey(kilnFavorite)

function instancePickerFavoriteKey(item: InstancePickerItem): string {
  return isKilnIdentity(item.identity)
    ? kilnFavoriteKey
    : instanceFavoriteKey(item.identity)
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
  "relative grid shrink-0 place-items-center rounded-md border border-border/70 text-muted-foreground transition-colors outline-none hover:bg-muted/55 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-muted/55 data-[state=open]:text-foreground"
const activeToolButtonClassName =
  "border-primary/45 bg-primary/8 text-primary-ink"
const toolButtonSize = (touch: boolean) => (touch ? "size-10" : "size-8")
// A tap moves focus to what it lands on, closing a phone's keyboard; cancelling
// it keeps the search field focused while filtering.
const keepSearchFocus = (event: React.SyntheticEvent | Event) =>
  event.preventDefault()
// Closing returns focus to the trigger; skip that while the search field still
// has it, but let a keyboard user who moved into the popover get it back.
const keepTypingFocus = (event: Event) => {
  if (document.activeElement instanceof HTMLInputElement) event.preventDefault()
}

const InstancePickerToolButton = React.memo(function InstancePickerToolButton({
  active,
  children,
  label,
  onClick,
  touch,
}: {
  active: boolean
  children: React.ReactNode
  label: string
  onClick: () => void
  /** Touch-sized, and leaves the search field focused. */
  touch: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        toolButtonClassName,
        toolButtonSize(touch),
        active && activeToolButtonClassName
      )}
      onClick={onClick}
      onMouseDown={touch ? keepSearchFocus : undefined}
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
  touch,
}: {
  activeFilters: ReadonlyArray<InstancePickerFilter>
  filters: ReadonlyArray<InstancePickerFilter>
  onShowAll: () => void
  onToggle: (filterId: string, checked: boolean) => void
  /**
   * For a search bar above a phone's keyboard: touch-sized, opens upward, and
   * leaves the search field focused so the keyboard stays open.
   */
  touch: boolean
}) {
  const filtered = activeFilters.length > 0
  const trigger = (
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
        toolButtonSize(touch),
        filtered && activeToolButtonClassName
      )}
      onMouseDown={touch ? keepSearchFocus : undefined}
    >
      <ListFilter className="size-3.5" aria-hidden="true" />
    </button>
  )

  // A menu moves focus into itself, which would close the keyboard; a popover
  // can open without taking focus.
  if (touch) {
    return (
      <Popover>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          aria-label="Filter by type"
          className="z-[80] w-48 p-1"
          onCloseAutoFocus={keepTypingFocus}
          onOpenAutoFocus={keepSearchFocus}
        >
          {filters.map((filter) => {
            const { Icon } = kindPresentation[filter.id as InstancePickerKind]
            const checked = activeFilters.includes(filter)
            return (
              <button
                key={filter.id}
                type="button"
                aria-pressed={checked}
                className={touchMenuItemClassName}
                onClick={() => onToggle(filter.id, !checked)}
                onMouseDown={keepSearchFocus}
              >
                <Icon className="size-4" aria-hidden="true" />
                {filter.label}
                {checked ? (
                  <Check
                    className="absolute right-2.5 size-4"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            )
          })}
          {filtered ? (
            <>
              <div className="-mx-1 my-1 h-px bg-border" />
              <button
                type="button"
                className={cn(touchMenuItemClassName, "text-muted-foreground")}
                onClick={onShowAll}
                onMouseDown={keepSearchFocus}
              >
                Show all types
              </button>
            </>
          ) : null}
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
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
              <Icon className="size-3.5" aria-hidden="true" />
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

const touchMenuItemClassName =
  "type-menu relative flex h-10 w-full items-center gap-2 rounded-md pr-9 pl-2.5 text-left outline-none select-none active:bg-popover-accent active:text-popover-accent-foreground focus-visible:bg-popover-accent"

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
      <InstanceCard
        className="min-w-0 flex-1 gap-2"
        iconClassName="border-0 bg-muted/55"
        instance={item.identity}
        meta={item.meta}
        metaClassName="font-mono"
        name={item.name}
        nameClassName="type-control-sm"
        status={item.status}
        statusClassName="ring-popover"
      />
      {pending ? (
        <LoaderCircle
          className="size-3.5 shrink-0 animate-spin text-primary-ink"
          aria-hidden="true"
        />
      ) : showKind ? (
        <span className="shrink-0 text-muted-foreground/70 light:text-muted-foreground/85">
          {isKilnIdentity(item.identity) ? (
            <HearthMark className="size-3.5 text-current" />
          ) : (
            <kind.Icon className="size-3.5" aria-hidden="true" />
          )}
          <span className="sr-only">
            {isKilnIdentity(item.identity) ? "Kiln" : kind.label}
          </span>
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
            ? "border-primary text-primary-ink"
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
  { Icon: React.ComponentType<LucideProps>; label: string }
> = {
  all: { Icon: Layers, label: "All instances" },
  app: { Icon: AppKindIcon, label: "All Apps" },
  database: { Icon: DatabaseKindIcon, label: "All databases" },
  relay: { Icon: RelayKindIcon, label: "All Relays" },
  server: { Icon: ServerKindIcon, label: "All game servers" },
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
  app: { label: "View all apps", to: "/infra/apps" },
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
  // Kiln shows as a Relay, but isn't one to list.
  const kind =
    activeKind ??
    items.find((item) => !isKilnIdentity(item.identity))?.identity.kind ??
    "server"
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
        <Icon className="size-3.5" aria-hidden="true" />
        <span>{destination.label}</span>
        <ArrowRight
          className="ml-auto size-3.5 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5"
          aria-hidden="true"
        />
      </Link>
    </div>
  )
})
