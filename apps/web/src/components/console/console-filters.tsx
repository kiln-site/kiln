import * as React from "react"
import { flushSync } from "react-dom"
import type { RelayConsoleLevel } from "@workspace/contracts"
import { Boxes, Check, ListFilter, Search, X } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"

import {
  consoleLevels,
  consoleServices,
  type ConsoleUiStore,
} from "@/components/console/console-stores"
import { useConsoleCopy } from "@/components/console/console-copy-context"
import { ConsoleTooltip } from "@/components/console/console-tooltip"
import { RelayKindIcon } from "@/components/instance-kind-icon"

// Below `sm` the search collapses to an icon so the toolbar fits on one line.
// Opening it hides the toolbar's other children until the input loses focus.
export const consoleToolbarClassName =
  "flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2.5 sm:px-4 max-sm:has-data-[console-search-open]:*:not-data-[console-search]:hidden"

export function ConsoleSearchControl({ uiStore }: { uiStore: ConsoleUiStore }) {
  const copy = useConsoleCopy()
  const query = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getQuerySnapshot,
    uiStore.getQuerySnapshot
  )
  const [open, setOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  function openSearch() {
    // Focus inside the tap so mobile browsers raise the keyboard.
    flushSync(() => setOpen(true))
    inputRef.current?.focus()
  }

  return (
    <>
      <ConsoleTooltip content="Search Console">
        <Button
          variant={query ? "secondary" : "ghost"}
          size="icon"
          className={`relative size-9 shrink-0 sm:hidden ${open ? "hidden" : ""}`}
          aria-label={query ? `${copy.search}, filtered` : copy.search}
          onClick={openSearch}
        >
          <Search />
          {query ? (
            <span
              className="absolute top-1 right-1 size-1.5 bg-primary"
              aria-hidden="true"
            />
          ) : null}
        </Button>
      </ConsoleTooltip>
      <div
        data-console-search=""
        data-console-search-open={open || undefined}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && event.target instanceof HTMLElement)
            event.target.blur()
        }}
        className={`relative min-w-[12rem] flex-1 sm:block sm:max-w-sm ${open ? "" : "hidden"}`}
      >
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => uiStore.setQuery(event.target.value)}
          placeholder={copy.search}
          aria-label={copy.search}
          className="h-9 border-border/80 bg-background pl-8 text-base shadow-none sm:text-xs"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            // Keep focus in the input so the search stays open.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              uiStore.setQuery("")
              inputRef.current?.focus()
            }}
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
    </>
  )
}

export function ConsoleLevelMenu({ uiStore }: { uiStore: ConsoleUiStore }) {
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
              ? "Filter log levels"
              : `Filter log levels, ${levelCount} active`
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
      <p className="type-technical-label text-muted-foreground">Log levels</p>
      <span className="type-meta font-mono text-muted-foreground tabular-nums">
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

export function ConsoleRelayMenu({
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
            <RelayKindIcon />
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

export function ConsoleServiceMenu({ uiStore }: { uiStore: ConsoleUiStore }) {
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
      <p className="type-technical-label text-muted-foreground">{label}</p>
      <span className="type-meta font-mono text-muted-foreground tabular-nums">
        {active}/{total}
      </span>
    </div>
  )
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
        className={`grid size-4 shrink-0 place-items-center border ${active ? "border-primary/45 bg-primary/12 text-primary-ink" : "border-border bg-background text-transparent"}`}
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
