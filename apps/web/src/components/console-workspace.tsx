import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Effect, Result } from "effect"
import {
  formatRelayInstanceStateReason,
  type RelayConsole,
  type RelayConsoleLevel,
  type RelayConsoleLine,
  type RelayConsoleSegment,
  type RelayInstanceStateReason,
  type RelayObservedState,
} from "@workspace/contracts"
import {
  ArrowDown,
  Boxes,
  Check,
  Clock3,
  Copy,
  CornerDownLeft,
  EyeOff,
  ListFilter,
  LoaderCircle,
  RadioTower,
  Search,
  Share2,
  TriangleAlert,
  WifiOff,
  WrapText,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  consoleLevels,
  consoleServices,
  createConsoleAggregateStreamStore,
  createConsoleStreamStore,
  createConsoleUiStore,
} from "@/components/console/console-stores"
import type {
  ConsoleAggregateStreamStore,
  ConsoleService,
  ConsoleStreamSnapshot,
  ConsoleStreamStore,
  ConsoleUiStore,
} from "@/components/console/console-stores"
import {
  consoleRecoveryLine,
  consoleSessionAcceptedAheadOfRuntime,
  consoleSessionIsCurrent,
  consoleStateLine,
  initialConsoleStateLines,
  isConsoleRecoveryLine,
  isConsoleStateLine,
  isConsoleStateLineFor,
  mergeConsoleHistory,
  mergeConsoleStateLines,
  reconcileConsoleLifecycleLines,
  retimestampConsoleStateLine,
  shouldAwaitConsoleRecoverySession,
  shouldRecordConsoleStateTransition,
} from "@/components/console/console-lifecycle"
import {
  openRelayConsoleStream,
  RelayConsoleConnectionError,
} from "@/lib/relay-console-stream"
import {
  completeDirectRelayCommand,
  sendDirectRelayCommand,
} from "@/lib/relay-console-command"
import {
  redactSensitiveTextWithRanges,
  type SensitiveTextRedactionRange,
} from "@/lib/redaction"
import {
  queryKeys,
  relaySnapshotQueryOptions,
  tailscaleStacksQueryOptions,
} from "@/lib/query-options"
import {
  selectInstanceContainerRunning,
  selectInstanceRelayConnected,
  selectInstanceStateReason,
} from "@/lib/relay-selectors"
import {
  selectInstanceRuntime,
  type InstanceRuntime,
  type InstanceWorkspaceInstance,
} from "@/lib/relay-selectors"
import { useInstanceRelayConnected } from "@/components/instance-workspace-context"
import { uploadConsoleLogToMclogs } from "@/server/relay"
import type { TailscaleStackOverview } from "@/server/tailscale"

const consoleTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})
const emptyTailscaleStacks: Array<TailscaleStackOverview> = []

interface CommandCompletions {
  cursor: number
  input: string
  selectedIndex: number
  status: "empty" | "loading" | "ready" | "unavailable"
  suggestions: Array<{
    label: string
    value: string
  }>
}

type ConsoleDisplayLine = RelayConsoleLine & {
  sensitiveTextRedactions?: Array<SensitiveTextRedactionRange>
}

export function ConsoleWorkspace({
  instance,
  active,
  canShare,
  canWrite,
}: {
  instance: InstanceWorkspaceInstance
  active: boolean
  canShare: boolean
  canWrite: boolean
}) {
  return (
    <ConsoleWorkspaceSession
      key={`${instance.relayId}:${instance.id}`}
      instance={instance}
      active={active}
      canShare={canShare}
      canWrite={canWrite}
    />
  )
}

function ConsoleWorkspaceSession({
  instance,
  active,
  canShare,
  canWrite,
}: {
  instance: InstanceWorkspaceInstance
  active: boolean
  canShare: boolean
  canWrite: boolean
}) {
  const tailscale = instance.implementation.toLowerCase() === "tailscale"
  const [uiStore] = React.useState(createConsoleUiStore)
  const [streamStore] = React.useState<ConsoleStreamStore>(() =>
    tailscale
      ? createConsoleAggregateStreamStore(instance.id)
      : createConsoleStreamStore()
  )

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-card">
      {tailscale ? (
        <TailscaleConsoleStreamController
          instanceId={instance.id}
          streamStore={streamStore as ConsoleAggregateStreamStore}
        />
      ) : (
        <ConsoleStreamController
          instanceId={instance.id}
          relayId={instance.relayId}
          streamStore={streamStore}
        />
      )}
      <ConsoleToolbar
        active={active}
        canShare={canShare && !tailscale}
        instance={instance}
        streamStore={streamStore}
        uiStore={uiStore}
      />
      <ConsoleLogViewportController
        active={active}
        streamStore={streamStore}
        uiStore={uiStore}
      />

      <ConsoleCommandBar
        active={active}
        canWrite={
          canWrite && instance.implementation.toLowerCase() !== "tailscale"
        }
        instance={instance}
      />
    </section>
  )
}

function ConsoleStreamController({
  instanceId,
  relayId,
  streamStore,
}: {
  instanceId: string
  relayId: string
  streamStore: ConsoleStreamStore
}) {
  const relayConnected = useInstanceRelayConnected()
  const selectRuntime = React.useMemo(
    () => selectInstanceRuntime(instanceId, relayId),
    [instanceId, relayId]
  )
  const { data: runtime } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectRuntime,
  })
  const snapshot = useRelayConsoleStream(
    relayId,
    instanceId,
    relayConnected,
    runtime
  )
  const effectiveSnapshot = React.useMemo(
    () =>
      relayConnected
        ? snapshot
        : {
            ...snapshot,
            connection: "unavailable" as const,
            error: "Hearth cannot reach this Relay right now.",
            loading: false,
          },
    [relayConnected, snapshot]
  )
  React.useLayoutEffect(
    () => streamStore.setSnapshot(effectiveSnapshot),
    [effectiveSnapshot, streamStore]
  )
  return null
}

function TailscaleConsoleStreamController({
  instanceId,
  streamStore,
}: {
  instanceId: string
  streamStore: ConsoleAggregateStreamStore
}) {
  const { data } = useQuery({
    ...tailscaleStacksQueryOptions(),
    notifyOnChangeProps: ["data"],
  })
  const stacks = data?.stacks ?? emptyTailscaleStacks
  const stack = stacks.find((candidate) => candidate.id === instanceId)

  return stack?.deployments.map((deployment) => (
    <TailscaleConsoleStreamSource
      key={deployment.relayId}
      instanceId={instanceId}
      relayId={deployment.relayId}
      relayName={deployment.relayName}
      streamStore={streamStore}
    />
  ))
}

function TailscaleConsoleStreamSource({
  instanceId,
  relayId,
  relayName,
  streamStore,
}: {
  instanceId: string
  relayId: string
  relayName: string
  streamStore: ConsoleAggregateStreamStore
}) {
  const selectRuntime = React.useMemo(
    () => selectInstanceRuntime(instanceId, relayId),
    [instanceId, relayId]
  )
  const selectConnected = React.useMemo(
    () => selectInstanceRelayConnected(instanceId, relayId),
    [instanceId, relayId]
  )
  const { data: runtime } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectRuntime,
  })
  const { data: relayConnected = false } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectConnected,
  })
  const snapshot = useRelayConsoleStream(
    relayId,
    instanceId,
    relayConnected,
    runtime
  )
  const effectiveSnapshot = React.useMemo(
    () =>
      relayConnected
        ? snapshot
        : {
            ...snapshot,
            connection: "unavailable" as const,
            error: "Hearth cannot reach this Relay right now.",
            loading: false,
          },
    [relayConnected, snapshot]
  )

  React.useLayoutEffect(() => {
    streamStore.setSourceSnapshot(
      relayId,
      { id: relayId, name: relayName },
      effectiveSnapshot
    )
  }, [effectiveSnapshot, relayId, relayName, streamStore])
  React.useEffect(
    () => () => streamStore.removeSource(relayId),
    [relayId, streamStore]
  )
  return null
}

const ConsoleLogViewportController = React.memo(
  function ConsoleLogViewportController({
    active,
    streamStore,
    uiStore,
  }: {
    active: boolean
    streamStore: ConsoleStreamStore
    uiStore: ConsoleUiStore
  }) {
    const snapshot = React.useSyncExternalStore(
      streamStore.subscribe,
      streamStore.getSnapshot,
      streamStore.getSnapshot
    )
    const { consoleData } = snapshot
    const filters = React.useSyncExternalStore(
      uiStore.subscribe,
      uiStore.getFilterSnapshot,
      uiStore.getFilterSnapshot
    )
    const filteredLines = React.useMemo(() => {
      const normalizedQuery = filters.query.trim().toLowerCase()
      const filtered: Array<ConsoleDisplayLine> = []
      for (const line of consoleData?.lines ?? []) {
        const redacted = filters.redactSensitive
          ? redactSensitiveTextWithRanges(line.text)
          : null
        const text = redacted?.text ?? line.text
        const source = line as RelayConsoleLine & {
          relayId?: string
          service?: ConsoleService
        }
        const relayMatches =
          filters.relayIds === null ||
          !source.relayId ||
          filters.relayIds.has(source.relayId)
        const service = consoleLineService(source)
        const serviceMatches =
          filters.services === null ||
          service === null ||
          filters.services.has(service)
        if (
          filters.levels.has(line.level) &&
          relayMatches &&
          serviceMatches &&
          (!normalizedQuery || text.toLowerCase().includes(normalizedQuery))
        ) {
          filtered.push(
            !redacted?.redactions.length
              ? line
              : {
                  ...line,
                  text,
                  segments: undefined,
                  sensitiveTextRedactions: redacted.redactions,
                }
          )
        }
      }
      return filtered
    }, [consoleData?.lines, filters])

    React.useLayoutEffect(() => {
      uiStore.setFilteredLines(filteredLines)
    }, [filteredLines, uiStore])

    return (
      <ConsoleLogViewport
        active={active}
        consoleData={consoleData}
        filteredLines={filteredLines}
        snapshot={snapshot}
        uiStore={uiStore}
      />
    )
  }
)

function consoleLineService(
  line: RelayConsoleLine & { service?: ConsoleService }
): ConsoleService | null {
  if (line.service) return line.service
  if (line.text.startsWith("[tailscale] ")) return "tailscale"
  if (line.text.startsWith("[coredns] ")) return "coredns"
  return null
}

interface ConsoleToolbarProps {
  active: boolean
  canShare: boolean
  instance: InstanceWorkspaceInstance
  streamStore: ConsoleStreamStore
  uiStore: ConsoleUiStore
}

const ConsoleToolbar = React.memo(function ConsoleToolbar({
  active,
  canShare,
  instance,
  streamStore,
  uiStore,
}: ConsoleToolbarProps) {
  return (
    <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2.5 sm:px-4">
      <ConsoleSearchControl uiStore={uiStore} />
      <ConsoleLevelMenu uiStore={uiStore} />
      {instance.implementation.toLowerCase() === "tailscale" ? (
        <TailscaleConsoleFilterMenus
          instanceId={instance.id}
          uiStore={uiStore}
        />
      ) : null}
      <ConsoleRuntimeReason
        instanceId={instance.id}
        relayId={instance.relayId}
      />
      <div className="ml-auto flex items-center gap-1.5">
        <ConsoleShareButton
          canShare={canShare}
          instance={instance}
          streamStore={streamStore}
          uiStore={uiStore}
        />
        <ConsoleSelectionControl active={active} uiStore={uiStore} />
        <ConsoleRedactButton uiStore={uiStore} />
        {canShare ? <ConsoleWrapButton uiStore={uiStore} /> : null}
        <ConsoleTimestampButton uiStore={uiStore} />
      </div>
    </div>
  )
})

const ConsoleRuntimeReason = React.memo(function ConsoleRuntimeReason({
  instanceId,
  relayId,
}: {
  instanceId: string
  relayId: string
}) {
  const selectReason = React.useMemo(
    () => selectInstanceStateReason(instanceId, relayId),
    [instanceId, relayId]
  )
  const { data: reason } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectReason,
  })
  return reason ? <ConsoleRuntimeReasonContent reason={reason} /> : null
})

function ConsoleRuntimeReasonContent({
  reason,
}: {
  reason: RelayInstanceStateReason
}) {
  const message = formatRelayInstanceStateReason(reason)
  return (
    <ConsoleTooltip content={message}>
      <span
        aria-label={`Server state reason: ${message}`}
        className="flex max-w-64 min-w-0 shrink items-center gap-1.5 text-[0.625rem] font-medium text-amber-300 outline-none sm:text-xs"
        role="status"
        tabIndex={0}
      >
        <TriangleAlert className="size-3.5 shrink-0" />
        <span className="hidden truncate xl:inline">{message}</span>
      </span>
    </ConsoleTooltip>
  )
}

function ConsoleSearchControl({ uiStore }: { uiStore: ConsoleUiStore }) {
  const query = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getQuerySnapshot,
    uiStore.getQuerySnapshot
  )
  return (
    <div className="relative min-w-[12rem] flex-1 sm:max-w-sm">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        onChange={(event) => uiStore.setQuery(event.target.value)}
        placeholder="Search console"
        aria-label="Search console"
        className="h-9 border-border/80 bg-background pl-8 text-base shadow-none sm:text-xs"
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear console search"
          className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          onClick={() => uiStore.setQuery("")}
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

function ConsoleLevelMenu({ uiStore }: { uiStore: ConsoleUiStore }) {
  return (
    <Popover>
      <ConsoleLevelMenuTrigger uiStore={uiStore} />
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={7}
        className="w-52 p-1"
      >
        <ConsoleLevelMenuSummary uiStore={uiStore} />
        <ConsoleLevelFilterAction
          label="All levels"
          level="all"
          uiStore={uiStore}
        />
        <div className="my-1 border-t" />
        {consoleLevels.map((level) => (
          <ConsoleLevelFilterAction
            key={level}
            level={level}
            label={level}
            uiStore={uiStore}
          />
        ))}
      </PopoverContent>
    </Popover>
  )
}

function useConsoleLevelCount(uiStore: ConsoleUiStore) {
  const getLevelCountSnapshot = React.useCallback(
    () => uiStore.getLevelsSnapshot().size,
    [uiStore]
  )
  return React.useSyncExternalStore(
    uiStore.subscribe,
    getLevelCountSnapshot,
    getLevelCountSnapshot
  )
}

function ConsoleLevelMenuTrigger({ uiStore }: { uiStore: ConsoleUiStore }) {
  const levelCount = useConsoleLevelCount(uiStore)
  const allLevels = levelCount === consoleLevels.length

  return (
    <ConsoleTooltip content="Filter Log Level">
      <PopoverTrigger asChild>
        <Button
          variant={allLevels ? "ghost" : "secondary"}
          size="icon"
          className="relative size-9 shrink-0"
          aria-label={
            allLevels
              ? "Filter console levels"
              : `Filter console levels, ${levelCount} active`
          }
        >
          <ListFilter />
          {!allLevels ? (
            <span
              className="absolute top-1 right-1 size-1.5 bg-primary"
              aria-hidden="true"
            />
          ) : null}
        </Button>
      </PopoverTrigger>
    </ConsoleTooltip>
  )
}

function ConsoleLevelMenuSummary({ uiStore }: { uiStore: ConsoleUiStore }) {
  const levelCount = useConsoleLevelCount(uiStore)

  return (
    <div className="flex items-center justify-between border-b px-2 py-2">
      <p className="text-[0.625rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
        Console levels
      </p>
      <span className="font-mono text-[0.5625rem] text-muted-foreground/75 tabular-nums">
        {levelCount}/{consoleLevels.length}
      </span>
    </div>
  )
}

function ConsoleLevelFilterAction({
  label,
  level,
  uiStore,
}: {
  label: string
  level: RelayConsoleLevel | "all"
  uiStore: ConsoleUiStore
}) {
  const getActiveSnapshot = React.useCallback(() => {
    const levels = uiStore.getLevelsSnapshot()
    return level === "all"
      ? levels.size === consoleLevels.length
      : levels.has(level)
  }, [level, uiStore])
  const active = React.useSyncExternalStore(
    uiStore.subscribe,
    getActiveSnapshot,
    getActiveSnapshot
  )

  return (
    <ConsoleLevelFilter
      active={active}
      label={label}
      level={level === "all" ? undefined : level}
      onClick={() => uiStore.toggleLevel(level)}
    />
  )
}

function TailscaleConsoleFilterMenus({
  instanceId,
  uiStore,
}: {
  instanceId: string
  uiStore: ConsoleUiStore
}) {
  const { data } = useQuery({
    ...tailscaleStacksQueryOptions(),
    notifyOnChangeProps: ["data"],
  })
  const stacks = data?.stacks ?? emptyTailscaleStacks
  const relays = React.useMemo(() => {
    const stack = stacks.find((candidate) => candidate.id === instanceId)
    return (
      stack?.deployments.map(({ relayId, relayName }) => ({
        id: relayId,
        label: relayName,
      })) ?? []
    )
  }, [instanceId, stacks])

  return (
    <>
      <ConsoleRelayMenu relays={relays} uiStore={uiStore} />
      <ConsoleServiceMenu uiStore={uiStore} />
    </>
  )
}

function ConsoleRelayMenu({
  relays,
  uiStore,
}: {
  relays: Array<{ id: string; label: string }>
  uiStore: ConsoleUiStore
}) {
  const selected = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getRelayIdsSnapshot,
    uiStore.getRelayIdsSnapshot
  )
  const all = selected === null
  const relayIds = React.useMemo(() => relays.map(({ id }) => id), [relays])

  return (
    <Popover>
      <ConsoleTooltip content="Filter Relay">
        <PopoverTrigger asChild>
          <Button
            variant={all ? "ghost" : "secondary"}
            size="icon"
            className="relative size-9 shrink-0"
            aria-label={
              all
                ? "Filter console relays"
                : `Filter console relays, ${selected.size} active`
            }
          >
            <RadioTower />
            {!all ? (
              <span
                className="absolute top-1 right-1 size-1.5 bg-primary"
                aria-hidden="true"
              />
            ) : null}
          </Button>
        </PopoverTrigger>
      </ConsoleTooltip>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={7}
        className="w-56 p-1"
      >
        <ConsoleFilterMenuSummary
          active={selected?.size ?? relays.length}
          label="Relays"
          total={relays.length}
        />
        <ConsoleLevelFilter
          active={all}
          label="All relays"
          onClick={() => uiStore.toggleRelay("all", relayIds)}
        />
        <div className="my-1 border-t" />
        {relays.map((relay) => (
          <ConsoleLevelFilter
            key={relay.id}
            active={all || selected.has(relay.id)}
            label={relay.label}
            onClick={() => uiStore.toggleRelay(relay.id, relayIds)}
          />
        ))}
      </PopoverContent>
    </Popover>
  )
}

function ConsoleServiceMenu({ uiStore }: { uiStore: ConsoleUiStore }) {
  const selected = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getServicesSnapshot,
    uiStore.getServicesSnapshot
  )
  const all = selected === null

  return (
    <Popover>
      <ConsoleTooltip content="Filter Service">
        <PopoverTrigger asChild>
          <Button
            variant={all ? "ghost" : "secondary"}
            size="icon"
            className="relative size-9 shrink-0"
            aria-label={
              all
                ? "Filter console services"
                : `Filter console services, ${selected.size} active`
            }
          >
            <Boxes />
            {!all ? (
              <span
                className="absolute top-1 right-1 size-1.5 bg-primary"
                aria-hidden="true"
              />
            ) : null}
          </Button>
        </PopoverTrigger>
      </ConsoleTooltip>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={7}
        className="w-52 p-1"
      >
        <ConsoleFilterMenuSummary
          active={selected?.size ?? consoleServices.length}
          label="Services"
          total={consoleServices.length}
        />
        <ConsoleLevelFilter
          active={all}
          label="All services"
          onClick={() => uiStore.toggleService("all")}
        />
        <div className="my-1 border-t" />
        {consoleServices.map((service) => (
          <ConsoleLevelFilter
            key={service}
            active={all || selected.has(service)}
            label={service === "coredns" ? "CoreDNS" : "Tailscale"}
            onClick={() => uiStore.toggleService(service)}
          />
        ))}
      </PopoverContent>
    </Popover>
  )
}

function ConsoleFilterMenuSummary({
  active,
  label,
  total,
}: {
  active: number
  label: string
  total: number
}) {
  return (
    <div className="flex items-center justify-between border-b px-2 py-2">
      <p className="text-[0.625rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </p>
      <span className="font-mono text-[0.5625rem] text-muted-foreground/75 tabular-nums">
        {active}/{total}
      </span>
    </div>
  )
}

function ConsoleShareButton({
  canShare,
  instance,
  streamStore,
  uiStore,
}: {
  canShare: boolean
  instance: InstanceWorkspaceInstance
  streamStore: ConsoleStreamStore
  uiStore: ConsoleUiStore
}) {
  const relayConnected = useInstanceRelayConnected()
  const [state, setState] = React.useState<
    "idle" | "uploading" | "copied" | "error"
  >("idle")
  const resetTimer = React.useRef<number | null>(null)
  const hasLines = React.useSyncExternalStore(
    streamStore.subscribe,
    streamStore.getHasLinesSnapshot,
    streamStore.getHasLinesSnapshot
  )
  React.useEffect(
    () => () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
    },
    []
  )
  if (!canShare || !relayConnected) return null

  async function handleShare() {
    setState("uploading")
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          const result = await uploadConsoleLogToMclogs({
            data: {
              instanceId: instance.id,
              relayId: instance.relayId,
              implementation: instance.implementation,
              version: instance.version,
              redactSensitive: uiStore.getRedactSensitiveSnapshot(),
            },
          })
          await copyToClipboard(result.url)
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: () => setState("error"),
          onSuccess: () => setState("copied"),
        })
      )
    )
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setState("idle"), 2800)
  }

  return (
    <ConsoleTooltip content={shareTooltip(state)}>
      <Button
        variant={
          state === "copied"
            ? "secondary"
            : state === "error"
              ? "destructive"
              : "ghost"
        }
        size="sm"
        className="h-8 gap-1.5 px-2.5 text-[0.6875rem]"
        disabled={state === "uploading" || !hasLines}
        onClick={handleShare}
      >
        {state === "uploading" ? (
          <LoaderCircle className="animate-spin" />
        ) : state === "copied" ? (
          <Check />
        ) : state === "error" ? (
          <TriangleAlert />
        ) : (
          <Share2 />
        )}
        {shareLabel(state)}
      </Button>
    </ConsoleTooltip>
  )
}

function ConsoleSelectionControl({
  active,
  uiStore,
}: {
  active: boolean
  uiStore: ConsoleUiStore
}) {
  const selected = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getSelectedSnapshot,
    uiStore.getSelectedSnapshot
  )
  const [copiedSelection, setCopiedSelection] =
    React.useState<Set<string> | null>(null)
  const resetTimer = React.useRef<number | null>(null)
  const selectedCount = selected.size
  const copied = copiedSelection === selected

  React.useEffect(() => {
    if (!active || selectedCount === 0) return
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") uiStore.clearSelection()
    }
    window.addEventListener("keydown", handleEscape, { capture: true })
    return () => window.removeEventListener("keydown", handleEscape, true)
  }, [active, selectedCount, uiStore])

  React.useEffect(
    () => () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
    },
    []
  )

  async function handleCopy() {
    await copyToClipboard(uiStore.getSelectedText())
    setCopiedSelection(selected)
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setCopiedSelection(null), 1800)
  }

  return (
    <Popover open={selectedCount > 0}>
      <PopoverAnchor asChild>
        <span className="inline-flex">
          <ConsoleTooltip
            content={copied ? "Selected Lines Copied" : "Copy Selected Lines"}
          >
            <Button
              variant={copied ? "secondary" : "ghost"}
              size="icon"
              className="size-8"
              aria-label={
                selectedCount > 0
                  ? `Copy ${selectedCount} Selected ${selectedCount === 1 ? "Line" : "Lines"}`
                  : "Copy Selected Lines"
              }
              disabled={selectedCount === 0}
              onClick={handleCopy}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </ConsoleTooltip>
        </span>
      </PopoverAnchor>
      <PopoverContent
        align="center"
        side="bottom"
        sideOffset={7}
        className="flex w-auto min-w-36 items-center gap-2 px-2.5 py-2"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={uiStore.clearSelection}
      >
        <span
          className="font-mono text-[0.625rem] whitespace-nowrap text-muted-foreground"
          aria-live="polite"
        >
          {copied
            ? `${selectedCount} ${selectedCount === 1 ? "line" : "lines"} copied`
            : `${selectedCount} ${selectedCount === 1 ? "line" : "lines"} selected`}
        </span>
        <ConsoleTooltip content="Clear Selection">
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Clear selected console lines"
            onClick={uiStore.clearSelection}
          >
            <X className="size-3.5" />
          </Button>
        </ConsoleTooltip>
      </PopoverContent>
    </Popover>
  )
}

function ConsoleRedactButton({ uiStore }: { uiStore: ConsoleUiStore }) {
  const redactSensitive = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getRedactSensitiveSnapshot,
    uiStore.getRedactSensitiveSnapshot
  )
  return (
    <ConsoleTooltip content={redactSensitive ? "Show IPs" : "Censor IPs"}>
      <Button
        variant={redactSensitive ? "secondary" : "ghost"}
        size="icon"
        className="size-8"
        aria-label={redactSensitive ? "Show IPs" : "Censor IPs"}
        aria-pressed={redactSensitive}
        onClick={uiStore.toggleRedactSensitive}
      >
        <EyeOff />
      </Button>
    </ConsoleTooltip>
  )
}

function ConsoleWrapButton({ uiStore }: { uiStore: ConsoleUiStore }) {
  const wrapLines = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getWrapLinesSnapshot,
    uiStore.getWrapLinesSnapshot
  )
  return (
    <ConsoleTooltip
      content={wrapLines ? "Disable Line Wrap" : "Enable Line Wrap"}
    >
      <Button
        variant={wrapLines ? "secondary" : "ghost"}
        size="icon"
        className="size-8"
        aria-label={wrapLines ? "Disable Line Wrap" : "Enable Line Wrap"}
        aria-pressed={wrapLines}
        onClick={uiStore.toggleWrapLines}
      >
        <WrapText />
      </Button>
    </ConsoleTooltip>
  )
}

function ConsoleTimestampButton({ uiStore }: { uiStore: ConsoleUiStore }) {
  const showTimestamps = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getShowTimestampsSnapshot,
    uiStore.getShowTimestampsSnapshot
  )
  return (
    <ConsoleTooltip
      content={showTimestamps ? "Hide Timestamps" : "Show Timestamps"}
    >
      <Button
        variant={showTimestamps ? "secondary" : "ghost"}
        size="icon"
        className="size-8"
        aria-label={showTimestamps ? "Hide timestamps" : "Show timestamps"}
        onClick={uiStore.toggleShowTimestamps}
      >
        <Clock3 />
      </Button>
    </ConsoleTooltip>
  )
}

interface ConsoleLogViewportProps {
  active: boolean
  consoleData: RelayConsole | null
  filteredLines: Array<ConsoleDisplayLine>
  snapshot: ConsoleStreamSnapshot
  uiStore: ConsoleUiStore
}

function ConsoleLogViewport({
  active,
  consoleData,
  filteredLines,
  snapshot,
  uiStore,
}: ConsoleLogViewportProps) {
  const { connection, error, loading, transport } = snapshot
  const [autoScroll, setAutoScroll] = React.useState(true)
  const query = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getQuerySnapshot,
    uiStore.getQuerySnapshot
  )
  const showTimestamps = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getShowTimestampsSnapshot,
    uiStore.getShowTimestampsSnapshot
  )
  const wrapLines = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getWrapLinesSnapshot,
    uiStore.getWrapLinesSnapshot
  )
  const parentRef = React.useRef<HTMLDivElement>(null)
  const programmaticScroll = React.useRef(false)
  const rowVirtualizer = useVirtualizer({
    count: filteredLines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 30,
    getItemKey: (index) => filteredLines[index]?.id ?? index,
    overscan: 18,
    anchorTo: "end",
    followOnAppend: true,
  })
  const rowVirtualizerRef = React.useRef(rowVirtualizer)
  React.useLayoutEffect(() => {
    rowVirtualizerRef.current = rowVirtualizer
  }, [rowVirtualizer])
  const measureRow = React.useCallback((element: Element | null) => {
    rowVirtualizerRef.current.measureElement(element)
  }, [])

  React.useLayoutEffect(() => {
    if (active) rowVirtualizer.measure()
  }, [active, rowVirtualizer, wrapLines])

  React.useLayoutEffect(() => {
    if (!active || !autoScroll || filteredLines.length === 0 || loading) return
    programmaticScroll.current = true
    rowVirtualizer.scrollToIndex(filteredLines.length - 1, { align: "end" })
    const frame = window.requestAnimationFrame(() => {
      programmaticScroll.current = false
    })
    return () => window.cancelAnimationFrame(frame)
  }, [active, autoScroll, filteredLines.length, loading, rowVirtualizer])

  function resumeAutoScroll() {
    setAutoScroll(true)
    programmaticScroll.current = true
    if (filteredLines.length > 0) {
      rowVirtualizer.scrollToIndex(filteredLines.length - 1, { align: "end" })
    }
    window.requestAnimationFrame(() => {
      programmaticScroll.current = false
    })
  }

  return (
    <div className="relative min-h-0 flex-1 bg-background">
      <div
        ref={parentRef}
        className={`[container-type:inline-size] absolute inset-0 overscroll-contain font-mono text-[0.6875rem] selection:bg-primary/25 sm:text-xs ${wrapLines ? "overflow-x-hidden overflow-y-auto" : "overflow-auto"}`}
        onScroll={(event) => {
          if (programmaticScroll.current) return
          const viewport = event.currentTarget
          const distanceFromBottom =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
          if (distanceFromBottom <= 8) {
            if (!autoScroll) setAutoScroll(true)
            return
          }
          if (autoScroll && distanceFromBottom > 72) setAutoScroll(false)
        }}
      >
        <div
          className={wrapLines ? "relative w-full" : "relative min-w-max"}
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const line = filteredLines.at(virtualRow.index)
            if (!line) return null
            return (
              <ConsoleLogRow
                key={line.id}
                index={virtualRow.index}
                line={line}
                measureElement={measureRow}
                query={query}
                showTimestamps={showTimestamps}
                start={virtualRow.start}
                uiStore={uiStore}
                wrapLines={wrapLines}
              />
            )
          })}
        </div>
      </div>

      {!autoScroll ? (
        <div className="absolute right-4 bottom-4 z-20">
          <ConsoleTooltip content="Jump to the latest output and resume following.">
            <Button
              size="icon-lg"
              className="shadow-xl shadow-black/35"
              aria-label="Jump to latest output"
              onClick={resumeAutoScroll}
            >
              <ArrowDown />
            </Button>
          </ConsoleTooltip>
        </div>
      ) : null}

      <ConsoleConnectionNotice
        connection={connection}
        hasConsoleData={Boolean(consoleData)}
        transport={transport}
      />

      {loading && !consoleData ? (
        <div className="absolute inset-0 grid place-items-center bg-card/70 backdrop-blur-[2px]">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin text-primary" />
            Opening live console stream
          </div>
        </div>
      ) : null}
      {!loading && !consoleData && connection === "unavailable" ? (
        <div className="absolute inset-0 grid place-items-center text-center">
          <div className="max-w-xs">
            <WifiOff className="mx-auto size-5 text-amber-300" />
            <p className="mt-3 text-sm font-semibold">Console unavailable</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {error ?? "The console stream could not be opened."}
            </p>
          </div>
        </div>
      ) : null}
      {!loading && consoleData && filteredLines.length === 0 ? (
        <div className="absolute inset-0 grid place-items-center text-center">
          <div>
            <p className="text-sm font-semibold">No matching output</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Adjust the search or log-level filters.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}

const ConsoleConnectionNotice = React.memo(function ConsoleConnectionNotice({
  connection,
  hasConsoleData,
  transport,
}: {
  connection: ConsoleStreamSnapshot["connection"]
  hasConsoleData: boolean
  transport: ConsoleStreamSnapshot["transport"]
}) {
  if (!hasConsoleData) return null
  if (connection === "opening") return <DelayedConsoleOpeningNotice />
  if (connection === "live" && transport !== "hearth") return null

  const message =
    connection === "reconnecting"
      ? "RECONNECTING · OUTPUT MAY BE DELAYED"
      : connection === "live"
        ? "CONNECTED THROUGH HEARTH · DIRECT RELAY UNAVAILABLE"
        : "LIVE OUTPUT PAUSED"

  return <ConsoleConnectionNoticeContent message={message} />
})

function DelayedConsoleOpeningNotice() {
  const [visible, setVisible] = React.useState(false)
  React.useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 500)
    return () => window.clearTimeout(timer)
  }, [])
  return visible ? (
    <ConsoleConnectionNoticeContent
      loading
      message="CONNECTING TO LIVE OUTPUT…"
    />
  ) : null
}

function ConsoleConnectionNoticeContent({
  loading = false,
  message,
}: {
  loading?: boolean
  message: string
}) {
  return (
    <div className="pointer-events-none absolute top-3 left-1/2 z-20 -translate-x-1/2">
      <div className="flex items-center gap-1.5 border border-amber-400/20 bg-stone-950/90 px-2.5 py-1.5 font-mono text-[0.5625rem] text-amber-200 shadow-lg shadow-black/35 backdrop-blur-sm">
        {loading ? (
          <LoaderCircle className="size-3 animate-spin" />
        ) : (
          <WifiOff className="size-3" />
        )}
        {message}
      </div>
    </div>
  )
}

const ConsoleLogRow = React.memo(function ConsoleLogRow({
  index,
  line,
  measureElement,
  query,
  showTimestamps,
  start,
  uiStore,
  wrapLines,
}: {
  index: number
  line: ConsoleDisplayLine
  measureElement: (element: Element | null) => void
  query: string
  showTimestamps: boolean
  start: number
  uiStore: ConsoleUiStore
  wrapLines: boolean
}) {
  const getSelectedSnapshot = React.useCallback(
    () => uiStore.getLineSelectedSnapshot(line.id),
    [line.id, uiStore]
  )
  const selected = React.useSyncExternalStore(
    uiStore.subscribe,
    getSelectedSnapshot,
    getSelectedSnapshot
  )
  const stateLine = isConsoleStateLine(line)

  function toggle(shift: boolean) {
    uiStore.toggleLine(line, index, shift)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      ref={measureElement}
      data-index={index}
      className={`absolute top-0 left-0 flex min-h-[30px] transition-colors ${stateLine ? "border-l-0 pr-0 text-center" : "border-l-2 pr-5 text-left"} ${wrapLines ? "w-full items-start py-1.5 whitespace-pre-wrap" : "h-[30px] min-w-full items-center whitespace-nowrap"} ${lineTone(line.level, selected, stateLine)}`}
      style={{
        top: start,
        width: wrapLines ? "100%" : "max(100%, max-content)",
      }}
      onClick={(event) => toggle(event.shiftKey)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          toggle(event.shiftKey)
        }
      }}
    >
      {showTimestamps && !stateLine ? (
        <ConsoleTimestamp timestamp={line.timestamp} />
      ) : null}
      <span
        className={`${stateLine ? "sticky left-0 w-[100cqw] shrink-0 px-3 text-center" : `min-w-0 flex-1 ${showTimestamps ? "" : "ml-3"}`} leading-[18px] ${wrapLines ? "break-words" : ""} ${lineTextTone(line.level)}`}
      >
        {stateLine ? (
          <span className="mx-auto flex w-[min(76%,44rem)] items-center gap-3 before:min-w-0 before:flex-1 before:border-t before:border-stone-500/20 after:min-w-0 after:flex-1 after:border-t after:border-stone-500/20">
            <span className="shrink-0">{renderConsoleText(line, query)}</span>
          </span>
        ) : (
          renderConsoleText(line, query)
        )}
      </span>
    </div>
  )
})

const ConsoleCommandBar = React.memo(function ConsoleCommandBar({
  active,
  canWrite,
  instance,
}: {
  active: boolean
  canWrite: boolean
  instance: InstanceWorkspaceInstance
}) {
  const relayConnected = useInstanceRelayConnected()
  const selectContainerRunning = React.useMemo(
    () => selectInstanceContainerRunning(instance.id, instance.relayId),
    [instance.id, instance.relayId]
  )
  const { data: containerRunning = false } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectContainerRunning,
  })
  const command = useConsoleCommand(
    instance.id,
    instance.relayId,
    active,
    containerRunning,
    relayConnected
  )

  return (
    <div className="shrink-0 border-t bg-background/80 px-3 py-3 sm:px-4">
      {canWrite ? (
        <form className="flex items-center gap-2" onSubmit={command.submit}>
          <span className="hidden font-mono text-xs font-semibold text-primary sm:inline">
            &gt;
          </span>
          <Popover
            open={Boolean(command.completions)}
            onOpenChange={(open) => {
              if (!open) command.stopCompletions()
            }}
          >
            <PopoverAnchor asChild>
              <div className="min-w-0 flex-1">
                <Input
                  ref={command.inputRef}
                  onChange={command.change}
                  onBlur={command.stopCompletions}
                  onKeyDown={command.keyDown}
                  placeholder={
                    !command.running
                      ? "Server is stopped"
                      : !command.available
                        ? "Relay disconnected — command saved as a draft"
                        : "Send a server command…"
                  }
                  role="combobox"
                  aria-label="Server command"
                  aria-autocomplete="list"
                  aria-controls="console-command-completions"
                  aria-expanded={Boolean(command.completions)}
                  aria-invalid={Boolean(command.error)}
                  aria-keyshortcuts="Tab ArrowUp ArrowDown Escape"
                  aria-activedescendant={
                    command.completions?.status === "ready"
                      ? `console-completion-${command.completions.selectedIndex}`
                      : undefined
                  }
                  disabled={!command.running}
                  title={command.error ?? undefined}
                  autoFocus
                  autoComplete="off"
                  className="h-10 border-border/80 bg-card font-mono text-base shadow-none sm:text-xs"
                />
              </div>
            </PopoverAnchor>
            <PopoverContent
              ref={command.completionListRef}
              id="console-command-completions"
              role="listbox"
              align="start"
              side="top"
              sideOffset={7}
              className="max-h-[13.25rem] w-[var(--radix-popover-trigger-width)] min-w-64 overflow-y-scroll p-1 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:bg-muted-foreground/55 [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/75 [&::-webkit-scrollbar-track]:bg-foreground/10"
              style={{
                scrollbarColor:
                  "color-mix(in oklab, var(--muted-foreground) 55%, transparent) color-mix(in oklab, var(--foreground) 10%, transparent)",
                scrollbarGutter: "stable",
              }}
              aria-busy={command.completions?.status === "loading"}
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              {command.completions?.status === "loading" ? (
                <div
                  role="status"
                  className="flex items-center gap-2 px-2.5 py-2 font-mono text-xs text-muted-foreground"
                >
                  <LoaderCircle className="size-3.5 animate-spin text-primary/75" />
                  Waiting for completions…
                </div>
              ) : command.completions?.status === "empty" ? (
                <div
                  role="status"
                  className="px-2.5 py-2 font-mono text-xs text-muted-foreground"
                >
                  No completions
                </div>
              ) : command.completions?.status === "unavailable" ? (
                <div
                  role="status"
                  className="px-2.5 py-2 font-mono text-xs text-muted-foreground"
                >
                  Completions unavailable
                </div>
              ) : (
                command.completions?.suggestions.map((suggestion, index) => (
                  <button
                    id={`console-completion-${index}`}
                    role="option"
                    aria-selected={index === command.completions?.selectedIndex}
                    type="button"
                    key={suggestion.value}
                    className={`block w-full px-2.5 py-2 text-left font-mono text-xs ${
                      index === command.completions?.selectedIndex
                        ? "bg-popover-accent text-popover-accent-foreground"
                        : "text-muted-foreground hover:bg-muted/55 hover:text-foreground"
                    }`}
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerMove={() => command.selectCompletion(index)}
                    onClick={() => command.applyCompletion(suggestion.value)}
                  >
                    {suggestion.label}
                  </button>
                ))
              )}
            </PopoverContent>
          </Popover>
          <Button
            ref={command.sendButtonRef}
            type="submit"
            size="sm"
            className="h-10 gap-1.5 px-4 text-xs"
            disabled={
              !command.running ||
              !command.available ||
              !command.inputRef.current?.value.trim() ||
              command.sending
            }
          >
            {command.sending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <CornerDownLeft />
            )}
            Send
          </Button>
        </form>
      ) : (
        <div className="flex h-10 items-center gap-2 font-mono text-[0.625rem] text-muted-foreground">
          <EyeOff className="size-3.5" /> Read-only console access
        </div>
      )}
    </div>
  )
})

function useConsoleCommand(
  instanceId: string,
  relayId: string,
  active: boolean,
  running: boolean,
  available: boolean
) {
  const [error, setError] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [sending, setSending] = React.useState(false)
  const sendButtonRef = React.useRef<HTMLButtonElement>(null)
  const setValue = usePersistedCommand(
    instanceId,
    inputRef,
    sendButtonRef,
    running && available,
    sending
  )
  const { navigateHistory, recordCommand } = useCommandHistory(instanceId)
  const [completions, setCompletions] =
    React.useState<CommandCompletions | null>(null)
  const completionListRef = React.useRef<HTMLDivElement>(null)
  const completionSessionActive = React.useRef(false)
  const completionRequest = React.useRef(0)
  const completionPending = React.useRef({ cursor: -1, input: "" })
  const selectedCompletionIndex =
    completions?.status === "ready" ? completions.selectedIndex : null
  React.useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active, instanceId])

  React.useEffect(() => {
    if (selectedCompletionIndex === null) return
    let scrollFrame = 0
    const selectionFrame = window.requestAnimationFrame(() => {
      scrollFrame = window.requestAnimationFrame(() => {
        const selectedOption =
          completionListRef.current?.querySelector<HTMLElement>(
            `#console-completion-${selectedCompletionIndex}`
          )
        selectedOption?.scrollIntoView({ block: "nearest", inline: "nearest" })
      })
    })
    return () => {
      window.cancelAnimationFrame(selectionFrame)
      window.cancelAnimationFrame(scrollFrame)
    }
  }, [selectedCompletionIndex])

  function stopCompletions() {
    completionSessionActive.current = false
    completionRequest.current += 1
    completionPending.current = { cursor: -1, input: "" }
    setCompletions(null)
  }

  function applyCompletion(suggestion: string) {
    if (!completions || completions.status !== "ready") return
    const prefix = completions.input.slice(0, completions.cursor)
    const suffix = completions.input.slice(completions.cursor)
    const completedPrefix = mergeCommandCompletion(prefix, suggestion)
    setCompletions(null)
    setValue(`${completedPrefix}${suffix}`)
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(
        completedPrefix.length,
        completedPrefix.length
      )
    })
  }

  async function requestCompletion(
    input: string,
    cursor: number,
    activateSession = false
  ) {
    if (
      completionPending.current.input === input &&
      completionPending.current.cursor === cursor
    ) {
      return
    }
    const requestId = completionRequest.current + 1
    completionRequest.current = requestId
    completionPending.current = { cursor, input }
    setCompletions({
      cursor,
      input,
      selectedIndex: 0,
      status: "loading",
      suggestions: [],
    })
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          completeDirectRelayCommand(relayId, instanceId, input, cursor),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (completionRequest.current !== requestId) return
            if (!result.supported) {
              completionSessionActive.current = false
              setCompletions(null)
              return
            }
            if (activateSession) completionSessionActive.current = true

            const currentInput = inputRef.current
            if (!currentInput || currentInput.value !== input) {
              if (activateSession && currentInput) {
                void requestCompletion(
                  currentInput.value,
                  currentInput.selectionStart ?? currentInput.value.length
                )
              }
              return
            }
            const suggestionValues = [...result.suggestions]
            if (
              result.completedPrefix &&
              !suggestionValues.includes(result.completedPrefix)
            ) {
              suggestionValues.unshift(result.completedPrefix)
            }
            const prefix = input.slice(0, cursor)
            const suggestions = suggestionValues.map((suggestion) => ({
              label: commandCompletionLabel(prefix, suggestion),
              value: suggestion,
            }))
            setCompletions({
              cursor,
              input,
              selectedIndex: 0,
              status: suggestions.length > 0 ? "ready" : "empty",
              suggestions,
            })
          })
        ),
        Effect.catch(() =>
          Effect.sync(() => {
            if (completionRequest.current === requestId) {
              if (activateSession) completionSessionActive.current = false
              setCompletions({
                cursor,
                input,
                selectedIndex: 0,
                status: "unavailable",
                suggestions: [],
              })
            }
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (
              completionPending.current.input === input &&
              completionPending.current.cursor === cursor
            ) {
              completionPending.current = { cursor: -1, input: "" }
            }
          })
        )
      )
    )
  }

  function navigate(event: React.KeyboardEvent<HTMLInputElement>) {
    if (
      (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
      event.nativeEvent.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return
    }
    const nextCommand = navigateHistory(
      event.key === "ArrowUp" ? "previous" : "next",
      event.currentTarget.value
    )
    if (nextCommand === undefined) return
    event.preventDefault()
    setCompletions(null)
    setValue(nextCommand)
    window.requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      input.setSelectionRange(input.value.length, input.value.length)
      if (completionSessionActive.current) {
        void requestCompletion(nextCommand, nextCommand.length)
      }
    })
  }

  function keyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return
    if (
      event.key === "Escape" &&
      (completionSessionActive.current || completions)
    ) {
      event.preventDefault()
      stopCompletions()
      return
    }
    if (completions?.status === "ready") {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const direction = event.key === "ArrowDown" ? 1 : -1
        setCompletions((current) =>
          current
            ? {
                ...current,
                selectedIndex: Math.min(
                  Math.max(current.selectedIndex + direction, 0),
                  current.suggestions.length - 1
                ),
              }
            : current
        )
        return
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault()
        const suggestion = completions.suggestions[completions.selectedIndex]
        applyCompletion(suggestion.value)
        return
      }
    }
    if (
      event.key === "Tab" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      running &&
      available
    ) {
      event.preventDefault()
      void requestCompletion(
        event.currentTarget.value,
        event.currentTarget.selectionStart ?? event.currentTarget.value.length,
        true
      )
      return
    }
    navigate(event)
  }

  function change(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget.value
    const cursor = event.currentTarget.selectionStart ?? input.length
    setError(null)
    setValue(input)
    if (completionSessionActive.current) {
      void requestCompletion(input, cursor)
    } else {
      setCompletions(null)
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const command = inputRef.current?.value.trim() ?? ""
    if (!command || !running || !available || sending) return
    stopCompletions()
    recordCommand(command)
    setValue("")
    window.requestAnimationFrame(() => inputRef.current?.focus())
    setSending(true)
    await Effect.runPromise(
      Effect.tryPromise({
        try: () => sendDirectRelayCommand(relayId, instanceId, command),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap(() => Effect.sync(() => setError(null))),
        Effect.catch((cause) =>
          Effect.sync(() => {
            setError(cause instanceof Error ? cause.message : "Command failed")
            setValue(command)
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            setSending(false)
            window.requestAnimationFrame(() => inputRef.current?.focus())
          })
        )
      )
    )
  }

  function selectCompletion(index: number) {
    setCompletions((current) =>
      current ? { ...current, selectedIndex: index } : current
    )
  }

  return {
    applyCompletion,
    available,
    change,
    completionListRef,
    completions,
    error,
    inputRef,
    keyDown,
    running,
    sendButtonRef,
    selectCompletion,
    sending,
    stopCompletions,
    submit,
  }
}

function ConsoleLevelFilter({
  active,
  level,
  label,
  onClick,
}: {
  active: boolean
  level?: RelayConsoleLevel
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 px-2 py-2 text-left text-xs text-foreground transition-colors hover:bg-popover-accent/80 focus-visible:bg-popover-accent focus-visible:outline-none"
      aria-pressed={active}
      onClick={onClick}
    >
      <span
        className={`grid size-4 shrink-0 place-items-center border ${active ? "border-primary/45 bg-primary/12 text-primary" : "border-border bg-background text-transparent"}`}
      >
        <Check className="size-3" />
      </span>
      {level ? (
        <span
          className={`size-1.5 shrink-0 ${consoleLevelFilterTone(level)}`}
          aria-hidden="true"
        />
      ) : (
        <span
          className="size-1.5 shrink-0 bg-foreground/35"
          aria-hidden="true"
        />
      )}
      <span className="flex-1 capitalize">{label}</span>
    </button>
  )
}

function consoleLevelFilterTone(level: RelayConsoleLevel): string {
  if (level === "error") return "bg-red-400"
  if (level === "warn") return "bg-amber-400"
  if (level === "info") return "bg-sky-400"
  if (level === "debug") return "bg-emerald-400/90"
  return "bg-violet-400/90"
}

function shareTooltip(
  state: "idle" | "uploading" | "copied" | "error"
): string {
  if (state === "uploading") return "Uploading to mclo.gs"
  if (state === "copied") return "Link Copied"
  if (state === "error") return "Retry mclo.gs Upload"
  return "Upload to mclo.gs"
}

function shareLabel(state: "idle" | "uploading" | "copied" | "error"): string {
  if (state === "uploading") return "Uploading"
  if (state === "copied") return "Link copied"
  if (state === "error") return "Try again"
  return "mclo.gs"
}

function ConsoleTooltip({
  content,
  children,
}: {
  content: string
  children: React.ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {content}
      </TooltipContent>
    </Tooltip>
  )
}

function lineTone(
  level: RelayConsoleLevel,
  selected: boolean,
  stateLine = false
): string {
  if (selected) return "border-primary bg-primary/10"
  if (stateLine) return "bg-transparent hover:bg-transparent"
  if (level === "error")
    return "border-red-400/65 bg-red-500/7 hover:bg-red-500/12"
  if (level === "warn")
    return "border-amber-400/45 bg-amber-400/5 hover:bg-amber-400/10"
  return "border-transparent hover:bg-white/[0.025]"
}

function lineTextTone(level: RelayConsoleLevel): string {
  if (level === "error") return "text-red-200"
  if (level === "warn") return "text-amber-100"
  if (level === "debug" || level === "trace") return "text-muted-foreground"
  return "text-foreground/88"
}

function ConsoleTimestamp({ timestamp }: { timestamp: string | null }) {
  const formattedTimestamp = React.useSyncExternalStore(
    subscribeToBrowserLocale,
    () => formatTimestamp(timestamp),
    () => "--:--:--"
  )

  return (
    <span className="mr-2 ml-3 w-[3.25rem] shrink-0 text-[0.5625rem] text-muted-foreground/65 tabular-nums">
      {formattedTimestamp}
    </span>
  )
}

function subscribeToBrowserLocale(): () => void {
  // Locale has no browser change event; this store only defers formatting until hydration.
  return () => undefined
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) return "--:--:--"
  return consoleTimestampFormatter.format(new Date(timestamp))
}

function renderConsoleText(
  line: Pick<
    ConsoleDisplayLine,
    "segments" | "sensitiveTextRedactions" | "text"
  >,
  query: string
): React.ReactNode {
  if (!line.segments?.length) {
    return renderConsoleTextPart(line.text, query, line.sensitiveTextRedactions)
  }
  let offset = 0
  return line.segments.map((segment) => {
    const start = offset
    offset += segment.text.length
    return (
      <span
        key={`${start}-${segment.text}`}
        style={consoleSegmentStyle(segment)}
      >
        {renderConsoleTextPart(segment.text, query)}
      </span>
    )
  })
}

function consoleSegmentStyle(
  segment: RelayConsoleSegment
): React.CSSProperties {
  return {
    color: segment.color,
    fontStyle: segment.italic ? "italic" : undefined,
    fontWeight: segment.bold ? 700 : undefined,
    textDecoration: segment.underline ? "underline" : undefined,
    textUnderlineOffset: segment.underline ? "2px" : undefined,
  }
}

function renderConsoleTextPart(
  text: string,
  query: string,
  redactions: ReadonlyArray<SensitiveTextRedactionRange> = []
): React.ReactNode {
  if (redactions.length === 0) return renderConsoleSegment(text, query)

  let cursor = 0
  const rendered: Array<React.ReactNode> = []
  for (const redaction of redactions) {
    if (redaction.from > cursor) {
      rendered.push(
        <React.Fragment key={`text-${cursor}`}>
          {renderConsoleSegment(text.slice(cursor, redaction.from), query)}
        </React.Fragment>
      )
    }
    rendered.push(
      <span
        key={`redacted-${redaction.from}`}
        tabIndex={0}
        title="IP address redacted"
        aria-label="IP address redacted"
        className="cursor-help text-muted-foreground/75 transition-colors hover:text-foreground/85 focus-visible:ring-1 focus-visible:ring-ring/40 focus-visible:outline-none"
      >
        {text.slice(redaction.from, redaction.to)}
      </span>
    )
    cursor = redaction.to
  }
  if (cursor < text.length) {
    rendered.push(
      <React.Fragment key={`text-${cursor}`}>
        {renderConsoleSegment(text.slice(cursor), query)}
      </React.Fragment>
    )
  }
  return rendered
}

function renderConsoleSegment(text: string, query: string): React.ReactNode {
  const urlPattern =
    /(https?:\/\/[^\s<>"']*?[^\s<>"'.,;:!?)}\]])(?=[.,;:!?)}\]]*(?:\s|$))/gu
  let offset = 0
  return text.split(urlPattern).map((part) => {
    const start = offset
    offset += part.length
    if (/^https?:\/\//u.test(part)) {
      return (
        <a
          key={`url-${start}`}
          href={part}
          target="_blank"
          rel="noreferrer"
          className="text-sky-400 underline decoration-sky-400/30 underline-offset-2 hover:text-sky-300"
          onClick={(event) => event.stopPropagation()}
        >
          {part}
        </a>
      )
    }
    return (
      <React.Fragment key={`text-${start}`}>
        {highlightText(part, query)}
      </React.Fragment>
    )
  })
}

function highlightText(text: string, query: string): React.ReactNode {
  const normalized = query.trim()
  if (!normalized) return text
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const parts = text.split(new RegExp(`(${escaped})`, "giu"))
  let offset = 0
  return parts.map((part) => {
    const start = offset
    offset += part.length
    return part.toLowerCase() === normalized.toLowerCase() ? (
      <mark
        key={`match-${start}`}
        className="rounded-sm bg-amber-300 px-0.5 text-stone-950"
      >
        {part}
      </mark>
    ) : (
      <React.Fragment key={`text-${start}`}>{part}</React.Fragment>
    )
  })
}

async function copyToClipboard(value: string) {
  await Effect.runPromise(
    Effect.tryPromise({
      try: () => navigator.clipboard.writeText(value),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          const textarea = document.createElement("textarea")
          textarea.value = value
          textarea.style.position = "fixed"
          textarea.style.opacity = "0"
          document.body.append(textarea)
          textarea.select()
          document.execCommand("copy")
          textarea.remove()
        })
      )
    )
  )
}

function useRelayConsoleStream(
  relayId: string,
  instanceId: string,
  relayConnected: boolean,
  runtime: InstanceRuntime | null | undefined
) {
  const queryClient = useQueryClient()
  const hasEverBeenLiveRef = React.useRef(false)
  const runtimeRef = React.useRef(runtime)
  React.useLayoutEffect(() => {
    runtimeRef.current = runtime
  }, [runtime])
  const cachedConsole =
    queryClient.getQueryData<RelayConsole>(
      queryKeys.relay.console(relayId, instanceId)
    ) ?? null
  const consoleDataRef = React.useRef<RelayConsole | null>(
    consoleMatchesRuntime(cachedConsole, runtime) ? cachedConsole : null
  )
  const sessionStartedAtRef = React.useRef<string | null>(
    consoleDataRef.current?.startedAt ?? null
  )
  const sessionInitializedRef = React.useRef(Boolean(consoleDataRef.current))
  const awaitingNewSessionRef = React.useRef(false)
  const sessionAcceptedAheadOfRuntimeRef = React.useRef(false)
  const previousStateRef = React.useRef<RelayObservedState | undefined>(
    runtime?.observedState
  )
  const [snapshot, setSnapshot] = React.useState<ConsoleStreamSnapshot>(() => ({
    connection: relayConnected ? "opening" : "unavailable",
    consoleData: consoleDataRef.current,
    error: relayConnected ? null : "Hearth cannot reach this Relay right now.",
    loading: !consoleDataRef.current,
    transport: null,
    transportMessage: null,
  }))

  const commitConsole = React.useCallback(
    (next: RelayConsole) => {
      consoleDataRef.current = next
      queryClient.setQueryData(
        queryKeys.relay.console(relayId, instanceId),
        next
      )
      setSnapshot((current) =>
        updateConsoleStreamSnapshot(current, { consoleData: next })
      )
    },
    [instanceId, queryClient, relayId]
  )

  React.useEffect(() => {
    const state = runtime?.observedState
    const previous = previousStateRef.current
    if (!state) return

    const current = consoleDataRef.current
    if (
      state === "running" &&
      runtime.startedAt &&
      runtime.startedAt === sessionStartedAtRef.current
    ) {
      sessionAcceptedAheadOfRuntimeRef.current = false
    }
    if (state === "running" && runtime.readyAt && current) {
      const retimestampedLines = retimestampConsoleStateLine(
        current.lines,
        "running",
        runtime.readyAt
      )
      if (retimestampedLines) {
        if (shouldRecordConsoleStateTransition(previous, state)) {
          previousStateRef.current = state
        }
        commitConsole({
          ...current,
          lines: retimestampedLines,
        })
        return
      }
    }

    if (!shouldRecordConsoleStateTransition(previous, state)) return
    previousStateRef.current = state

    if (state === "starting") {
      if (
        current &&
        consoleSessionIsCurrent(
          awaitingNewSessionRef.current,
          sessionAcceptedAheadOfRuntimeRef.current,
          current.startedAt,
          runtime.startedAt
        )
      ) {
        // The console stream can observe the replacement container before the
        // runtime snapshot. Keep its lines and only reconcile stale lifecycle
        // markers from the older snapshot.
        sessionInitializedRef.current = true
        commitConsole({
          ...current,
          lines: reconcileConsoleLifecycleLines(
            current.lines,
            current.startedAt ?? runtime.startedAt ?? null,
            state,
            runtime.readyAt,
            runtime.recovery
          ),
        })
        return
      }
      awaitingNewSessionRef.current = true
      // Preserve the crashed session until Docker has actually started the
      // replacement process, so the failure context remains visible.
      if (runtime?.recovery?.phase === "pending") return
      const line = consoleStateLine("starting", new Date().toISOString())
      const next = {
        instanceId,
        lines: [line],
        startedAt: null,
        truncated: false,
      }
      sessionInitializedRef.current = true
      commitConsole(next)
      return
    }

    if (!sessionInitializedRef.current && previous === undefined) return
    if (!current) return
    const line = consoleStateLine(
      state,
      state === "running"
        ? (runtime?.readyAt ?? new Date().toISOString())
        : new Date().toISOString()
    )
    if (
      current.lines.some((existing) => isConsoleStateLineFor(existing, state))
    ) {
      return
    }
    commitConsole({
      ...current,
      lines: mergeConsoleHistory(current.lines, [line]),
    })
  }, [
    commitConsole,
    instanceId,
    runtime?.observedState,
    runtime?.readyAt,
    runtime?.recovery,
    runtime?.startedAt,
  ])

  React.useEffect(() => {
    const startedAt = runtime?.startedAt
    if (
      !awaitingNewSessionRef.current ||
      !startedAt ||
      startedAt === sessionStartedAtRef.current
    ) {
      return
    }
    awaitingNewSessionRef.current = false
    sessionStartedAtRef.current = startedAt
    sessionInitializedRef.current = true
    commitConsole({
      instanceId,
      lines: initialConsoleStateLines(
        startedAt,
        runtime.observedState,
        runtime.readyAt,
        runtime.recovery
      ),
      startedAt,
      truncated: false,
    })
  }, [
    commitConsole,
    instanceId,
    runtime?.observedState,
    runtime?.readyAt,
    runtime?.recovery,
    runtime?.startedAt,
  ])

  React.useEffect(() => {
    const recovery = runtime?.recovery
    if (!recovery) return
    if (
      shouldAwaitConsoleRecoverySession(
        recovery.phase,
        sessionAcceptedAheadOfRuntimeRef.current
      )
    ) {
      awaitingNewSessionRef.current = true
    }
    const current = consoleDataRef.current
    if (!current) return
    const line = consoleRecoveryLine(recovery, new Date().toISOString())
    if (current.lines.some((existing) => existing.id === line.id)) return
    commitConsole({
      ...current,
      lines: mergeConsoleHistory(current.lines, [line]),
    })
  }, [commitConsole, runtime?.recovery])

  React.useEffect(() => {
    if (!relayConnected) {
      setSnapshot((current) =>
        updateConsoleStreamSnapshot(current, {
          connection: "unavailable",
          error: "Hearth cannot reach this Relay right now.",
          loading: false,
        })
      )
      return
    }

    let cancelled = false
    const lifecycle = new AbortController()
    let activeIterator: ReturnType<typeof openRelayConsoleStream> | null = null
    let flushTimer: number | null = null
    const pending: Array<RelayConsoleLine> = []
    const seen = new Set(
      consoleDataRef.current?.lines.map((line) => line.id) ?? []
    )
    setSnapshot((current) =>
      updateConsoleStreamSnapshot(current, {
        connection: hasEverBeenLiveRef.current ? "reconnecting" : "opening",
        error: null,
        loading: !consoleDataRef.current,
      })
    )

    function commitSnapshot(patch: Partial<ConsoleStreamSnapshot>) {
      if (cancelled) return
      setSnapshot((current) => updateConsoleStreamSnapshot(current, patch))
    }

    function flush() {
      flushTimer = null
      if (cancelled || pending.length === 0) return
      const fresh = pending.splice(0).filter((line) => {
        if (seen.has(line.id)) return false
        seen.add(line.id)
        return true
      })
      if (fresh.length === 0) return
      const current = consoleDataRef.current
      const next = {
        instanceId,
        lines: capConsoleLines([...(current?.lines ?? []), ...fresh]),
        startedAt: current?.startedAt ?? sessionStartedAtRef.current,
        truncated: Boolean(current?.truncated) || seen.size > 5_000,
      }
      consoleDataRef.current = next
      queryClient.setQueryData(
        queryKeys.relay.console(relayId, instanceId),
        next
      )
      commitSnapshot({ consoleData: next })
    }

    function append(line: RelayConsoleLine) {
      pending.push(line)
      if (pending.length >= 100) flush()
      else if (flushTimer === null) {
        flushTimer = window.setTimeout(flush, 40)
      }
    }

    function replaceSession(
      startedAt: string | null,
      lines: ReadonlyArray<RelayConsoleLine>,
      truncated: boolean
    ) {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer)
        flushTimer = null
      }
      pending.length = 0
      sessionAcceptedAheadOfRuntimeRef.current =
        consoleSessionAcceptedAheadOfRuntime(
          sessionAcceptedAheadOfRuntimeRef.current,
          sessionStartedAtRef.current,
          startedAt,
          runtimeRef.current?.observedState,
          runtimeRef.current?.startedAt
        )
      // A reset is the authoritative session boundary. Runtime snapshots can
      // arrive later, but must not put an accepted session back into waiting.
      awaitingNewSessionRef.current = false
      sessionStartedAtRef.current = startedAt
      sessionInitializedRef.current = true
      const nextLines = mergeConsoleStateLines(
        lines,
        startedAt,
        runtimeRef.current?.observedState,
        runtimeRef.current?.readyAt ?? null,
        runtimeRef.current?.recovery ?? null
      )
      seen.clear()
      for (const line of nextLines) seen.add(line.id)
      const nextConsole = {
        instanceId,
        lines: nextLines,
        startedAt,
        truncated,
      }
      consoleDataRef.current = nextConsole
      queryClient.setQueryData(
        queryKeys.relay.console(relayId, instanceId),
        nextConsole
      )
      commitSnapshot({ consoleData: nextConsole })
    }

    const connectFiber = Effect.runFork(
      Effect.gen(function* () {
        let retryDelay = 400
        while (!cancelled) {
          const failure = yield* Effect.tryPromise({
            try: async () => {
              const stream = openRelayConsoleStream(
                relayId,
                instanceId,
                lifecycle.signal
              )
              activeIterator = stream
              // Cancellation changes from the effect cleanup while next() awaits.
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
              while (!cancelled) {
                const result = await activeIterator.next()
                // Cleanup can run while the iterator awaits its next event.
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                if (cancelled) break
                if (result.done) throw new Error("Console stream closed")
                const event = result.value
                if (event.type === "transport") {
                  commitSnapshot({
                    error: null,
                    transport: event.transport,
                    transportMessage: event.message,
                  })
                } else if (event.type === "ready") {
                  hasEverBeenLiveRef.current = true
                  if (
                    awaitingNewSessionRef.current &&
                    event.startedAt !== undefined &&
                    event.startedAt !== sessionStartedAtRef.current
                  ) {
                    replaceSession(event.startedAt, [], false)
                  }
                  const nextConsole = consoleDataRef.current ?? {
                    instanceId,
                    lines: [],
                    startedAt: event.startedAt ?? null,
                    truncated: false,
                  }
                  if (event.startedAt !== undefined) {
                    sessionStartedAtRef.current = event.startedAt
                  }
                  sessionInitializedRef.current = true
                  consoleDataRef.current = nextConsole
                  queryClient.setQueryData(
                    queryKeys.relay.console(relayId, instanceId),
                    nextConsole
                  )
                  commitSnapshot({
                    connection: "live",
                    consoleData: nextConsole,
                    error: null,
                    loading: false,
                  })
                  retryDelay = 400
                } else if (event.type === "reset") {
                  if (
                    awaitingNewSessionRef.current &&
                    event.startedAt === sessionStartedAtRef.current
                  ) {
                    continue
                  }
                  replaceSession(event.startedAt, event.lines, event.truncated)
                } else if (event.type === "history") {
                  if (
                    awaitingNewSessionRef.current ||
                    event.startedAt !== sessionStartedAtRef.current
                  ) {
                    continue
                  }
                  const fresh = event.lines.filter((line) => {
                    if (seen.has(line.id)) return false
                    seen.add(line.id)
                    return true
                  })
                  if (fresh.length === 0) continue
                  const current = consoleDataRef.current
                  if (!current) continue
                  const nextConsole = {
                    ...current,
                    lines: prependConsoleHistory(current.lines, fresh),
                    truncated: event.truncated,
                  }
                  consoleDataRef.current = nextConsole
                  queryClient.setQueryData(
                    queryKeys.relay.console(relayId, instanceId),
                    nextConsole
                  )
                  commitSnapshot({ consoleData: nextConsole })
                } else {
                  if (awaitingNewSessionRef.current) {
                    const startedAt = runtimeRef.current?.startedAt
                    if (
                      !startedAt ||
                      startedAt === sessionStartedAtRef.current
                    ) {
                      continue
                    }
                    replaceSession(startedAt, [event.line], false)
                  } else {
                    append(event.line)
                  }
                }
              }
            },
            catch: (cause) => cause,
          }).pipe(
            Effect.match({
              onFailure: (cause) => cause,
              onSuccess: () => null,
            })
          )
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (cancelled) break
          if (failure === null) continue
          commitSnapshot({
            connection: hasEverBeenLiveRef.current
              ? "reconnecting"
              : "unavailable",
            error: consoleConnectionMessage(failure),
            loading: false,
          })
          yield* Effect.sleep(retryDelay)
          retryDelay = Math.min(retryDelay * 2, 5_000)
        }
      })
    )

    return () => {
      if (flushTimer !== null) window.clearTimeout(flushTimer)
      flush()
      cancelled = true
      lifecycle.abort()
      if (activeIterator) void activeIterator.return(undefined)
      connectFiber.interruptUnsafe()
    }
  }, [instanceId, queryClient, relayConnected, relayId])

  return snapshot
}

function consoleMatchesRuntime(
  consoleData: RelayConsole | null,
  runtime: InstanceRuntime | null | undefined
): boolean {
  if (!consoleData || !runtime?.startedAt) return Boolean(consoleData)
  return consoleData.startedAt === runtime.startedAt
}

function prependConsoleHistory(
  current: ReadonlyArray<RelayConsoleLine>,
  history: ReadonlyArray<RelayConsoleLine>
): Array<RelayConsoleLine> {
  return capConsoleLines(mergeConsoleHistory(current, history))
}

function capConsoleLines(
  lines: ReadonlyArray<RelayConsoleLine>
): Array<RelayConsoleLine> {
  if (lines.length <= 5_008) return [...lines]
  let remaining = lines.length - 5_008
  return lines.filter((line) => {
    if (
      remaining === 0 ||
      isConsoleStateLine(line) ||
      isConsoleRecoveryLine(line)
    ) {
      return true
    }
    remaining -= 1
    return false
  })
}

function updateConsoleStreamSnapshot(
  current: ConsoleStreamSnapshot,
  patch: Partial<ConsoleStreamSnapshot>
): ConsoleStreamSnapshot {
  const next = { ...current, ...patch }
  return current.connection === next.connection &&
    current.consoleData === next.consoleData &&
    current.error === next.error &&
    current.loading === next.loading &&
    current.transport === next.transport &&
    current.transportMessage === next.transportMessage
    ? current
    : next
}

function consoleConnectionMessage(cause: unknown): string {
  if (cause instanceof RelayConsoleConnectionError) return cause.message
  return cause instanceof Error && cause.message
    ? cause.message
    : "The Relay is connected, but its console stream could not be read."
}

function usePersistedCommand(
  instanceId: string,
  inputRef: React.RefObject<HTMLInputElement | null>,
  sendButtonRef: React.RefObject<HTMLButtonElement | null>,
  running: boolean,
  sending: boolean
) {
  const storageKey = `hearth:console-draft:${instanceId}`

  const syncSubmitAvailability = React.useCallback(
    (value: string) => {
      if (sendButtonRef.current) {
        sendButtonRef.current.disabled = !running || sending || !value.trim()
      }
    },
    [running, sendButtonRef, sending]
  )

  React.useEffect(() => {
    const storedValue = window.sessionStorage.getItem(storageKey) ?? ""
    if (inputRef.current) inputRef.current.value = storedValue
  }, [inputRef, storageKey])

  React.useEffect(() => {
    syncSubmitAvailability(inputRef.current?.value ?? "")
  }, [inputRef, syncSubmitAvailability])

  const setValue = React.useCallback(
    (next: string) => {
      if (inputRef.current) inputRef.current.value = next
      syncSubmitAvailability(next)
      if (next) window.sessionStorage.setItem(storageKey, next)
      else window.sessionStorage.removeItem(storageKey)
    },
    [inputRef, storageKey, syncSubmitAvailability]
  )

  return setValue
}

const commandHistoryLimit = 100

function useCommandHistory(instanceId: string) {
  const storageKey = `kiln:console-history:${instanceId}`
  const history = React.useRef<Array<string>>([])
  const cursor = React.useRef<number | null>(null)
  const pendingDraft = React.useRef("")

  React.useEffect(() => {
    history.current = readCommandHistory(storageKey)
    cursor.current = null
    pendingDraft.current = ""
  }, [storageKey])

  const recordCommand = React.useCallback(
    (command: string) => {
      const current = history.current
      const next =
        current.at(-1) === command
          ? current
          : [...current, command].slice(-commandHistoryLimit)

      history.current = next
      cursor.current = null
      pendingDraft.current = ""
      window.sessionStorage.setItem(storageKey, JSON.stringify(next))
    },
    [storageKey]
  )

  const navigateHistory = React.useCallback(
    (
      direction: "previous" | "next",
      currentValue: string
    ): string | undefined => {
      const commands = history.current
      if (commands.length === 0) return undefined

      if (direction === "previous") {
        if (cursor.current === null) {
          pendingDraft.current = currentValue
          cursor.current = commands.length - 1
        } else {
          cursor.current = Math.max(0, cursor.current - 1)
        }
        return commands[cursor.current]
      }

      if (cursor.current === null) return undefined
      if (cursor.current < commands.length - 1) {
        cursor.current += 1
        return commands[cursor.current]
      }

      cursor.current = null
      return pendingDraft.current
    },
    []
  )

  return { navigateHistory, recordCommand }
}

function mergeCommandCompletion(prefix: string, suggestion: string): string {
  const { contextualStart, tokenStart } = commandCompletionContext(
    prefix,
    suggestion
  )
  if (contextualStart !== undefined) {
    return `${prefix.slice(0, contextualStart)}${suggestion}`
  }

  return `${prefix.slice(0, tokenStart)}${suggestion}`
}

function commandCompletionLabel(prefix: string, suggestion: string): string {
  const { contextualStart, tokenStart } = commandCompletionContext(
    prefix,
    suggestion
  )
  if (contextualStart === undefined) return suggestion

  const completedContext = prefix.slice(contextualStart, tokenStart)
  const label = suggestion.slice(completedContext.length)
  return label || suggestion
}

function commandCompletionContext(prefix: string, suggestion: string) {
  const tokenStarts = [0]
  for (let index = 1; index < prefix.length; index += 1) {
    if (
      /\s/u.test(prefix[index - 1] ?? "") &&
      !/\s/u.test(prefix[index] ?? "")
    ) {
      tokenStarts.push(index)
    }
  }

  const contextualStart = tokenStarts.find((start) => {
    const typedContext = prefix.slice(start)
    return typedContext.length > 0 && suggestion.startsWith(typedContext)
  })
  const tokenStart = /\s$/u.test(prefix)
    ? prefix.length
    : (tokenStarts.at(-1) ?? 0)
  return { contextualStart, tokenStart }
}

function readCommandHistory(storageKey: string): Array<string> {
  return Result.getOrElse(
    Result.try(() => {
      const stored: unknown = JSON.parse(
        window.sessionStorage.getItem(storageKey) ?? "[]"
      )
      if (!Array.isArray(stored)) return []
      return stored
        .filter(
          (command): command is string =>
            typeof command === "string" && command.length > 0
        )
        .slice(-commandHistoryLimit)
    }),
    () => []
  )
}
