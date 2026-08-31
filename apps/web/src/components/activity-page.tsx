import * as React from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ensuringPromise, forkPromise } from "@/effect/promise"
import {
  CalendarDays,
  Bot,
  ChevronLeft,
  ChevronRight,
  CircleGauge,
  FileClock,
  FolderClock,
  KeyRound,
  ListFilter,
  Network,
  RadioTower,
  RefreshCw,
  Search,
  Server,
  TerminalSquare,
  UserRound,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { ServerScopePicker } from "@/components/server-scope-picker"
import {
  InstanceName,
  type InstanceNameInstance,
} from "@/components/instance-name"
import {
  activityLocalRangeToUtc,
  activityTypes,
  isActivitySource,
  isActivityType,
} from "@/lib/activity"
import type { ActivitySource, ActivityType } from "@/lib/activity"
import { activityQueryOptions } from "@/lib/query-options"
import { relayInstanceRouteId } from "@/lib/relay-fleet"
import type { ActivityData, ActivityEntry } from "@/server/activity"

export interface ActivityFilters {
  from?: string
  q?: string
  relay?: string
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

function createActivityDataStore(initialData: ActivityData) {
  let data = initialData
  let actors = activityActors(initialData)
  let actorsVersion = 0
  let relayVersion = 0
  let serverVersion = 0
  let statusVersion = 0
  const actorsListeners = new Set<() => void>()
  const relayListeners = new Set<() => void>()
  const serverListeners = new Set<() => void>()
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
    getServerSnapshot: () => serverVersion,
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
      const serversChanged = !activityServerArraysEqual(
        previousData.servers,
        nextData.servers
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
      if (relaysChanged || serversChanged) {
        relayVersion += 1
        for (const listener of relayListeners) listener()
      }
      if (serversChanged || relaysChanged) {
        serverVersion += 1
        for (const listener of serverListeners) listener()
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
    subscribeServer: (listener: () => void) =>
      subscribe(serverListeners, listener),
    subscribeStatus: (listener: () => void) =>
      subscribe(statusListeners, listener),
  }
}

type ActivityResultsStore = ReturnType<typeof createActivityResultsStore>

function createActivityResultsStore(
  initialData: ActivityData,
  initialFilters: ActivityFilters
) {
  let entries = filterActivity(
    initialData.entries,
    initialFilters,
    initialFilters.q ?? ""
  )
  let entriesById = new Map(entries.map((entry) => [entry.id, entry]))
  let filtered = activityFilterCount(initialFilters) > 0
  let listVersion = 0
  const entryVersions = new Map<string, number>()
  const listListeners = new Set<() => void>()
  const entryListeners = new Map<string, Set<() => void>>()

  return {
    getEntries: () => entries,
    getEntry: (id: string) => entriesById.get(id),
    getEntrySnapshot: (id: string) => entryVersions.get(id) ?? 0,
    getFiltered: () => filtered,
    getListSnapshot: () => listVersion,
    setResult: (data: ActivityData, filters: ActivityFilters) => {
      const nextEntries = filterActivity(data.entries, filters, filters.q ?? "")
      const nextFiltered = activityFilterCount(filters) > 0
      const listChanged =
        !activityEntryIdArraysEqual(entries, nextEntries) ||
        (entries.length === 0 && filtered !== nextFiltered)
      const previousEntries = new Map(entries.map((entry) => [entry.id, entry]))

      entries = nextEntries
      entriesById = new Map(nextEntries.map((entry) => [entry.id, entry]))
      filtered = nextFiltered
      for (const entry of nextEntries) {
        const previousEntry = previousEntries.get(entry.id)
        if (previousEntry && activityEntriesEqual(previousEntry, entry)) {
          continue
        }
        entryVersions.set(entry.id, (entryVersions.get(entry.id) ?? 0) + 1)
        for (const listener of entryListeners.get(entry.id) ?? []) listener()
      }
      if (listChanged) {
        listVersion += 1
        for (const listener of listListeners) listener()
      }
    },
    subscribeEntry: (id: string, listener: () => void) => {
      const listeners = entryListeners.get(id) ?? new Set<() => void>()
      listeners.add(listener)
      entryListeners.set(id, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) entryListeners.delete(id)
      }
    },
    subscribeList: (listener: () => void) => {
      listListeners.add(listener)
      return () => listListeners.delete(listener)
    },
  }
}

const typeDetails: Record<
  ActivityType,
  { icon: React.ComponentType<{ className?: string }>; label: string }
> = {
  server: { icon: Server, label: "Server" },
  power: { icon: CircleGauge, label: "Power" },
  console: { icon: TerminalSquare, label: "Console" },
  files: { icon: FolderClock, label: "Files" },
  network: { icon: Network, label: "Network" },
  access: { icon: KeyRound, label: "Access" },
  relay: { icon: RadioTower, label: "Relay" },
  updates: { icon: RefreshCw, label: "Updates" },
  system: { icon: FileClock, label: "System" },
}

const activityTime = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
})

const activityDay = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "short",
  year: "numeric",
})

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

const minimumActivitySyncFeedbackMs = 500
const subscribeToHydration = () => () => {}
const getClientHydrationSnapshot = () => true
const getServerHydrationSnapshot = () => false
const activityTableBottomPadding = 12

export const ActivityPage = React.memo(function ActivityPage({
  initialData,
  filterStore,
  onFiltersChange,
}: ActivityPageProps) {
  const [dataStore] = React.useState(() => createActivityDataStore(initialData))
  const [resultsStore] = React.useState(() =>
    createActivityResultsStore(initialData, filterStore.getSnapshot())
  )
  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-3 pt-3 pb-3 sm:px-5 sm:pt-5 sm:pb-5">
      <ActivityPageContent
        dataStore={dataStore}
        filterStore={filterStore}
        onFiltersChange={onFiltersChange}
        resultsStore={resultsStore}
      />
    </div>
  )
})

interface ActivityPageContentProps {
  dataStore: ActivityDataStore
  filterStore: ActivityFiltersStore
  onFiltersChange: (change: Partial<ActivityFilters>) => void
  resultsStore: ActivityResultsStore
}

const ActivityPageContent = React.memo(function ActivityPageContent({
  dataStore,
  filterStore,
  onFiltersChange,
  resultsStore,
}: ActivityPageContentProps) {
  return (
    <>
      <ActivityDataBridge
        dataStore={dataStore}
        filterStore={filterStore}
        resultsStore={resultsStore}
      />
      <ActivityServerFilterController
        dataStore={dataStore}
        filterStore={filterStore}
        onFiltersChange={onFiltersChange}
      />

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card/45 [contain:paint]">
        <ActivityFiltersToolbar
          dataStore={dataStore}
          filterStore={filterStore}
          onFiltersChange={onFiltersChange}
        />

        <ActivityStatusController dataStore={dataStore} />
        <ActivityResults resultsStore={resultsStore} />
      </section>
    </>
  )
})

interface ActivityFiltersToolbarProps {
  dataStore: ActivityDataStore
  filterStore: ActivityFiltersStore
  onFiltersChange: (change: Partial<ActivityFilters>) => void
}

const ActivityFiltersToolbar = React.memo(function ActivityFiltersToolbar({
  dataStore,
  filterStore,
  onFiltersChange,
}: ActivityFiltersToolbarProps) {
  return (
    <div className="border-b bg-background/15 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ActivitySyncButtonController filterStore={filterStore} />
        <ActivitySearchController
          filterStore={filterStore}
          onFiltersChange={onFiltersChange}
        />
        <ActivityTypeFilter
          filterStore={filterStore}
          onFiltersChange={onFiltersChange}
        />
        <ActivitySourceFilter
          filterStore={filterStore}
          onFiltersChange={onFiltersChange}
        />
        <ActivityUserFilter
          dataStore={dataStore}
          filterStore={filterStore}
          onFiltersChange={onFiltersChange}
        />
        <ActivityRelayFilter
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
      </div>
    </div>
  )
})

const ActivitySearchController = React.memo(function ActivitySearchController({
  filterStore,
  onFiltersChange,
}: {
  filterStore: ActivityFiltersStore
  onFiltersChange: (change: Partial<ActivityFilters>) => void
}) {
  const query = useActivityFilterValue(filterStore, "q") ?? ""
  return (
    <ActivitySearch
      key={query}
      initialValue={query}
      onFiltersChange={onFiltersChange}
    />
  )
})

const ActivityDataBridge = React.memo(function ActivityDataBridge({
  dataStore,
  filterStore,
  resultsStore,
}: {
  dataStore: ActivityDataStore
  filterStore: ActivityFiltersStore
  resultsStore: ActivityResultsStore
}) {
  const filters = React.useSyncExternalStore(
    filterStore.subscribe,
    filterStore.getSnapshot,
    filterStore.getSnapshot
  )
  const data = useActivityData(filterStore)
  React.useLayoutEffect(() => {
    if (!data) return
    dataStore.setData(data)
    resultsStore.setResult(data, filters)
  }, [data, dataStore, filters, resultsStore])
  return null
})

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

const ActivityRelayFilter = React.memo(function ActivityRelayFilter({
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
  const data = dataStore.getData()
  const relay = useActivityFilterValue(filterStore, "relay")
  const server = useActivityFilterValue(filterStore, "server")
  const update = React.useCallback(
    (nextValue: string) =>
      onFiltersChange({
        relay: nextValue || undefined,
        server:
          server &&
          data.servers.some(
            (candidate) =>
              candidate.id === server &&
              (!nextValue || candidate.relayId === nextValue)
          )
            ? server
            : undefined,
      }),
    [data.servers, onFiltersChange, server]
  )

  if (data.relays.length <= 1) return null
  return (
    <ActivitySelect
      ariaLabel="Filter activity by Relay"
      icon={<RadioTower />}
      value={relay ?? ""}
      onChange={update}
    >
      <SelectItem value={allActivityFiltersValue}>All Relays</SelectItem>
      {data.relays.map((candidate) => (
        <SelectItem key={candidate.id} value={candidate.id}>
          {candidate.name}
        </SelectItem>
      ))}
    </ActivitySelect>
  )
})

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
      type="button"
      size="sm"
      variant="ghost"
      onClick={() =>
        onFiltersChange({
          from: undefined,
          q: undefined,
          relay: undefined,
          server: undefined,
          source: undefined,
          to: undefined,
          type: undefined,
          user: undefined,
        })
      }
    >
      <X />
      Clear {activeFilterCount}
    </Button>
  )
})

interface ActivityServerFilterProps {
  data: ActivityData
  filters: ActivityFilters
  onFiltersChange: (change: Partial<ActivityFilters>) => void
}

const ActivityServerFilterController = React.memo(
  function ActivityServerFilterController({
    dataStore,
    filterStore,
    onFiltersChange,
  }: {
    dataStore: ActivityDataStore
    filterStore: ActivityFiltersStore
    onFiltersChange: (change: Partial<ActivityFilters>) => void
  }) {
    React.useSyncExternalStore(
      dataStore.subscribeServer,
      dataStore.getServerSnapshot,
      dataStore.getServerSnapshot
    )
    const data = dataStore.getData()
    const relay = useActivityFilterValue(filterStore, "relay")
    const server = useActivityFilterValue(filterStore, "server")
    return (
      <ActivityServerFilter
        data={data}
        filters={{ relay, server }}
        onFiltersChange={onFiltersChange}
      />
    )
  }
)

const ActivityServerFilter = React.memo(function ActivityServerFilter({
  data,
  filters,
  onFiltersChange,
}: ActivityServerFilterProps) {
  const relayNameById = React.useMemo(
    () => new Map(data.relays.map((relay) => [relay.id, relay.name])),
    [data.relays]
  )
  const servers = React.useMemo(
    () =>
      data.servers.flatMap((server) => {
        if (filters.relay && server.relayId !== filters.relay) return []

        const relayName = relayNameById.get(server.relayId) ?? "Relay"
        return [
          {
            id: server.id,
            name: server.name,
            relayId: server.relayId,
            relayName,
          },
        ]
      }),
    [data.servers, filters.relay, relayNameById]
  )
  const selectedServer =
    servers.find((server) => server.id === filters.server) ?? null
  const selectedRelayName = filters.relay
    ? relayNameById.get(filters.relay)
    : undefined
  const selectServer = React.useCallback(
    (server: (typeof servers)[number] | null) => {
      onFiltersChange({ server: server?.id })
    },
    [onFiltersChange]
  )

  return (
    <ServerScopePicker
      selectedRelayName={selectedRelayName}
      selectedServer={selectedServer}
      servers={servers}
      onSelect={selectServer}
    />
  )
}, areActivityServerFilterPropsEqual)

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
  const { fetchStatus, refetch } = useQuery({
    ...activityQueryOptions(from, to),
    notifyOnChangeProps: ["fetchStatus"],
  })
  const hydrated = React.useSyncExternalStore(
    subscribeToHydration,
    getClientHydrationSnapshot,
    getServerHydrationSnapshot
  )
  const [manualSyncing, setManualSyncing] = React.useState(false)
  const manualSyncingRef = React.useRef(false)
  const feedbackTimeoutRef = React.useRef<number>(undefined)
  const mountedRef = React.useRef(true)
  const syncing = manualSyncing || (hydrated && fetchStatus === "fetching")

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (feedbackTimeoutRef.current !== undefined) {
        window.clearTimeout(feedbackTimeoutRef.current)
      }
    }
  }, [])

  const syncActivity = React.useCallback(() => {
    if (manualSyncingRef.current) return
    manualSyncingRef.current = true
    setManualSyncing(true)
    const startedAt = performance.now()

    forkPromise(() =>
      ensuringPromise(refetch, () => {
        if (!mountedRef.current) return
        const elapsed = performance.now() - startedAt
        const remaining = Math.max(0, minimumActivitySyncFeedbackMs - elapsed)
        feedbackTimeoutRef.current = window.setTimeout(() => {
          manualSyncingRef.current = false
          setManualSyncing(false)
          feedbackTimeoutRef.current = undefined
        }, remaining)
      })
    )
  }, [refetch])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Sync activity"
          aria-busy={syncing}
          disabled={syncing}
          onClick={syncActivity}
        >
          <RefreshCw className={syncing ? "animate-spin" : ""} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Sync activity
      </TooltipContent>
    </Tooltip>
  )
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
        className="h-8 min-w-0 gap-1.5 px-2 text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:flex-1 [&_[data-slot=select-value]]:truncate [&_[data-slot=select-value]]:whitespace-nowrap"
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

const ActivitySearch = React.memo(function ActivitySearch({
  initialValue,
  onFiltersChange,
}: {
  initialValue: string
  onFiltersChange: (change: Partial<ActivityFilters>) => void
}) {
  const [value, setValue] = React.useState(initialValue)
  const searchTimer = React.useRef<number>(undefined)

  React.useEffect(
    () => () => {
      if (searchTimer.current !== undefined) {
        window.clearTimeout(searchTimer.current)
      }
    },
    []
  )

  const update = React.useCallback(
    (nextValue: string) => {
      setValue(nextValue)
      if (searchTimer.current !== undefined) {
        window.clearTimeout(searchTimer.current)
      }
      searchTimer.current = window.setTimeout(() => {
        onFiltersChange({ q: nextValue.trim() || undefined })
      }, 180)
    },
    [onFiltersChange]
  )

  return (
    <div className="relative min-w-[14rem] flex-1 sm:max-w-md">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onChange={(event) => update(event.currentTarget.value)}
        placeholder="Search actions, people, servers…"
        aria-label="Search activity"
        className="pr-8 pl-9 text-base md:text-sm"
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear activity search"
          className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center text-muted-foreground hover:text-foreground"
          onClick={() => update("")}
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
})

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
      className="type-meta font-mono tracking-[0.04em] aria-pressed:border-primary/30 aria-pressed:bg-primary/10 aria-pressed:text-primary"
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
      className="type-meta border-b border-primary/15 bg-primary/6 px-3 py-2 font-mono text-muted-foreground"
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

const ActivityResults = React.memo(function ActivityResults({
  resultsStore,
}: {
  resultsStore: ActivityResultsStore
}) {
  React.useSyncExternalStore(
    resultsStore.subscribeList,
    resultsStore.getListSnapshot,
    resultsStore.getListSnapshot
  )
  const entries = resultsStore.getEntries()
  const filtered = resultsStore.getFiltered()
  const parentRef = React.useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    estimateSize: () => 64,
    getScrollElement: () => parentRef.current,
    getItemKey: (index) => entries[index]?.id ?? index,
    overscan: 14,
  })

  if (entries.length === 0) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center p-8 text-center">
        <div>
          <span className="mx-auto mb-3 grid size-10 place-items-center border border-border bg-muted/35 text-muted-foreground">
            <FileClock className="size-4" />
          </span>
          <p className="text-sm font-medium">
            {filtered ? "No activity matches these filters" : "No activity yet"}
          </p>
          <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
            {filtered
              ? "Clear a filter or choose a wider date range."
              : "Tracked Relay actions will appear here as they happen."}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        aria-hidden="true"
        className="type-technical-label absolute inset-x-0 top-0 z-10 grid h-9 grid-cols-[5.5rem_minmax(0,1fr)] items-center border-b bg-card/95 px-3 text-muted-foreground backdrop-blur md:grid-cols-[7rem_minmax(8rem,11rem)_minmax(8rem,10rem)_minmax(12rem,1fr)] lg:grid-cols-[8rem_minmax(10rem,14rem)_minmax(9rem,12rem)_minmax(15rem,1fr)]"
      >
        <span>Time</span>
        <span className="hidden md:block">Where</span>
        <span className="hidden md:block">User</span>
        <span>Action</span>
      </div>
      <div
        ref={parentRef}
        role="feed"
        aria-label="Activity history"
        className="absolute inset-0 overflow-y-auto overscroll-contain pt-8"
      >
        <div
          className="relative w-full"
          style={{
            height: `${
              rowVirtualizer.getTotalSize() + activityTableBottomPadding
            }px`,
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const entry = entries[virtualRow.index]
            if (!entry) return null
            return (
              <ActivityRowController
                key={entry.id}
                id={entry.id}
                index={virtualRow.index}
                measureElement={rowVirtualizer.measureElement}
                resultsStore={resultsStore}
                start={virtualRow.start}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
})

const ActivityRowController = React.memo(function ActivityRowController({
  id,
  index,
  measureElement,
  resultsStore,
  start,
}: {
  id: string
  index: number
  measureElement: (node: Element | null) => void
  resultsStore: ActivityResultsStore
  start: number
}) {
  const subscribe = React.useCallback(
    (listener: () => void) => resultsStore.subscribeEntry(id, listener),
    [id, resultsStore]
  )
  const getSnapshot = React.useCallback(
    () => resultsStore.getEntrySnapshot(id),
    [id, resultsStore]
  )
  React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const entry = resultsStore.getEntry(id)
  return entry ? (
    <ActivityRow
      entry={entry}
      index={index}
      measureElement={measureElement}
      start={start}
    />
  ) : null
})

interface ActivityRowProps {
  entry: ActivityEntry
  index: number
  measureElement: (node: Element | null) => void
  start: number
}

const ActivityRow = React.memo(function ActivityRow({
  entry,
  index,
  measureElement,
  start,
}: ActivityRowProps) {
  const details = typeDetails[entry.type]
  const Icon = details.icon
  const date = new Date(entry.occurredAt)

  return (
    <article
      ref={measureElement}
      data-index={index}
      className="absolute top-0 left-0 grid w-full grid-cols-[5.5rem_minmax(0,1fr)] items-center border-b border-border/65 px-3 py-2.5 transition-colors hover:bg-accent/18 md:grid-cols-[7rem_minmax(8rem,11rem)_minmax(8rem,10rem)_minmax(12rem,1fr)] lg:grid-cols-[8rem_minmax(10rem,14rem)_minmax(9rem,12rem)_minmax(15rem,1fr)]"
      style={{ transform: `translateY(${start}px)` }}
    >
      <time
        dateTime={date.toISOString()}
        className="type-meta pr-2 font-mono text-muted-foreground"
      >
        <span className="block md:hidden" suppressHydrationWarning>
          {activityDay.format(date)}
        </span>
        <span suppressHydrationWarning>{activityTime.format(date)}</span>
        <span className="hidden md:block" suppressHydrationWarning>
          {activityDay.format(date)}
        </span>
      </time>

      <div className="hidden min-w-0 md:block">
        <ActivityWhereLink entry={entry} />
      </div>

      <div className="hidden min-w-0 pr-3 md:block">
        <p className="type-label truncate">{entry.actor.name}</p>
        <p className="type-meta truncate font-mono text-muted-foreground">
          {entry.source === "cli" ? "CLI · " : ""}
          {entry.actor.email ?? "service activity"}
        </p>
      </div>

      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center border border-primary/18 bg-primary/7 text-primary/85">
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0">
          <p className="type-label truncate text-foreground">{entry.label}</p>
          <p className="type-meta mt-1 truncate font-mono text-primary">
            <span className="tracking-[0.06em] uppercase">{details.label}</span>
            {entry.permission ? (
              <>
                <span aria-hidden="true" className="px-1 text-muted-foreground">
                  /
                </span>
                <code className="text-muted-foreground">
                  {entry.permission}
                </code>
              </>
            ) : null}
          </p>
          <div className="type-technical-label mt-0.5 flex min-w-0 items-center gap-1.5 text-muted-foreground md:hidden">
            <ActivityWhereLink entry={entry} compact />
            <span aria-hidden="true">·</span>
            <span className="truncate">{entry.actor.name}</span>
          </div>
        </div>
      </div>
    </article>
  )
}, areActivityRowPropsEqual)

function ActivityWhereLink({
  compact = false,
  entry,
}: {
  compact?: boolean
  entry: ActivityEntry
}) {
  if (compact) {
    return entry.server ? (
      <Link
        to="/server/$serverId/console"
        params={{
          serverId: relayInstanceRouteId(
            entry.relay.id,
            entry.server.id.slice(0, 8)
          ),
        }}
        preload="intent"
        className="min-w-0 truncate text-muted-foreground hover:text-primary"
        aria-label={`Open ${entry.server.name}`}
      >
        {entry.server.name}
      </Link>
    ) : (
      <Link
        to="/infra/servers"
        search={{ search: entry.relay.name }}
        preload="intent"
        className="min-w-0 truncate text-muted-foreground hover:text-primary"
        aria-label={`View servers on ${entry.relay.name}`}
      >
        {entry.relay.name}
      </Link>
    )
  }

  const instance: InstanceNameInstance = entry.server
    ? {
        id: entry.server.id,
        kind: "server",
        relayId: entry.relay.id,
      }
    : {
        id: entry.relay.id,
        kind: "relay",
        relayId: entry.relay.id,
      }
  const identity = (
    <InstanceName
      instance={instance}
      name={entry.server?.name ?? entry.relay.name}
      nameClassName="transition-colors group-hover/where-link:text-primary"
      meta={entry.server ? entry.relay.name : "Relay-wide"}
      metaClassName="font-mono"
      showStatus={false}
    />
  )
  const className =
    "group/where-link -my-2.5 flex min-h-16 min-w-0 items-center py-2.5 pr-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"

  if (entry.server) {
    return (
      <Link
        to="/server/$serverId/console"
        params={{
          serverId: relayInstanceRouteId(
            entry.relay.id,
            entry.server.id.slice(0, 8)
          ),
        }}
        preload="intent"
        className={className}
      >
        {identity}
      </Link>
    )
  }

  return (
    <Link
      to="/infra/servers"
      search={{ search: entry.relay.name }}
      preload="intent"
      className={className}
    >
      {identity}
    </Link>
  )
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

function areActivityServerFilterPropsEqual(
  previous: ActivityServerFilterProps,
  next: ActivityServerFilterProps
): boolean {
  return (
    previous.onFiltersChange === next.onFiltersChange &&
    previous.filters.relay === next.filters.relay &&
    previous.filters.server === next.filters.server &&
    activityRelayArraysEqual(previous.data.relays, next.data.relays) &&
    activityServerArraysEqual(previous.data.servers, next.data.servers)
  )
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

function areActivityRowPropsEqual(
  previous: ActivityRowProps,
  next: ActivityRowProps
): boolean {
  return (
    previous.index === next.index &&
    previous.start === next.start &&
    activityEntriesEqual(previous.entry, next.entry)
  )
}

function activityEntriesEqual(
  previousEntry: ActivityEntry,
  nextEntry: ActivityEntry
): boolean {
  return (
    previousEntry.id === nextEntry.id &&
    previousEntry.label === nextEntry.label &&
    previousEntry.occurredAt === nextEntry.occurredAt &&
    previousEntry.permission === nextEntry.permission &&
    previousEntry.rawEvent === nextEntry.rawEvent &&
    previousEntry.source === nextEntry.source &&
    previousEntry.type === nextEntry.type &&
    previousEntry.actor.id === nextEntry.actor.id &&
    previousEntry.actor.name === nextEntry.actor.name &&
    previousEntry.actor.email === nextEntry.actor.email &&
    previousEntry.relay.id === nextEntry.relay.id &&
    previousEntry.relay.name === nextEntry.relay.name &&
    previousEntry.relay.unavailable === nextEntry.relay.unavailable &&
    previousEntry.server?.id === nextEntry.server?.id &&
    previousEntry.server?.name === nextEntry.server?.name
  )
}

function activityEntryIdArraysEqual(
  previous: Array<ActivityEntry>,
  next: Array<ActivityEntry>
): boolean {
  return arraysEqual(previous, next, (left, right) => left.id === right.id)
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

function activityServerArraysEqual(
  previous: ActivityData["servers"],
  next: ActivityData["servers"]
): boolean {
  return arraysEqual(
    previous,
    next,
    (left, right) =>
      left.id === right.id &&
      left.name === right.name &&
      left.relayId === right.relayId
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
  filters: ActivityFilters,
  query: string
): Array<ActivityEntry> {
  const normalized = query.trim().toLowerCase()
  const from = filters.from ? Date.parse(filters.from) : undefined
  const to = filters.to ? Date.parse(filters.to) : undefined
  return entries.filter((entry) => {
    if (from !== undefined && entry.occurredAt < from) return false
    if (to !== undefined && entry.occurredAt > to) return false
    if (filters.type && entry.type !== filters.type) return false
    if (filters.user && entry.actor.id !== filters.user) return false
    if (filters.relay && entry.relay.id !== filters.relay) return false
    if (filters.server && entry.server?.id !== filters.server) return false
    if (filters.source && entry.source !== filters.source) return false
    if (!normalized) return true
    return [
      entry.label,
      entry.rawEvent,
      entry.actor.name,
      entry.actor.email,
      entry.relay.name,
      entry.server?.name,
      entry.server?.id,
    ].some((value) => value?.toLowerCase().includes(normalized))
  })
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
