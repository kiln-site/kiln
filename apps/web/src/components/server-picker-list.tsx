import * as React from "react"
import {
  Check,
  Database,
  LoaderCircle,
  Network,
  Search,
  Server,
} from "lucide-react"

import { Input } from "@workspace/ui/components/input"
import { cn } from "@workspace/ui/lib/utils"

export interface ServerPickerOption {
  description?: string
  disabled?: boolean
  id: string
  kind?: "database" | "relay" | "server"
  name: string
  relayId: string
  relayName: string
}

interface ServerPickerAllOption {
  description: string
  kind?: "database" | "relay" | "server"
  label: string
  onSelect: () => void
  selected: boolean
}

export const serverPickerOptionKey = (server: ServerPickerOption) =>
  server.kind
    ? `${server.kind}:${server.relayId}:${server.id}`
    : `${server.relayId}:${server.id}`

export const ServerPickerList = React.memo(function ServerPickerList({
  allOption,
  allOptions,
  ariaLabel = "Accessible servers",
  emptyMessage = "No accessible servers found.",
  multiple,
  onSelect,
  pendingKey,
  searchPlaceholder = "Search by name, Relay, or ID",
  selectedKeys,
  servers,
}: {
  allOption?: ServerPickerAllOption
  allOptions?: ReadonlyArray<ServerPickerAllOption>
  ariaLabel?: string
  emptyMessage?: string
  multiple?: boolean
  onSelect: (server: ServerPickerOption) => void
  pendingKey?: string
  searchPlaceholder?: string
  selectedKeys: ReadonlySet<string>
  servers: ReadonlyArray<ServerPickerOption>
}) {
  const [query, setQuery] = React.useState("")
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleServers = React.useMemo(
    () =>
      normalizedQuery
        ? servers.filter((server) =>
            `${server.name} ${server.id} ${server.relayName} ${server.kind ?? ""}`
              .toLocaleLowerCase()
              .includes(normalizedQuery)
          )
        : servers,
    [normalizedQuery, servers]
  )
  const groups = React.useMemo(
    () => groupServerPickerOptions(visibleServers),
    [visibleServers]
  )

  return (
    <>
      <div className="relative mb-1.5">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          aria-label={`Search ${ariaLabel.toLocaleLowerCase()}`}
          className="h-8 pl-8"
          placeholder={searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      <div
        role="listbox"
        aria-label={ariaLabel}
        aria-multiselectable={(multiple ?? !allOption) ? true : undefined}
        className="no-scrollbar max-h-72 space-y-0.5 overflow-y-auto overscroll-contain"
      >
        {normalizedQuery.length === 0 ? (
          <>
            {allOption ? (
              <ServerPickerRow
                description={allOption.description}
                kind={allOption.kind}
                name={allOption.label}
                selected={allOption.selected}
                onSelect={allOption.onSelect}
              />
            ) : null}
            {allOptions?.map((option) => (
              <ServerPickerRow
                key={option.label}
                description={option.description}
                kind={option.kind}
                name={option.label}
                selected={option.selected}
                onSelect={option.onSelect}
              />
            ))}
          </>
        ) : null}

        {groups.map((group) => (
          <React.Fragment key={group.label ?? "items"}>
            {group.label ? (
              <p className="type-technical-label px-2.5 pt-2 pb-1 text-muted-foreground">
                {group.label}
              </p>
            ) : null}
            {group.items.map((server) => {
              const key = serverPickerOptionKey(server)
              return (
                <ServerPickerRow
                  key={key}
                  description={
                    server.description ?? `${server.relayName} · ${server.id}`
                  }
                  disabled={server.disabled || pendingKey !== undefined}
                  kind={server.kind}
                  name={server.name}
                  pending={pendingKey === key}
                  selected={selectedKeys.has(key)}
                  onSelect={() => onSelect(server)}
                />
              )
            })}
          </React.Fragment>
        ))}

        {visibleServers.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {emptyMessage}
          </p>
        ) : null}
      </div>
    </>
  )
})

const ServerPickerRow = React.memo(function ServerPickerRow({
  description,
  disabled = false,
  kind = "server",
  name,
  onSelect,
  pending = false,
  selected,
}: {
  description: string
  disabled?: boolean
  kind?: "database" | "relay" | "server"
  name: string
  onSelect: () => void
  pending?: boolean
  selected: boolean
}) {
  return (
    <button
      type="button"
      role="option"
      aria-busy={pending}
      aria-selected={selected}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
        selected ? "bg-primary/14 ring-1 ring-primary/35" : "hover:bg-accent/55"
      )}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/70 bg-background/70 text-muted-foreground">
        {kind === "relay" ? (
          <Network className="size-4" />
        ) : kind === "database" ? (
          <Database className="size-4" />
        ) : (
          <Server className="size-4" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold tracking-tight">
          {name}
        </span>
        <span className="type-support mt-0.5 block truncate text-muted-foreground">
          {description}
        </span>
      </span>
      {pending ? (
        <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" />
      ) : selected ? (
        <Check className="size-4 shrink-0 text-primary" />
      ) : null}
    </button>
  )
})

function groupServerPickerOptions(
  servers: ReadonlyArray<ServerPickerOption>
): Array<{ items: ReadonlyArray<ServerPickerOption>; label: string | null }> {
  const grouped = {
    database: [] as Array<ServerPickerOption>,
    relay: [] as Array<ServerPickerOption>,
    server: [] as Array<ServerPickerOption>,
  }
  for (const server of servers) {
    grouped[server.kind ?? "server"].push(server)
  }
  if (grouped.database.length === 0 && grouped.relay.length === 0) {
    return [{ items: servers, label: null }]
  }
  return [
    grouped.server.length ? { items: grouped.server, label: "Servers" } : null,
    grouped.database.length
      ? { items: grouped.database, label: "Databases" }
      : null,
    grouped.relay.length ? { items: grouped.relay, label: "Relays" } : null,
  ].filter(
    (group): group is { items: Array<ServerPickerOption>; label: string } =>
      group !== null
  )
}
