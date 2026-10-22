import * as React from "react"
import { useLiveSuspenseQuery } from "@tanstack/react-db"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { sortFn_basic } from "@tanstack/react-table"
import {
  Bot,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleGauge,
  EllipsisVertical,
  FileClock,
  FolderClock,
  KeyRound,
  ListFilter,
  Network,
  RefreshCw,
  TerminalSquare,
  UserRound,
  X,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { cn } from "@workspace/ui/lib/utils"

import { CopyIdentifierMenuItem } from "@/components/copy-identifier-menu-item"
import {
  DataTableActionGroup,
  DataTableEmptyState,
} from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import { IdentityName } from "@/components/identity-name"
import { InfraSyncButton } from "@/components/infra-sync-button"
import { InstanceCard, type InstanceIdentity } from "@/components/instance-card"
import { RelayKindIcon, ServerKindIcon } from "@/components/instance-kind-icon"
import { RelativeTime } from "@/components/relative-time"
import {
  ServerScopePicker,
  type ServerPickerOption,
} from "@/components/server-scope-picker"
import { UserIdentity } from "@/components/user-identity"
import { UserProfilesContext } from "@/components/user-table-parts"
import {
  activityLocalRangeToUtc,
  activityTypes,
  isActivitySource,
  isActivityType,
} from "@/lib/activity"
import type {
  ActivityScopeKind,
  ActivitySource,
  ActivityType,
} from "@/lib/activity"
import {
  infraAppsCollectionOptions,
  infraDatabasesCollectionOptions,
  infraServersCollectionOptions,
} from "@/lib/collections/infra-directories"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import {
  createDataTableSearchStore,
  type DataTableSearchStore,
} from "@/lib/data-table-search"
import type { DataTableSource } from "@/lib/data-table-source"
import {
  accessCapabilitiesQueryOptions,
  activityQueryOptions,
} from "@/lib/query-options"
import { relayInstanceRouteId } from "@/lib/relay-fleet"
import type { ActivityData, ActivityEntry } from "@/server/activity"
import { getUserMinecraftProfiles } from "@/server/users"

export interface ActivityFilters {
  app?: string
  database?: string
  from?: string
  q?: string
  relay?: string
  /** Every instance of one kind, from the scope picker's kind groups. */
  scope?: ActivityScopeKind
  server?: string
  source?: ActivitySource
  to?: string
  type?: ActivityType
  user?: string
}

interface ActivityPageProps {
  initialData: ActivityData
  filterStore: ActivityFiltersStore
  onFiltersChange: (change: Partial<ActivityFilters>) => void
}

export type ActivityFiltersStore = ReturnType<typeof createActivityFiltersStore>

export function createActivityFiltersStore(initialFilters: ActivityFilters) {
  let filters = initialFilters
  const listeners = new Set<() => void>()
  const activeCountListeners = new Set<() => void>()
  const dateListeners = new Set<() => void>()
  const fieldListeners = new Map<keyof ActivityFilters, Set<() => void>>()

  const subscribeToSet = (
    targetListeners: Set<() => void>,
    listener: () => void
  ) => {
    targetListeners.add(listener)
    return () => {
      targetListeners.delete(listener)
    }
  }

  return {
    getActiveCountSnapshot: () => activityFilterCount(filters),
    getFieldSnapshot: <Key extends keyof ActivityFilters>(key: Key) =>
      filters[key],
    getSnapshot: () => filters,
    setFilters: (nextFilters: ActivityFilters) => {
      if (filters === nextFilters) return
      const previousFilters = filters
      filters = nextFilters

      for (const [key, targetListeners] of fieldListeners) {
        if (previousFilters[key] !== nextFilters[key]) {
          for (const listener of targetListeners) listener()
        }
      }
      if (
        previousFilters.from !== nextFilters.from ||
        previousFilters.to !== nextFilters.to
      ) {
        for (const listener of dateListeners) listener()
      }
      if (
        activityFilterCount(previousFilters) !==
        activityFilterCount(nextFilters)
      ) {
        for (const listener of activeCountListeners) listener()
      }
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => subscribeToSet(listeners, listener),
    subscribeActiveCount: (listener: () => void) =>
      subscribeToSet(activeCountListeners, listener),
    subscribeDate: (listener: () => void) =>
      subscribeToSet(dateListeners, listener),
    subscribeField: (key: keyof ActivityFilters, listener: () => void) => {
      const targetListeners = fieldListeners.get(key) ?? new Set<() => void>()
      targetListeners.add(listener)
      fieldListeners.set(key, targetListeners)
      return () => {
        targetListeners.delete(listener)
        if (targetListeners.size === 0) fieldListeners.delete(key)
      }
    },
  }
}

type ActivityDataStore = ReturnType<typeof createActivityDataStore>

// The parts of the activity response the controls around the table read, so
// a refetch repaints a control only when its part changed.
function createActivityDataStore(initialData: ActivityData) {
  let data = initialData
  let actors = activityActors(initialData)
  let actorsVersion = 0
  let relayVersion = 0
  let statusVersion = 0
  const actorsListeners = new Set<() => void>()
  const relayListeners = new Set<() => void>()
  const statusListeners = new Set<() => void>()
  const subscribe = (listeners: Set<() => void>, listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return {
    getActors: () => actors,
    getActorsSnapshot: () => actorsVersion,
    getData: () => data,
    getRelaySnapshot: () => relayVersion,
    getStatusSnapshot: () => statusVersion,
    setData: (nextData: ActivityData) => {
      if (data === nextData) return
      const previousData = data
      const nextActors = activityActors(nextData)
      const actorsChanged = !activityActorArraysEqual(actors, nextActors)
      const relaysChanged = !activityRelayArraysEqual(
        previousData.relays,
        nextData.relays
      )
      const statusChanged =
        relaysChanged ||
        !stringArraysEqual(
          previousData.truncatedRelayIds,
          nextData.truncatedRelayIds
        )

      data = nextData
      actors = nextActors
      if (actorsChanged) {
        actorsVersion += 1
        for (const listener of actorsListeners) listener()
      }
      if (relaysChanged) {
        relayVersion += 1
        for (const listener of relayListeners) listener()
      }
      if (statusChanged) {
        statusVersion += 1
        for (const listener of statusListeners) listener()
      }
    },
    subscribeActors: (listener: () => void) =>
      subscribe(actorsListeners, listener),
    subscribeRelay: (listener: () => void) =>
      subscribe(relayListeners, listener),
    subscribeStatus: (listener: () => void) =>
      subscribe(statusListeners, listener),
  }
}

const typeDetails: Record<
  ActivityType,
  { icon: React.ComponentType<{ className?: string }>; label: string }
> = {
  server: { icon: ServerKindIcon, label: "Game Server" },
  power: { icon: CircleGauge, label: "Power" },
  console: { icon: TerminalSquare, label: "Console" },
  files: { icon: FolderClock, label: "Files" },
  network: { icon: Network, label: "Network" },
  access: { icon: KeyRound, label: "Access" },
  relay: { icon: RelayKindIcon, label: "Relay" },
  updates: { icon: RefreshCw, label: "Updates" },
  system: { icon: FileClock, label: "System" },
}

const activityShortDate = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
})

const activityCalendarMonth = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
})

const activityCalendarDay = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "long",
  weekday: "long",
  year: "numeric",
})

const activityCalendarWeekdays = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]

const activitySearchDelayMs = 180

export const ActivityPage = React.memo(function ActivityPage({
  initialData,
  filterStore,
  onFiltersChange,
}: ActivityPageProps) {
  const [dataStore] = React.useState(() => createActivityDataStore(initialData))
  const [searchStore] = React.useState(() =>
    createDataTableSearchStore(filterStore.getSnapshot().q ?? "")
  )
  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-3 pt-3 pb-3 sm:px-5 sm:pt-5 sm:pb-5">
      <ActivityDataBridge
        dataStore={dataStore}
        filterStore={filterStore}
        searchStore={searchStore}
      />
      <ActivityScopeController
        dataStore={dataStore}
        filterStore={filterStore}
        onFiltersChange={onFiltersChange}
      />
      <DataTableWorkspace
        toolbar={
          <ActivityToolbar
            dataStore={dataStore}
            filterStore={filterStore}
            searchStore={searchStore}
            onFiltersChange={onFiltersChange}
          />
        }
      >
        <ActivityStatusController dataStore={dataStore} />
        <ActivityActorProfiles dataStore={dataStore}>
          <ActivityTable filterStore={filterStore} searchStore={searchStore} />
        </ActivityActorProfiles>
      </DataTableWorkspace>
    </div>
  )
})

const ActivityDataBridge = React.memo(function ActivityDataBridge({
  dataStore,
  filterStore,
  searchStore,
}: {
  dataStore: ActivityDataStore
  filterStore: ActivityFiltersStore
  searchStore: DataTableSearchStore
}) {
  const data = useActivityData(filterStore)
  React.useLayoutEffect(() => {
    if (data) dataStore.setData(data)
  }, [data, dataStore])
  // Follow a search set from outside the input, such as Clear or a link.
  // Typing reaches `q` trimmed, so compare trimmed to keep trailing spaces.
  const query = useActivityFilterValue(filterStore, "q") ?? ""
  React.useLayoutEffect(() => {
    if (searchStore.getSnapshot().trim() !== query) searchStore.set(query)
  }, [query, searchStore])
  return null
})

const ActivityToolbar = React.memo(function ActivityToolbar({
  dataStore,
  filterStore,
  searchStore,
  onFiltersChange,
}: {
  dataStore: ActivityDataStore
  filterStore: ActivityFiltersStore
  searchStore: DataTableSearchStore
  onFiltersChange: (change: Partial<ActivityFilters>) => void
}) {
  // The table filters as you type; the URL trails behind.
  const searchTimer = React.useRef<number>(undefined)
  React.useEffect(() => () => window.clearTimeout(searchTimer.current), [])
  const search = React.useMemo(
    () => ({
      ariaLabel: "Search activity",
      closeMobileWhenEmpty: true,
      id: "activity-search",
      placeholder: "Search actions, people, instances…",
      store: searchStore,
      onValueChange: (value: string) => {
        window.clearTimeout(searchTimer.current)
        searchTimer.current = window.setTimeout(() => {
          onFiltersChange({ q: value.trim() || undefined })
        }, activitySearchDelayMs)
      },
    }),
    [onFiltersChange, searchStore]
  )
  return (
    <DataTableToolbar
      controls={
        <>
          <ActivityFiltersMenu
            dataStore={dataStore}
            filterStore={filterStore}
            onFiltersChange={onFiltersChange}
          />
          <ActivityDateRangeController
            filterStore={filterStore}
            onChange={onFiltersChange}
          />
          <ActivityClearFilters
            filterStore={filterStore}
            onFiltersChange={onFiltersChange}
          />
        </>
      }
      leading={<ActivitySyncButtonController filterStore={filterStore} />}
      search={search}
    />
  )
})

// Type, source, and user share one menu so the toolbar fits a phone.
const ActivityFiltersMenu = React.memo(function ActivityFiltersMenu({
  dataStore,
  filterStore,
  onFiltersChange,
}: {
  dataStore: ActivityDataStore
  filterStore: ActivityFiltersStore
  onFiltersChange: (change: Partial<ActivityFilters>) => void
}) {
  const type = useActivityFilterValue(filterStore, "type")
  const source = useActivityFilterValue(filterStore, "source")
  const user = useActivityFilterValue(filterStore, "user")
  const count = [type, source, user].filter(Boolean).length
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label="Filter activity"
          type="button"
          variant={count ? "secondary" : "outline"}
        >
          <ListFilter />
          <span className="hidden lg:inline">Filters</span>
          {count ? (
            <Badge variant="outline" className="type-meta h-4 px-1 font-mono">
              {count}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="grid w-64 gap-3 p-3"
      >
        <ActivityFilterField label="Type">
          <ActivityTypeFilter
            filterStore={filterStore}
            onFiltersChange={onFiltersChange}
          />
        </ActivityFilterField>
        <ActivityFilterField label="Source">
          <ActivitySourceFilter
            filterStore={filterStore}
            onFiltersChange={onFiltersChange}
          />
        </ActivityFilterField>
        <ActivityFilterField label="User">
          <ActivityUserFilter
            dataStore={dataStore}
            filterStore={filterStore}
            onFiltersChange={onFiltersChange}
          />
        </ActivityFilterField>
      </PopoverContent>
    </Popover>
  )
})

function ActivityFilterField({
  children,
  label,
}: {
  children: React.ReactNode
  label: string
}) {
  return (
    <div className="grid gap-1.5">
      <span className="type-technical-label text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  )
}

const ActivityTypeFilter = React.memo(function ActivityTypeFilter({
  filterStore,
  onFiltersChange,
}: {
  filterStore: ActivityFiltersStore
  onFiltersChange: (change: Partial<ActivityFilters>) => void
}) {
  const value = useActivityFilterValue(filterStore, "type") ?? ""
  const update = React.useCallback(
    (nextValue: string) =>
      onFiltersChange({
        type: isActivityType(nextValue) ? nextValue : undefined,
      }),
    [onFiltersChange]
  )
  return (
    <ActivitySelect
      ariaLabel="Filter activity by type"
      icon={<ListFilter />}
      value={value}
      onChange={update}
    >
      <SelectItem value={allActivityFiltersValue}>All types</SelectItem>
      {activityTypes.map((type) => (
        <SelectItem key={type} value={type}>
          {typeDetails[type].label}
        </SelectItem>
      ))}
    </ActivitySelect>
  )
})

const ActivitySourceFilter = React.memo(function ActivitySourceFilter({
  filterStore,
  onFiltersChange,
}: {
  filterStore: ActivityFiltersStore
  onFiltersChange: (change: Partial<ActivityFilters>) => void
}) {
  const value = useActivityFilterValue(filterStore, "source") ?? ""
  const update = React.useCallback(
    (nextValue: string) =>
      onFiltersChange({
        source: isActivitySource(nextValue) ? nextValue : undefined,
      }),
    [onFiltersChange]
  )
  return (
    <ActivitySelect
      ariaLabel="Filter activity by source"
      icon={<Bot />}
      value={value}
      onChange={update}
    >
      <SelectItem value={allActivityFiltersValue}>All sources</SelectItem>
      <SelectItem value="web">Web</SelectItem>
      <SelectItem value="cli">CLI</SelectItem>
    </ActivitySelect>
  )
})

const ActivityUserFilter = React.memo(function ActivityUserFilter({
  dataStore,
  filterStore,
  onFiltersChange,
}: {
  dataStore: ActivityDataStore
  filterStore: ActivityFiltersStore
  onFiltersChange: (change: Partial<ActivityFilters>) => void
}) {
  React.useSyncExternalStore(
    dataStore.subscribeActors,
    dataStore.getActorsSnapshot,
    dataStore.getActorsSnapshot
  )
  const value = useActivityFilterValue(filterStore, "user") ?? ""
  const actors = dataStore.getActors()
  const update = React.useCallback(
    (nextValue: string) => onFiltersChange({ user: nextValue || undefined }),
    [onFiltersChange]
  )
  return (
    <ActivitySelect
      ariaLabel="Filter activity by user"
      icon={<UserRound />}
      value={value}
      onChange={update}
    >
      <SelectItem value={allActivityFiltersValue}>All users</SelectItem>
      {actors.map((actor) => (
        <SelectItem key={actor.id} value={actor.id}>
          {actor.name}
        </SelectItem>
      ))}
    </ActivitySelect>
  )
})

const clearedActivityFilters: {
  [Key in keyof Required<ActivityFilters>]: undefined
} = {
  app: undefined,
  database: undefined,
  from: undefined,
  q: undefined,
  relay: undefined,
  scope: undefined,
  server: undefined,
  source: undefined,
  to: undefined,
  type: undefined,
  user: undefined,
}

const ActivityClearFilters = React.memo(function ActivityClearFilters({
  filterStore,
  onFiltersChange,
}: {
  filterStore: ActivityFiltersStore
  onFiltersChange: (change: Partial<ActivityFilters>) => void
}) {
  const activeFilterCount = React.useSyncExternalStore(
    filterStore.subscribeActiveCount,
    filterStore.getActiveCountSnapshot,
    filterStore.getActiveCountSnapshot
  )
  if (activeFilterCount === 0) return null
  return (
    <Button
      aria-label={`Clear ${activeFilterCount} ${activeFilterCount === 1 ? "filter" : "filters"}`}
      type="button"
      size="sm"
      variant="ghost"
      onClick={() => onFiltersChange(clearedActivityFilters)}
    >
      <X />
      <span className="hidden sm:inline">Clear {activeFilterCount}</span>
    </Button>
  )
})

type ActivityScopeOption = ServerPickerOption<ActivityScopeKind>

const clearedActivityScope = {
  app: undefined,
  database: undefined,
  relay: undefined,
  scope: undefined,
  server: undefined,
} satisfies Partial<ActivityFilters>

// Every instance the person can see, like Backups: a Relay shows everything
// on it, an instance shows its own activity, and a kind group every instance
// of that kind.
const ActivityScopeController = React.memo(function ActivityScopeController({
  dataStore,
  filterStore,
  onFiltersChange,
}: {
  dataStore: ActivityDataStore
  filterStore: ActivityFiltersStore
  onFiltersChange: (change: Partial<ActivityFilters>) => void
}) {
  React.useSyncExternalStore(
    dataStore.subscribeRelay,
    dataStore.getRelaySnapshot,
    dataStore.getRelaySnapshot
  )
  const relays = dataStore.getData().relays
  const { data: servers } = useLiveSuspenseQuery({
    query: (query) =>
      query
        .from({ server: infraServersCollectionOptions })
        .orderBy(({ server }) => server.name),
  })
  const { data: apps } = useLiveSuspenseQuery({
    query: (query) =>
      query
        .from({ app: infraAppsCollectionOptions })
        .orderBy(({ app }) => app.name),
  })
  const { data: databases } = useLiveSuspenseQuery({
    query: (query) =>
      query
        .from({ database: infraDatabasesCollectionOptions })
        .orderBy(({ database }) => database.name),
  })
  const options = React.useMemo(
    (): Array<ActivityScopeOption> => [
      ...relays.map((relay): ActivityScopeOption => ({
        id: relay.id,
        kind: "relay",
        name: relay.name,
        relayId: relay.id,
        relayName: relay.name,
      })),
      ...servers.map((server): ActivityScopeOption => ({
        id: server.id,
        kind: "server",
        name: server.name,
        relayId: server.relayId,
        relayName: server.relayName,
      })),
      ...apps.map((app): ActivityScopeOption => ({
        id: app.id,
        kind: "app",
        name: app.name,
        relayId: app.relayId,
        relayName: app.relayName,
      })),
      ...databases.map((database): ActivityScopeOption => ({
        id: database.id,
        kind: "database",
        name: database.name,
        relayId: database.relayId,
        relayName: database.relayName,
      })),
    ],
    [apps, databases, relays, servers]
  )
  const scope = useActivityFilterValue(filterStore, "scope") ?? null
  const relay = useActivityFilterValue(filterStore, "relay")
  const server = useActivityFilterValue(filterStore, "server")
  const app = useActivityFilterValue(filterStore, "app")
  const database = useActivityFilterValue(filterStore, "database")
  const selected = React.useMemo(() => {
    const [selectedKind, id] = server
      ? (["server", server] as const)
      : app
        ? (["app", app] as const)
        : database
          ? (["database", database] as const)
          : relay
            ? (["relay", relay] as const)
            : [null, null]
    if (!selectedKind) return null
    return (
      options.find(
        (option) =>
          option.kind === selectedKind &&
          option.id === id &&
          (!relay || option.relayId === relay)
      ) ?? null
    )
  }, [app, database, options, relay, server])
  const select = React.useCallback(
    (option: ActivityScopeOption | null) => {
      if (!option) return onFiltersChange(clearedActivityScope)
      onFiltersChange({
        ...clearedActivityScope,
        relay: option.relayId,
        ...(option.kind === "relay"
          ? {}
          : { [option.kind ?? "server"]: option.id }),
      })
    },
    [onFiltersChange]
  )
  const selectKind = React.useCallback(
    (nextKind: ActivityScopeKind) =>
      onFiltersChange({ ...clearedActivityScope, scope: nextKind }),
    [onFiltersChange]
  )

  return (
    <ServerScopePicker<ActivityScopeKind>
      allLabel="All instances"
      ariaLabel="Accessible instances"
      changeLabel="Change scope"
      chooseLabel="Choose scope"
      emptyMessage="No accessible instances found."
      selectedKind={selected ? null : scope}
      selectedServer={selected}
      servers={options}
      onSelect={select}
      onSelectKind={selectKind}
    />
  )
})

const ActivitySyncButtonController = React.memo(
  function ActivitySyncButtonController({
    filterStore,
  }: {
    filterStore: ActivityFiltersStore
  }) {
    const { from, to } = useActivityDateFilters(filterStore)
    return <ActivitySyncButton from={from} to={to} />
  }
)

const ActivityDateRangeController = React.memo(
  function ActivityDateRangeController({
    filterStore,
    onChange,
  }: {
    filterStore: ActivityFiltersStore
    onChange: (change: Partial<ActivityFilters>) => void
  }) {
    const { from, to } = useActivityDateFilters(filterStore)
    return <ActivityDateRange from={from} to={to} onChange={onChange} />
  }
)

const ActivitySyncButton = React.memo(function ActivitySyncButton({
  from,
  to,
}: {
  from?: string
  to?: string
}) {
  const { refetch } = useQuery({
    ...activityQueryOptions(from, to),
    notifyOnChangeProps: [],
  })
  const sync = React.useCallback(() => refetch(), [refetch])
  return <InfraSyncButton label="Sync activity" sync={sync} />
})

const allActivityFiltersValue = "__all_activity_filters__"

function ActivitySelect({
  ariaLabel,
  children,
  icon,
  onChange,
  value,
}: {
  ariaLabel: string
  children: React.ReactNode
  icon: React.ReactNode
  onChange: (value: string) => void
  value: string
}) {
  return (
    <Select
      value={value || allActivityFiltersValue}
      onValueChange={(nextValue) =>
        onChange(nextValue === allActivityFiltersValue ? "" : nextValue)
      }
    >
      <SelectTrigger
        aria-label={ariaLabel}
        className="h-8 w-full min-w-0 gap-1.5 px-2 text-left text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:flex-1 [&_[data-slot=select-value]]:truncate [&_[data-slot=select-value]]:whitespace-nowrap"
      >
        <span className="shrink-0 text-muted-foreground [&_svg]:size-3.5">
          {icon}
        </span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="w-max min-w-(--radix-select-trigger-width)">
        {children}
      </SelectContent>
    </Select>
  )
}

type ActivityDateRangeValue = { from: Date | undefined; to?: Date } | undefined
type ActivityDateBoundary = "from" | "to"

const ActivityDateRange = React.memo(function ActivityDateRange({
  from,
  to,
  onChange,
}: {
  from?: string
  to?: string
  onChange: (range: Pick<ActivityFilters, "from" | "to">) => void
}) {
  const [open, setOpen] = React.useState(false)
  const maximumDate = React.useMemo(() => {
    const date = new Date()
    date.setHours(23, 59, 59, 999)
    return date
  }, [])
  const [store] = React.useState(() =>
    createActivityDatePickerStore(
      selectedDateRange(from, to),
      maximumDate,
      onChange
    )
  )
  const calendarElement = React.useRef<HTMLDivElement>(null)
  const weekWheel = React.useRef<{ delta: number; resetTimer?: number }>({
    delta: 0,
  })

  React.useLayoutEffect(() => store.setOnChange(onChange), [onChange, store])

  const handleCalendarWheel = React.useCallback(
    (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY === 0) return

      event.preventDefault()
      const wheel = weekWheel.current
      if (wheel.resetTimer) window.clearTimeout(wheel.resetTimer)
      wheel.resetTimer = window.setTimeout(() => {
        wheel.delta = 0
        wheel.resetTimer = undefined
      }, 120)

      const multiplier =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1
      wheel.delta += event.deltaY * multiplier
      if (Math.abs(wheel.delta) < 8) return

      store.shiftWeeks(wheel.delta > 0 ? 1 : -1)
      wheel.delta = 0
    },
    [store]
  )

  const setCalendarRef = React.useCallback(
    (calendar: HTMLDivElement | null) => {
      calendarElement.current?.removeEventListener("wheel", handleCalendarWheel)
      calendarElement.current = calendar
      calendar?.addEventListener("wheel", handleCalendarWheel, {
        passive: false,
      })
    },
    [handleCalendarWheel]
  )

  React.useEffect(() => {
    const wheel = weekWheel.current
    return () => {
      if (wheel.resetTimer) {
        window.clearTimeout(wheel.resetTimer)
      }
    }
  }, [])

  const updateOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        store.open(selectedDateRange(from, to))
      }
      setOpen(nextOpen)
    },
    [from, store, to]
  )

  return (
    <Popover open={open} onOpenChange={updateOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          data-empty={!from && !to}
          className="justify-start font-normal data-[empty=true]:text-muted-foreground"
        >
          <CalendarDays />
          <span className="max-w-44 truncate" suppressHydrationWarning>
            {dateRangeLabel(from, to)}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[17rem] max-w-[calc(100vw-1.5rem)] overflow-hidden p-0"
      >
        <ActivityDatePickerContent
          calendarRef={setCalendarRef}
          maximumDate={maximumDate}
          store={store}
        />
      </PopoverContent>
    </Popover>
  )
})

type ActivityDatePickerStore = ReturnType<typeof createActivityDatePickerStore>

const activityDaySelectedStart = 1
const activityDaySelectedEnd = 2
const activityDaySelectedMiddle = 4
const activityDateBoundaries: ReadonlyArray<ActivityDateBoundary> = [
  "from",
  "to",
]

const ActivityDatePickerContent = React.memo(
  function ActivityDatePickerContent({
    calendarRef,
    maximumDate,
    store,
  }: {
    calendarRef: React.RefCallback<HTMLDivElement>
    maximumDate: Date
    store: ActivityDatePickerStore
  }) {
    return (
      <>
        <div className="grid grid-cols-2 border-b bg-background/20">
          <ActivityDateBoundaryButton boundary="from" store={store} />
          <ActivityDateBoundaryButton boundary="to" store={store} />
        </div>

        <ActivityWeekCalendar
          calendarRef={calendarRef}
          maximumDate={maximumDate}
          store={store}
        />

        <div className="flex items-center gap-1.5 border-t bg-background/30 p-2">
          {[7, 30, 90].map((days) => (
            <ActivityDatePresetButton days={days} key={days} store={store} />
          ))}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto text-muted-foreground"
            onClick={store.reset}
          >
            Reset
          </Button>
        </div>
      </>
    )
  }
)

const ActivityDateBoundaryButton = React.memo(
  function ActivityDateBoundaryButton({
    boundary,
    store,
  }: {
    boundary: ActivityDateBoundary
    store: ActivityDatePickerStore
  }) {
    const subscribe = React.useCallback(
      (listener: () => void) => store.subscribeBoundary(boundary, listener),
      [boundary, store]
    )
    const getSnapshot = React.useCallback(
      () => store.getBoundarySnapshot(boundary),
      [boundary, store]
    )
    const snapshot = React.useSyncExternalStore(
      subscribe,
      getSnapshot,
      getSnapshot
    )
    const active = snapshot.startsWith("1:")
    const date = store.getBoundaryDate(boundary)
    const label = boundary === "from" ? "Start" : "End"

    return (
      <button
        type="button"
        aria-pressed={active}
        className="relative min-w-0 border-l border-border/65 px-3 py-2.5 text-left first:border-l-0 hover:bg-accent/35"
        onClick={() => store.setBoundary(boundary)}
      >
        <span className="type-technical-label block text-muted-foreground">
          {label}
        </span>
        <span className="mt-1 block truncate text-xs font-medium text-foreground">
          {date ? formatShortDate(date) : "Choose date"}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-x-3 bottom-0 h-px bg-primary transition-opacity",
            active ? "opacity-100" : "opacity-0"
          )}
        />
      </button>
    )
  }
)

const ActivityDatePresetButton = React.memo(function ActivityDatePresetButton({
  days,
  store,
}: {
  days: number
  store: ActivityDatePickerStore
}) {
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribePreset(days, listener),
    [days, store]
  )
  const getSnapshot = React.useCallback(
    () => store.getPresetSnapshot(days),
    [days, store]
  )
  const pressed = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot
  )

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      aria-pressed={pressed}
      className="type-meta font-mono tracking-[0.04em] aria-pressed:border-primary/30 aria-pressed:bg-primary/10 aria-pressed:text-primary-ink"
      onClick={() => store.selectRecentRange(days)}
    >
      {days} days
    </Button>
  )
})

const ActivityWeekCalendar = React.memo(function ActivityWeekCalendar({
  calendarRef,
  maximumDate,
  store,
}: {
  calendarRef: React.RefCallback<HTMLDivElement>
  maximumDate: Date
  store: ActivityDatePickerStore
}) {
  const visibleWeekStartValue = React.useSyncExternalStore(
    store.subscribeVisibleWeek,
    store.getVisibleWeekStartSnapshot,
    store.getVisibleWeekStartSnapshot
  )
  const visibleWeekStart = React.useMemo(
    () => new Date(visibleWeekStartValue),
    [visibleWeekStartValue]
  )
  const days = React.useMemo(
    () => localCalendarDays(visibleWeekStart, 42),
    [visibleWeekStart]
  )
  const displayMonth = React.useMemo(() => mostVisibleMonth(days), [days])
  const maximumWeekStartValue = React.useMemo(
    () => startOfLocalWeek(startOfLocalMonth(maximumDate)).getTime(),
    [maximumDate]
  )
  const today = React.useMemo(() => new Date(), [])
  const tabbableDayValue = React.useMemo(() => {
    const preferredDate = [
      store.getBoundaryDate("from"),
      store.getBoundaryDate("to"),
      today,
    ].find(
      (candidate) =>
        candidate &&
        !isLocalDayAfter(candidate, maximumDate) &&
        days.some((date) => isSameLocalDay(date, candidate))
    )
    const fallbackDate = days.find(
      (date) => !isLocalDayAfter(date, maximumDate)
    )
    return localDayValue(preferredDate ?? fallbackDate ?? days[0])
  }, [days, maximumDate, store, today])

  return (
    <div
      ref={calendarRef}
      role="group"
      data-activity-calendar
      className="touch-pan-y overscroll-contain px-2 pt-1.5 pb-2 sm:pt-2 sm:pb-2.5"
      aria-label="Date range calendar. Scroll to move by week."
    >
      <div className="flex h-7 items-center justify-between sm:h-8">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Show previous month"
          onClick={() => store.shiftMonths(-1)}
        >
          <ChevronLeft />
        </Button>
        <span
          role="status"
          aria-live="polite"
          className="type-label font-mono tracking-[0.04em]"
        >
          {activityCalendarMonth.format(displayMonth)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Show next month"
          disabled={visibleWeekStartValue >= maximumWeekStartValue}
          onClick={() => store.shiftMonths(1)}
        >
          <ChevronRight />
        </Button>
      </div>

      <div
        aria-hidden="true"
        className="mt-1 mb-1.5 grid grid-cols-7 text-center"
      >
        {activityCalendarWeekdays.map((weekday) => (
          <span
            key={weekday}
            className="type-label font-mono tracking-[0.08em] text-muted-foreground"
          >
            {weekday}
          </span>
        ))}
      </div>

      <div
        role="grid"
        aria-label={activityCalendarMonth.format(displayMonth)}
        className="grid grid-cols-7 gap-y-0.5 overflow-hidden sm:gap-y-1"
      >
        {Array.from({ length: 6 }, (_, weekIndex) => (
          <div
            role="row"
            className="contents"
            key={days[weekIndex * 7]?.getTime()}
          >
            {days.slice(weekIndex * 7, weekIndex * 7 + 7).map((date) => (
              <ActivityCalendarDay
                date={date}
                disabled={isLocalDayAfter(date, maximumDate)}
                isToday={isSameLocalDay(date, today)}
                key={date.getTime()}
                maximumDate={maximumDate}
                outside={!isSameLocalMonth(date, displayMonth)}
                store={store}
                tabbable={localDayValue(date) === tabbableDayValue}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
})

const ActivityCalendarDay = React.memo(function ActivityCalendarDay({
  date,
  disabled,
  isToday,
  maximumDate,
  outside,
  store,
  tabbable,
}: {
  date: Date
  disabled: boolean
  isToday: boolean
  maximumDate: Date
  outside: boolean
  store: ActivityDatePickerStore
  tabbable: boolean
}) {
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribeDay(date, listener),
    [date, store]
  )
  const getSnapshot = React.useCallback(
    () => store.getDaySnapshot(date),
    [date, store]
  )
  const selection = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot
  )
  const selectedEndpoint =
    (selection & (activityDaySelectedStart | activityDaySelectedEnd)) !== 0
  const selectedMiddle = (selection & activityDaySelectedMiddle) !== 0
  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const offset =
        event.key === "ArrowLeft"
          ? -1
          : event.key === "ArrowRight"
            ? 1
            : event.key === "ArrowUp"
              ? -7
              : event.key === "ArrowDown"
                ? 7
                : event.key === "Home"
                  ? -date.getDay()
                  : event.key === "End"
                    ? 6 - date.getDay()
                    : undefined
      if (offset === undefined) return

      event.preventDefault()
      const targetDate = addLocalDays(date, offset)
      if (isLocalDayAfter(targetDate, maximumDate)) return
      const calendar = event.currentTarget.closest<HTMLElement>(
        "[data-activity-calendar]"
      )
      if (!calendar) return
      if (focusActivityCalendarDay(calendar, targetDate)) return

      store.shiftWeeks(offset < 0 ? -1 : 1)
      window.setTimeout(() => {
        focusActivityCalendarDay(calendar, targetDate)
      }, 0)
    },
    [date, maximumDate, store]
  )

  return (
    <button
      type="button"
      role="gridcell"
      aria-label={activityCalendarDay.format(date)}
      aria-selected={selection !== 0}
      data-activity-calendar-day={localDayValue(date)}
      disabled={disabled}
      tabIndex={tabbable ? 0 : -1}
      className={cn(
        "type-label relative isolate grid h-7 min-w-0 place-items-center border border-transparent font-mono transition-colors outline-none focus-visible:z-10 focus-visible:border-ring/75 focus-visible:ring-2 focus-visible:ring-ring/40 sm:h-8",
        "hover:bg-accent/70 hover:text-foreground",
        outside && "text-muted-foreground/35",
        isToday && "border-primary/45",
        selectedMiddle && "bg-primary/10 text-foreground",
        selectedEndpoint &&
          "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
        disabled && "pointer-events-none text-muted-foreground/20 opacity-50"
      )}
      onFocus={setActivityCalendarTabStop}
      onKeyDown={handleKeyDown}
      onClick={() => store.selectDay(date)}
    >
      {date.getDate()}
    </button>
  )
})

function setActivityCalendarTabStop(
  event: React.FocusEvent<HTMLButtonElement>
): void {
  const calendar = event.currentTarget.closest<HTMLElement>(
    "[data-activity-calendar]"
  )
  if (!calendar) return
  for (const button of calendar.querySelectorAll<HTMLButtonElement>(
    "button[data-activity-calendar-day]"
  )) {
    button.tabIndex = button === event.currentTarget ? 0 : -1
  }
}

function focusActivityCalendarDay(calendar: HTMLElement, date: Date): boolean {
  const target = calendar.querySelector<HTMLButtonElement>(
    `button[data-activity-calendar-day="${localDayValue(date)}"]`
  )
  if (!target || target.disabled) return false
  target.focus()
  return true
}

const ActivityStatus = React.memo(function ActivityStatus({
  data,
}: {
  data: ActivityData
}) {
  const unavailable = data.relays.filter((relay) => relay.unavailable)
  if (unavailable.length === 0 && data.truncatedRelayIds.length === 0) {
    return null
  }
  return (
    <div
      role="status"
      className="type-meta shrink-0 border-b border-primary/15 bg-primary/6 px-3 py-2 font-mono text-muted-foreground"
    >
      {unavailable.length > 0
        ? `Could not reach ${unavailable.map((relay) => relay.name).join(", ")}. `
        : ""}
      {data.truncatedRelayIds.length > 0
        ? "A Relay reached the 2,000-event range limit; narrow the date range for complete results."
        : ""}
    </div>
  )
}, areActivityStatusPropsEqual)

const ActivityStatusController = React.memo(function ActivityStatusController({
  dataStore,
}: {
  dataStore: ActivityDataStore
}) {
  React.useSyncExternalStore(
    dataStore.subscribeStatus,
    dataStore.getStatusSnapshot,
    dataStore.getStatusSnapshot
  )
  return <ActivityStatus data={dataStore.getData()} />
})

const noActorProfiles: Record<string, string> = {}

// Minecraft heads for the people in the log. Only platform administrators
// may look up anyone's; others see initials. Heads arrive after the rows and
// repaint only the user cells.
const ActivityActorProfiles = React.memo(function ActivityActorProfiles({
  children,
  dataStore,
}: {
  children: React.ReactNode
  dataStore: ActivityDataStore
}) {
  React.useSyncExternalStore(
    dataStore.subscribeActors,
    dataStore.getActorsSnapshot,
    dataStore.getActorsSnapshot
  )
  const actors = dataStore.getActors()
  const { data: platformAdmin = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectPlatformAdmin,
  })
  const userIds = React.useMemo(
    () => actors.slice(0, 100).map((actor) => actor.id),
    [actors]
  )
  const { data: profiles = noActorProfiles } = useQuery({
    queryKey: ["users", "minecraft-profiles", userIds.join(",")],
    queryFn: () => getUserMinecraftProfiles({ data: { userIds } }),
    enabled: platformAdmin && userIds.length > 0,
    staleTime: 60 * 60_000,
  })
  return (
    <UserProfilesContext.Provider value={profiles}>
      {children}
    </UserProfilesContext.Provider>
  )
})

const ActivityTable = React.memo(function ActivityTable({
  filterStore,
  searchStore,
}: {
  filterStore: ActivityFiltersStore
  searchStore: DataTableSearchStore
}) {
  const data = useActivityData(filterStore)
  const filters = useActivityRowFilters(filterStore)
  const rows = React.useMemo(
    () => (data ? filterActivity(data.entries, filters) : []),
    [data, filters]
  )
  const source = React.useMemo(
    (): DataTableSource<ActivityEntry> => ({
      body: data ? { kind: "ready" } : { kind: "loading" },
      refreshing: false,
      rows,
    }),
    [data, rows]
  )
  const filtered = activityFilterCount(filters) > 0
  const emptyState = React.useCallback(
    ({ searchActive }: { searchActive: boolean }) => (
      <DataTableEmptyState
        description={
          <span className="block max-w-sm">
            {searchActive || filtered
              ? "Clear a filter or choose a wider date range."
              : "Tracked Relay actions will appear here as they happen."}
          </span>
        }
        icon={
          <FileClock className="size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
        }
        title={
          searchActive || filtered
            ? "No activity matches these filters"
            : "No activity yet"
        }
      />
    ),
    [filtered]
  )
  return (
    <DataTable
      definition={activityTableDefinition}
      emptyState={emptyState}
      searchStore={searchStore}
      source={source}
    />
  )
})

const activityColumnHelper = createDataTableColumnHelper<ActivityEntry>()

const activityTableDefinition = defineDataTable({
  ariaLabel: "Activity history",
  columns: activityColumnHelper.columns([
    activityColumnHelper.accessor((entry) => entry.occurredAt, {
      id: "time",
      header: "Time",
      sortDescFirst: true,
      sortFn: sortFn_basic,
      cell: ({ row }) => (
        <RelativeTime
          className="type-meta text-foreground"
          timestamp={row.original.occurredAt}
        />
      ),
      meta: dataTableColumnMeta({ width: { base: "7rem", lg: "8rem" } }),
    }),
    activityColumnHelper.accessor(activityWhereName, {
      id: "where",
      header: "Where",
      sortFn: "text",
      cell: ({ row }) => <ActivityWhere entry={row.original} />,
      meta: dataTableColumnMeta(
        { hideBelow: "md", width: "minmax(0,1fr)" },
        { cellClassName: "px-0" }
      ),
    }),
    activityColumnHelper.accessor((entry) => entry.actor.name, {
      id: "user",
      header: "User",
      sortFn: "text",
      cell: ({ row }) => (
        <ActivityUser actor={row.original.actor} source={row.original.source} />
      ),
      meta: dataTableColumnMeta({ hideBelow: "md", width: "minmax(0,0.9fr)" }),
    }),
    activityColumnHelper.accessor((entry) => entry.label, {
      id: "action",
      header: "Action",
      sortFn: "text",
      cell: ({ row }) => <ActivityAction entry={row.original} />,
      meta: dataTableColumnMeta({
        width: { base: "minmax(0,1fr)", md: "minmax(0,1.4fr)" },
      }),
    }),
    activityColumnHelper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      cell: ({ row }) => <ActivityRowActions entry={row.original} />,
      meta: dataTableColumnMeta(
        { width: "3rem" },
        { cellClassName: "px-1 sm:px-2", headerClassName: "px-1 sm:px-2" }
      ),
    }),
  ]),
  getRowId: (entry) => entry.id,
  model: { initialState: { sorting: [{ desc: true, id: "time" }] } },
  search: {
    fields: [
      (entry) => entry.label,
      (entry) => entry.rawEvent,
      (entry) => entry.actor.name,
      (entry) => entry.actor.email,
      (entry) => entry.relay.name,
      (entry) => entry.target?.name,
      (entry) => entry.target?.id,
      (entry) => entry.permission,
    ],
  },
  virtualization: true,
})

// The instance an event acted on, or its Relay for Relay-wide events.
const ActivityWhere = React.memo(function ActivityWhere({
  entry,
}: {
  entry: ActivityEntry
}) {
  const { relay, target } = entry
  const card = (
    <InstanceCard
      className="min-w-0 flex-1"
      instance={activityWhereIdentity(entry)}
      meta={target ? relay.name : "Relay-wide"}
      metaClassName="font-mono"
      name={activityWhereName(entry)}
      nameClassName="transition-colors group-hover/where-link:text-primary-ink"
      showFavorite={false}
      showStatus={false}
    />
  )
  const className =
    "group/where-link flex min-h-14 w-full min-w-0 items-center px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
  switch (target?.kind) {
    case "server":
      return (
        <Link
          to="/server/$serverId/console"
          params={{
            serverId: relayInstanceRouteId(relay.id, target.id.slice(0, 8)),
          }}
          preload="intent"
          className={className}
        >
          {card}
        </Link>
      )
    case "app":
      return (
        <Link
          to="/app/$appId"
          params={{ appId: target.id }}
          preload="intent"
          className={className}
        >
          {card}
        </Link>
      )
    case "database":
      return (
        <Link
          to="/db/$databaseId"
          params={{ databaseId: target.id }}
          preload="intent"
          className={className}
        >
          {card}
        </Link>
      )
    default:
      return (
        <Link
          to="/relay/$relayId"
          params={{ relayId: relay.id }}
          preload="intent"
          className={className}
        >
          {card}
        </Link>
      )
  }
})

const ActivityUser = React.memo(function ActivityUser({
  actor,
  source,
}: {
  actor: ActivityEntry["actor"]
  source: ActivitySource
}) {
  const profileId = React.useContext(UserProfilesContext)[actor.id]
  return (
    <UserIdentity
      accessory={
        source === "cli" ? (
          <Badge variant="outline" className="h-4 px-1 font-mono text-[10px]">
            CLI
          </Badge>
        ) : null
      }
      avatarClassName="size-8"
      email={actor.email}
      name={actor.name}
      profileId={profileId}
    />
  )
})

// What happened: its type's icon, the event, and its type and permission.
// Narrow screens hide Where and User, so their names stand in for the type.
const ActivityAction = React.memo(function ActivityAction({
  entry,
}: {
  entry: ActivityEntry
}) {
  const details = typeDetails[entry.type]
  const Icon = details.icon
  return (
    <IdentityName
      icon={<Icon className="size-3.5" />}
      iconClassName="border-primary/18 bg-primary/7 text-primary-ink/85"
      meta={
        <>
          <span className="md:hidden">
            {activityWhereName(entry)} · {entry.actor.name}
          </span>
          <span className="hidden md:inline">
            <span className="tracking-[0.06em] text-primary-ink uppercase">
              {details.label}
            </span>
            {entry.permission ? (
              <>
                <span aria-hidden="true" className="px-1">
                  /
                </span>
                <code>{entry.permission}</code>
              </>
            ) : null}
          </span>
        </>
      }
      metaClassName="font-mono"
      name={entry.label}
    />
  )
})

const targetIdLabels = {
  app: "App ID",
  database: "Database ID",
  server: "Game server ID",
} satisfies Record<NonNullable<ActivityEntry["target"]>["kind"], string>

const ActivityRowActions = React.memo(function ActivityRowActions({
  entry,
}: {
  entry: ActivityEntry
}) {
  const { actor, relay, target } = entry
  // The Kiln system acts without an account.
  const person = actor.id !== systemActorId
  return (
    <DataTableActionGroup>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`More actions for ${entry.label}`}
          >
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <CopyIdentifierMenuItem
            label="Timestamp"
            value={new Date(entry.occurredAt).toISOString()}
          />
          <CopyIdentifierMenuItem label="Action" value={entry.label} />
          <DropdownMenuSeparator />
          {target ? (
            <CopyIdentifierMenuItem
              label={targetIdLabels[target.kind]}
              value={target.id}
            />
          ) : null}
          {entry.databaseId && target?.kind !== "database" ? (
            <CopyIdentifierMenuItem
              label="Database ID"
              value={entry.databaseId}
            />
          ) : null}
          <CopyIdentifierMenuItem label="Relay ID" value={relay.id} />
          {person ? (
            <>
              <DropdownMenuSeparator />
              <CopyIdentifierMenuItem label="User ID" value={actor.id} />
              {actor.email ? (
                <CopyIdentifierMenuItem
                  label="User email"
                  value={actor.email}
                />
              ) : null}
            </>
          ) : null}
          <DropdownMenuSeparator />
          <CopyIdentifierMenuItem label="Activity ID" value={entry.id} />
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
  )
})

// Hearth's actor ID for events no person caused.
const systemActorId = "system"

function activityWhereName({ relay, target }: ActivityEntry): string {
  return target?.name ?? relay.name
}

function activityWhereIdentity({
  relay,
  target,
}: ActivityEntry): InstanceIdentity {
  return target
    ? { id: target.id, kind: target.kind, relayId: relay.id }
    : { id: relay.id, kind: "relay", relayId: relay.id }
}

function selectPlatformAdmin(capabilities: {
  isPlatformAdmin: boolean
}): boolean {
  return capabilities.isPlatformAdmin
}

function activityActors(data: ActivityData): Array<ActivityEntry["actor"]> {
  return [
    ...new Map(
      data.entries.map((entry) => [entry.actor.id, entry.actor])
    ).values(),
  ].sort((left, right) => left.name.localeCompare(right.name))
}

function activityFilterCount(filters: ActivityFilters): number {
  return [
    filters.app,
    filters.database,
    filters.scope,
    filters.q,
    filters.type,
    filters.user,
    filters.relay,
    filters.server,
    filters.source,
    filters.from,
    filters.to,
  ].filter(Boolean).length
}

function useActivityFilterValue<Key extends keyof ActivityFilters>(
  filterStore: ActivityFiltersStore,
  key: Key
): ActivityFilters[Key] {
  const subscribe = React.useCallback(
    (listener: () => void) => filterStore.subscribeField(key, listener),
    [filterStore, key]
  )
  const getSnapshot = React.useCallback(
    () => filterStore.getFieldSnapshot(key),
    [filterStore, key]
  )
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// Every filter but the search, which the table applies itself: typing then
// refilters without rebuilding the rows.
function useActivityRowFilters(
  filterStore: ActivityFiltersStore
): Omit<ActivityFilters, "q"> {
  const getSnapshot = React.useCallback(() => {
    const { q: _query, ...filters } = filterStore.getSnapshot()
    return JSON.stringify(filters)
  }, [filterStore])
  const key = React.useSyncExternalStore(
    filterStore.subscribe,
    getSnapshot,
    getSnapshot
  )
  return React.useMemo(
    () => JSON.parse(key) as Omit<ActivityFilters, "q">,
    [key]
  )
}

function useActivityData(
  filterStore: ActivityFiltersStore
): ActivityData | undefined {
  const { from, to } = useActivityDateFilters(filterStore)
  const { data } = useQuery({
    ...activityQueryOptions(from, to),
    placeholderData: keepPreviousData,
  })
  return data
}

function useActivityDateFilters(filterStore: ActivityFiltersStore): {
  from?: string
  to?: string
} {
  const getSnapshot = React.useCallback(() => {
    const filters = filterStore.getSnapshot()
    return `${filters.from ?? ""}\u0000${filters.to ?? ""}`
  }, [filterStore])
  React.useSyncExternalStore(
    filterStore.subscribeDate,
    getSnapshot,
    getSnapshot
  )
  const { from, to } = filterStore.getSnapshot()
  return { from, to }
}

function areActivityStatusPropsEqual(
  previous: { data: ActivityData },
  next: { data: ActivityData }
): boolean {
  return (
    activityRelayArraysEqual(previous.data.relays, next.data.relays) &&
    stringArraysEqual(
      previous.data.truncatedRelayIds,
      next.data.truncatedRelayIds
    )
  )
}

function activityActorArraysEqual(
  previous: Array<ActivityEntry["actor"]>,
  next: Array<ActivityEntry["actor"]>
): boolean {
  return arraysEqual(
    previous,
    next,
    (left, right) =>
      left.id === right.id &&
      left.name === right.name &&
      left.email === right.email
  )
}

function activityRelayArraysEqual(
  previous: ActivityData["relays"],
  next: ActivityData["relays"]
): boolean {
  return arraysEqual(
    previous,
    next,
    (left, right) =>
      left.id === right.id &&
      left.name === right.name &&
      left.unavailable === right.unavailable
  )
}

function stringArraysEqual(
  previous: Array<string>,
  next: Array<string>
): boolean {
  return arraysEqual(previous, next, (left, right) => left === right)
}

function arraysEqual<Value>(
  previous: Array<Value>,
  next: Array<Value>,
  equal: (left: Value, right: Value) => boolean
): boolean {
  return (
    previous === next ||
    (previous.length === next.length &&
      previous.every((value, index) => {
        const nextValue = next[index]
        return nextValue !== undefined && equal(value, nextValue)
      }))
  )
}

function filterActivity(
  entries: Array<ActivityEntry>,
  filters: Omit<ActivityFilters, "q">
): Array<ActivityEntry> {
  const from = filters.from ? Date.parse(filters.from) : undefined
  const to = filters.to ? Date.parse(filters.to) : undefined
  return entries.filter((entry) => {
    const { target } = entry
    if (from !== undefined && entry.occurredAt < from) return false
    if (to !== undefined && entry.occurredAt > to) return false
    if (filters.type && entry.type !== filters.type) return false
    if (filters.user && entry.actor.id !== filters.user) return false
    if (filters.source && entry.source !== filters.source) return false
    if (filters.relay && entry.relay.id !== filters.relay) return false
    if (filters.server && !targetIs(target, "server", filters.server)) {
      return false
    }
    if (filters.app && !targetIs(target, "app", filters.app)) return false
    if (filters.database && entry.databaseId !== filters.database) {
      return false
    }
    // The Relay kind is activity on the Relay itself, not on an instance.
    if (filters.scope === "relay") return target === null
    if (filters.scope === "database") return entry.databaseId !== null
    if (filters.scope) return target?.kind === filters.scope
    return true
  })
}

function targetIs(
  target: ActivityEntry["target"],
  kind: NonNullable<ActivityEntry["target"]>["kind"],
  id: string
): boolean {
  return target?.kind === kind && target.id === id
}

function selectedDateRange(
  from?: string,
  to?: string
): { from: Date | undefined; to?: Date } | undefined {
  if (!from && !to) return undefined
  return {
    from: from ? new Date(from) : undefined,
    ...(to ? { to: new Date(to) } : {}),
  }
}

function startOfLocalMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth())
}

function startOfLocalWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  start.setDate(start.getDate() - start.getDay())
  return start
}

function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

function dateRangeDisplayWeek(
  range: ActivityDateRangeValue,
  fallback: Date
): Date {
  return startOfLocalWeek(
    startOfLocalMonth(range?.to ?? range?.from ?? fallback)
  )
}

function localCalendarDays(start: Date, count: number): Array<Date> {
  return Array.from({ length: count }, (_, index) => addLocalDays(start, index))
}

function mostVisibleMonth(days: Array<Date>): Date {
  const middle = days[Math.floor(days.length / 2)] ?? new Date()
  const middleMonth = startOfLocalMonth(middle)
  const counts = new Map<number, { count: number; month: Date }>()

  for (const day of days) {
    const month = startOfLocalMonth(day)
    const key = month.getFullYear() * 12 + month.getMonth()
    const current = counts.get(key)
    counts.set(key, { count: (current?.count ?? 0) + 1, month })
  }

  let visible = { count: 0, month: middleMonth }
  for (const candidate of counts.values()) {
    const candidateIsMiddle = isSameLocalMonth(candidate.month, middleMonth)
    const visibleIsMiddle = isSameLocalMonth(visible.month, middleMonth)
    if (
      candidate.count > visible.count ||
      (candidate.count === visible.count &&
        candidateIsMiddle &&
        !visibleIsMiddle)
    ) {
      visible = candidate
    }
  }
  return visible.month
}

function createActivityDatePickerStore(
  initialRange: ActivityDateRangeValue,
  maximumDate: Date,
  initialOnChange: (range: Pick<ActivityFilters, "from" | "to">) => void
) {
  const maximumWeekStart = startOfLocalWeek(startOfLocalMonth(maximumDate))
  let state: {
    activeBoundary: ActivityDateBoundary
    range: ActivityDateRangeValue
    visibleWeekStart: Date
  } = {
    activeBoundary: "from",
    range: initialRange,
    visibleWeekStart: dateRangeDisplayWeek(initialRange, maximumDate),
  }
  let onChange = initialOnChange
  const boundaryListeners: Record<ActivityDateBoundary, Set<() => void>> = {
    from: new Set(),
    to: new Set(),
  }
  const dayListeners = new Map<number, Set<() => void>>()
  const presetListeners = new Map<number, Set<() => void>>()
  const visibleWeekListeners = new Set<() => void>()

  const subscribeToSet = (listeners: Set<() => void>, listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const subscribeToMap = <Key,>(
    listenersByKey: Map<Key, Set<() => void>>,
    key: Key,
    listener: () => void
  ) => {
    const listeners = listenersByKey.get(key) ?? new Set<() => void>()
    listeners.add(listener)
    listenersByKey.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) listenersByKey.delete(key)
    }
  }

  const boundaryDate = (
    pickerState: typeof state,
    boundary: ActivityDateBoundary
  ) => (boundary === "from" ? pickerState.range?.from : pickerState.range?.to)

  const boundarySnapshot = (
    pickerState: typeof state,
    boundary: ActivityDateBoundary
  ) => {
    const date = boundaryDate(pickerState, boundary)
    return `${pickerState.activeBoundary === boundary ? 1 : 0}:${
      date ? localDayValue(date) : ""
    }`
  }

  const daySnapshot = (range: ActivityDateRangeValue, dayValue: number) => {
    let snapshot = 0
    if (range?.from && localDayValue(range.from) === dayValue) {
      snapshot |= activityDaySelectedStart
    }
    if (range?.to && localDayValue(range.to) === dayValue) {
      snapshot |= activityDaySelectedEnd
    }
    if (
      range?.from &&
      range.to &&
      dayValue > localDayValue(range.from) &&
      dayValue < localDayValue(range.to)
    ) {
      snapshot |= activityDaySelectedMiddle
    }
    return snapshot
  }

  const publish = (next: typeof state) => {
    const previous = state
    state = next

    for (const boundary of activityDateBoundaries) {
      if (
        boundarySnapshot(previous, boundary) !==
        boundarySnapshot(next, boundary)
      ) {
        for (const listener of boundaryListeners[boundary]) listener()
      }
    }

    if (previous.range !== next.range) {
      for (const [dayValue, listeners] of dayListeners) {
        if (
          daySnapshot(previous.range, dayValue) !==
          daySnapshot(next.range, dayValue)
        ) {
          for (const listener of listeners) listener()
        }
      }
      for (const [days, listeners] of presetListeners) {
        if (
          dateRangeMatchesRecent(previous.range, days) !==
          dateRangeMatchesRecent(next.range, days)
        ) {
          for (const listener of listeners) listener()
        }
      }
    }

    if (
      previous.visibleWeekStart.getTime() !== next.visibleWeekStart.getTime()
    ) {
      for (const listener of visibleWeekListeners) listener()
    }
  }

  const commitRange = (range: ActivityDateRangeValue) => {
    if (range?.from && range.to) {
      onChange(activityLocalRangeToUtc(range.from, range.to))
    }
  }

  const open = (range: ActivityDateRangeValue) => {
    publish({
      activeBoundary: "from",
      range,
      visibleWeekStart: dateRangeDisplayWeek(range, maximumDate),
    })
  }

  const setBoundary = (boundary: ActivityDateBoundary) => {
    if (state.activeBoundary === boundary) return
    publish({ ...state, activeBoundary: boundary })
  }

  const selectDay = (date: Date) => {
    const { activeBoundary, range } = state
    let nextBoundary = activeBoundary
    let nextRange: ActivityDateRangeValue

    if (activeBoundary === "from") {
      if (!range?.to) {
        nextRange = { from: date }
        nextBoundary = "to"
      } else if (isLocalDayAfter(date, range.to)) {
        nextRange = { from: range.to, to: date }
        nextBoundary = "to"
      } else {
        nextRange = { from: date, to: range.to }
      }
    } else if (!range?.from) {
      nextRange = { from: undefined, to: date }
      nextBoundary = "from"
    } else if (isLocalDayBefore(date, range.from)) {
      nextRange = { from: date, to: range.from }
      nextBoundary = "from"
    } else {
      nextRange = { from: range.from, to: date }
    }

    publish({ ...state, activeBoundary: nextBoundary, range: nextRange })
    commitRange(nextRange)
  }

  const selectRecentRange = (days: number) => {
    const range = recentRange(days)
    publish({
      ...state,
      range,
      visibleWeekStart: dateRangeDisplayWeek(range, maximumDate),
    })
    commitRange(range)
  }

  const reset = () => {
    publish({
      activeBoundary: "from",
      range: undefined,
      visibleWeekStart: dateRangeDisplayWeek(undefined, maximumDate),
    })
    onChange({ from: undefined, to: undefined })
  }

  const shiftWeeks = (offset: number) => {
    const next = addLocalDays(state.visibleWeekStart, offset * 7)
    publish({
      ...state,
      visibleWeekStart: next > maximumWeekStart ? maximumWeekStart : next,
    })
  }

  const shiftMonths = (offset: number) => {
    const visibleDays = localCalendarDays(state.visibleWeekStart, 42)
    const month = mostVisibleMonth(visibleDays)
    const nextMonth = new Date(month.getFullYear(), month.getMonth() + offset)
    const next = startOfLocalWeek(nextMonth)
    publish({
      ...state,
      visibleWeekStart: next > maximumWeekStart ? maximumWeekStart : next,
    })
  }

  return {
    getBoundaryDate: (boundary: ActivityDateBoundary) =>
      boundaryDate(state, boundary),
    getBoundarySnapshot: (boundary: ActivityDateBoundary) =>
      boundarySnapshot(state, boundary),
    getDaySnapshot: (date: Date) =>
      daySnapshot(state.range, localDayValue(date)),
    getPresetSnapshot: (days: number) =>
      dateRangeMatchesRecent(state.range, days),
    getVisibleWeekStartSnapshot: () => state.visibleWeekStart.getTime(),
    open,
    reset,
    selectDay,
    selectRecentRange,
    setBoundary,
    setOnChange: (
      nextOnChange: (range: Pick<ActivityFilters, "from" | "to">) => void
    ) => {
      onChange = nextOnChange
    },
    shiftMonths,
    shiftWeeks,
    subscribeBoundary: (boundary: ActivityDateBoundary, listener: () => void) =>
      subscribeToSet(boundaryListeners[boundary], listener),
    subscribeDay: (date: Date, listener: () => void) =>
      subscribeToMap(dayListeners, localDayValue(date), listener),
    subscribePreset: (days: number, listener: () => void) =>
      subscribeToMap(presetListeners, days, listener),
    subscribeVisibleWeek: (listener: () => void) =>
      subscribeToSet(visibleWeekListeners, listener),
  }
}

function dateRangeMatchesRecent(
  range: { from: Date | undefined; to?: Date } | undefined,
  days: number
): boolean {
  if (!range?.from || !range.to) return false
  const recent = recentRange(days)
  return (
    isSameLocalDay(range.from, recent.from) &&
    isSameLocalDay(range.to, recent.to)
  )
}

function isSameLocalDay(left: Date, right?: Date): boolean {
  if (!right) return false
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function isSameLocalMonth(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth()
  )
}

function localDayValue(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function isLocalDayAfter(left: Date, right: Date): boolean {
  return localDayValue(left) > localDayValue(right)
}

function isLocalDayBefore(left: Date, right: Date): boolean {
  return localDayValue(left) < localDayValue(right)
}

function formatShortDate(date: Date): string {
  return activityShortDate.format(date)
}

function dateRangeLabel(from?: string, to?: string): string {
  if (!from && !to) return "All time"
  if (from && to) {
    return `${formatShortDate(new Date(from))} – ${formatShortDate(new Date(to))}`
  }
  return from
    ? `From ${formatShortDate(new Date(from))}`
    : `Through ${formatShortDate(new Date(to ?? ""))}`
}

function recentRange(days: number): { from: Date; to: Date } {
  const to = new Date()
  to.setHours(12, 0, 0, 0)
  const from = new Date(to)
  from.setDate(to.getDate() - (days - 1))
  return { from, to }
}
