import * as React from "react"
import { eq, not } from "@tanstack/db"
import { useDbClient, useLiveQuery } from "@tanstack/react-db"
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ensuringPromise, forkPromise } from "@/effect/promise"
import {
  Folder,
  ListTodo,
  Network,
  Plus,
  RefreshCw,
  Search,
  Server,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { builtinTailscaleBrickId } from "@workspace/contracts"

import {
  AddServerDialogHost,
  createAddServerDialogStore,
} from "@/components/add-server-dialog"
import type { AddServerDialogStore } from "@/components/add-server-dialog"
import {
  ServerDeleteDialog,
  type ServerDeleteTarget,
} from "@/components/server-delete-dialog"
import { InstanceName } from "@/components/instance-name"
import {
  WorkspaceDataTable,
  WorkspaceTableCell,
  WorkspaceTableHead,
  WorkspaceTableHeading,
  createWorkspaceTableSearchStore,
  useWorkspaceTableSearchInput,
} from "@/components/workspace-data-table"
import type { WorkspaceTableSearchStore } from "@/components/workspace-data-table"
import {
  accessCapabilitiesQueryOptions,
  brickCatalogQueryOptions,
  relayConnectionQueryOptions,
} from "@/lib/query-options"
import {
  getRelayInstancesCollection,
  relayInstancesCollectionOptions,
} from "@/lib/collections/relay-instances"
import { roleHasPermission } from "@/lib/permissions"
import { selectRelayConfigured } from "@/lib/relay-selectors"
import type { ServerListInstance } from "@/lib/relay-selectors"

const emptyServers: Array<ServerListInstance> = []
const minimumManualSyncFeedbackMs = 500

interface ServerDeleteAccess {
  all: boolean
  instances: ReadonlySet<string>
  relays: ReadonlySet<string>
}

export type ServerSearchStore = WorkspaceTableSearchStore

export function createServerSearchStore(
  initialValue: string
): ServerSearchStore {
  return createWorkspaceTableSearchStore(initialValue)
}

export const ServersPage = React.memo(function ServersPage({
  canProvision,
  passwordRequired,
  searchStore,
}: {
  canProvision: boolean
  passwordRequired: boolean
  searchStore: ServerSearchStore
}) {
  const queryClient = useQueryClient()
  const [dialogStore] = React.useState(createAddServerDialogStore)
  const [deleteTarget, setDeleteTarget] =
    React.useState<ServerDeleteTarget | null>(null)
  const { data: relayConfigured } = useSuspenseQuery({
    ...relayConnectionQueryOptions(queryClient),
    select: selectRelayConfigured,
  })
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  const deleteAccess = React.useMemo<ServerDeleteAccess>(() => {
    const instances = new Set<string>()
    const relays = new Set<string>()
    for (const grant of capabilities.grants) {
      if (!roleHasPermission(grant.role, "instance.delete")) continue
      if (
        grant.resourceType === "relay" &&
        grant.resourceId === grant.relayId
      ) {
        relays.add(grant.relayId)
      } else if (grant.resourceType === "instance") {
        instances.add(`${grant.relayId}:${grant.resourceId}`)
      }
    }
    return {
      all: capabilities.isPlatformAdmin,
      instances,
      relays,
    }
  }, [capabilities.grants, capabilities.isPlatformAdmin])
  const openDelete = React.useCallback((target: ServerDeleteTarget) => {
    setDeleteTarget(target)
  }, [])

  React.useEffect(() => {
    if (canProvision) {
      void queryClient.prefetchQuery(brickCatalogQueryOptions())
    }
  }, [canProvision, queryClient])

  return (
    <div className="mx-auto w-full max-w-[90rem] px-3 pb-10 sm:px-5">
      <section
        data-slot="servers-workspace"
        className="overflow-hidden rounded-xl border bg-card/45 [contain:paint]"
      >
        <ServerToolbar
          canProvision={canProvision}
          dialogStore={dialogStore}
          relayConfigured={relayConfigured}
          searchStore={searchStore}
        />
        <FilteredServerTableBoundary
          canProvision={canProvision}
          deleteAccess={deleteAccess}
          dialogStore={dialogStore}
          onDelete={openDelete}
          relayConfigured={relayConfigured}
          searchStore={searchStore}
        />
      </section>
      {canProvision ? <AddServerDialogHost store={dialogStore} /> : null}
      {deleteTarget ? (
        <ServerDeleteDialog
          key={`${deleteTarget.relayId}:${deleteTarget.id}`}
          open
          target={deleteTarget}
          passwordRequired={passwordRequired}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null)
          }}
        />
      ) : null}
    </div>
  )
})

const ServerToolbar = React.memo(function ServerToolbar({
  canProvision,
  dialogStore,
  relayConfigured,
  searchStore,
}: {
  canProvision: boolean
  dialogStore: AddServerDialogStore
  relayConfigured: boolean
  searchStore: ServerSearchStore
}) {
  const [mobileSearchOpen, setMobileSearchOpen] = React.useState(
    () => searchStore.getSnapshot().length > 0
  )
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const handleSearchEmpty = React.useCallback((value: string) => {
    if (value.length === 0) setMobileSearchOpen(false)
  }, [])

  React.useEffect(() => {
    if (mobileSearchOpen) searchInputRef.current?.focus()
  }, [mobileSearchOpen])

  return (
    <div className="flex min-w-0 items-center gap-2 border-b bg-background/25 p-3">
      <ServerSyncButton disabled={!relayConfigured} />

      {!mobileSearchOpen ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Search servers"
              aria-controls="server-search"
              aria-expanded={false}
              className="sm:hidden"
              onClick={() => setMobileSearchOpen(true)}
            >
              <Search />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Search servers
          </TooltipContent>
        </Tooltip>
      ) : null}

      <div
        className={`${mobileSearchOpen ? "block" : "hidden"} min-w-0 flex-1 sm:block sm:max-w-md`}
      >
        <ServerSearchInput
          inputRef={searchInputRef}
          store={searchStore}
          onSearchEmpty={handleSearchEmpty}
        />
      </div>

      {mobileSearchOpen ? (
        <ClearMobileSearchButton
          searchStore={searchStore}
          onClose={() => setMobileSearchOpen(false)}
        />
      ) : null}

      <div
        className={`${mobileSearchOpen ? "hidden sm:flex" : "flex"} ml-auto shrink-0 items-center gap-2`}
      >
        <ActivityButton />
        <AddServerButton
          canProvision={canProvision}
          dialogStore={dialogStore}
        />
      </div>
    </div>
  )
})

const ServerSyncButton = React.memo(function ServerSyncButton({
  disabled,
}: {
  disabled: boolean
}) {
  const dbClient = useDbClient()
  const instances = getRelayInstancesCollection(dbClient)
  const [manualSyncing, setManualSyncing] = React.useState(false)
  const manualSyncingRef = React.useRef(false)
  const feedbackTimeoutRef = React.useRef<number>(undefined)
  const mountedRef = React.useRef(true)
  const syncing = manualSyncing

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (feedbackTimeoutRef.current !== undefined) {
        window.clearTimeout(feedbackTimeoutRef.current)
      }
    }
  }, [])

  const syncServers = React.useCallback(() => {
    if (disabled || manualSyncingRef.current) return
    manualSyncingRef.current = true
    setManualSyncing(true)
    const startedAt = performance.now()

    forkPromise(() =>
      ensuringPromise(
        () => instances.utils.refetch({ throwOnError: true }),
        () => {
          if (!mountedRef.current) return
          const elapsed = performance.now() - startedAt
          const remaining = Math.max(0, minimumManualSyncFeedbackMs - elapsed)
          feedbackTimeoutRef.current = window.setTimeout(() => {
            manualSyncingRef.current = false
            setManualSyncing(false)
            feedbackTimeoutRef.current = undefined
          }, remaining)
        }
      )
    )
  }, [disabled, instances])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Sync servers"
          aria-busy={syncing}
          disabled={disabled || syncing}
          onClick={syncServers}
        >
          <RefreshCw className={syncing ? "animate-spin" : ""} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Sync servers
      </TooltipContent>
    </Tooltip>
  )
})

function ClearMobileSearchButton({
  searchStore,
  onClose,
}: {
  searchStore: ServerSearchStore
  onClose: () => void
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label="Close server search"
      className="sm:hidden"
      onClick={() => {
        onClose()
        searchStore.set("")
        replaceServerSearch("")
      }}
    >
      <X />
    </Button>
  )
}

const ServerSearchInput = React.memo(function ServerSearchInput({
  inputRef,
  store,
  onSearchEmpty,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  store: ServerSearchStore
  onSearchEmpty: (value: string) => void
}) {
  useWorkspaceTableSearchInput(inputRef, store)

  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        id="server-search"
        type="search"
        defaultValue={store.getServerSnapshot()}
        onChange={(event) => {
          const value = event.currentTarget.value
          store.set(value)
          onSearchEmpty(value)
          replaceServerSearch(value)
        }}
        placeholder="Search servers"
        aria-label="Search servers"
        className="pl-9 text-base md:text-sm"
      />
    </div>
  )
})

const ActivityButton = React.memo(function ActivityButton() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="outline" className="px-2 sm:px-2.5">
          <Link to="/activity" aria-label="Server activity">
            <ListTodo />
            <span className="hidden sm:inline">Activity</span>
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Server activity
      </TooltipContent>
    </Tooltip>
  )
})

const AddServerButton = React.memo(function AddServerButton({
  canProvision,
  dialogStore,
}: {
  canProvision: boolean
  dialogStore: AddServerDialogStore
}) {
  if (canProvision) {
    return (
      <Button type="button" onClick={dialogStore.open}>
        <Plus /> Add Server
      </Button>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" disabled>
          <Plus /> Add Server
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Server provisioning requires administrator access
      </TooltipContent>
    </Tooltip>
  )
})

const ServerTableSearchBoundary = React.memo(
  function ServerTableSearchBoundary({
    canProvision,
    deleteAccess,
    dialogStore,
    onDelete,
    searchStore,
    servers,
  }: {
    canProvision: boolean
    deleteAccess: ServerDeleteAccess
    dialogStore: AddServerDialogStore
    onDelete: (target: ServerDeleteTarget) => void
    searchStore: ServerSearchStore
    servers: Array<ServerListInstance>
  }) {
    const shortIdCounts = React.useMemo(() => {
      const counts = new Map<string, number>()
      for (const server of servers) {
        counts.set(server.shortId, (counts.get(server.shortId) ?? 0) + 1)
      }
      return counts
    }, [servers])
    const renderRow = React.useCallback(
      (server: ServerListInstance) => (
        <ServerTableRow
          canonical={shortIdCounts.get(server.shortId) === 1}
          canDelete={canDeleteServer(deleteAccess, server)}
          onDelete={onDelete}
          routeIdentifier={
            shortIdCounts.get(server.shortId) === 1
              ? server.shortId
              : server.routeId
          }
          server={server}
        />
      ),
      [deleteAccess, onDelete, shortIdCounts]
    )
    const renderEmpty = React.useCallback(
      (searchActive: boolean) => (
        <EmptyServerTable
          canProvision={canProvision}
          dialogStore={dialogStore}
          searchActive={searchActive}
        />
      ),
      [canProvision, dialogStore]
    )

    return (
      <WorkspaceDataTable
        getRowKey={serverRowKey}
        getSearchText={serverSearchText}
        head={<ServerTableHead />}
        items={servers}
        renderEmpty={renderEmpty}
        renderRow={renderRow}
        searchStore={searchStore}
      />
    )
  }
)

const FilteredServerTableBoundary = React.memo(
  function FilteredServerTableBoundary({
    canProvision,
    deleteAccess,
    dialogStore,
    onDelete,
    relayConfigured,
    searchStore,
  }: {
    canProvision: boolean
    deleteAccess: ServerDeleteAccess
    dialogStore: AddServerDialogStore
    onDelete: (target: ServerDeleteTarget) => void
    relayConfigured: boolean
    searchStore: ServerSearchStore
  }) {
    const { data: servers = emptyServers } = useLiveQuery({
      query: (query) => {
        if (!relayConfigured) return undefined
        return query
          .from({ instance: relayInstancesCollectionOptions })
          .where(({ instance }) =>
            not(eq(instance.brickId, builtinTailscaleBrickId))
          )
          .select(({ instance }) => ({
            brickId: instance.brickId,
            connectAddress: instance.connectAddress,
            game: instance.game,
            id: instance.id,
            implementation: instance.implementation,
            name: instance.name,
            observedState: instance.observedState,
            provisioning: instance.provisioning,
            relayId: instance.relayId,
            relayName: instance.relayName,
            relayStatus: instance.relayStatus,
            routeId: instance.routeId,
            shortId: instance.shortId,
            version: instance.version,
          }))
      },
    })
    return (
      <ServerTableSearchBoundary
        canProvision={canProvision}
        deleteAccess={deleteAccess}
        dialogStore={dialogStore}
        onDelete={onDelete}
        searchStore={searchStore}
        servers={servers}
      />
    )
  }
)

const ServerTableHead = React.memo(function ServerTableHead() {
  return (
    <WorkspaceTableHead>
      <WorkspaceTableHeading className="w-10 px-2 sm:w-24 sm:px-3">
        <span className="sr-only sm:not-sr-only">Status</span>
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-auto sm:w-[25%]">
        Server
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[12%] lg:table-cell">
        ID
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[18%] lg:table-cell">
        Relay
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[24%] xl:table-cell">
        Address
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[16%] md:table-cell">
        Version
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-36 px-1 text-right sm:w-40 sm:px-3">
        Actions
      </WorkspaceTableHeading>
    </WorkspaceTableHead>
  )
})

const ServerTableRow = React.memo(function ServerTableRow({
  canonical,
  canDelete,
  onDelete,
  routeIdentifier,
  server,
}: {
  canonical: boolean
  canDelete: boolean
  onDelete: (target: ServerDeleteTarget) => void
  routeIdentifier: string
  server: ServerListInstance
}) {
  return (
    <tr className="group transition-colors hover:bg-accent/25">
      <WorkspaceTableCell className="px-2 sm:px-3">
        <ServerStatus server={server} />
      </WorkspaceTableCell>
      <WorkspaceTableCell className="!px-0">
        <Link
          to="/server/$serverId/console"
          params={{ serverId: routeIdentifier }}
          preload="intent"
          className="group/server-link flex min-h-14 w-full min-w-0 items-center px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
        >
          <InstanceName
            instance={{
              id: server.id,
              kind: "server",
              observedState: server.observedState,
              relayId: server.relayId,
              relayStatus: server.relayStatus,
            }}
            name={server.name}
            nameClassName="transition-colors group-hover/server-link:text-primary"
            meta={`${server.game} · ${server.implementation}`}
            metaClassName="font-mono"
          />
        </Link>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden lg:table-cell">
        <span
          className={`type-meta font-mono ${canonical ? "text-foreground" : "text-amber-300"}`}
          title={
            canonical
              ? server.id
              : `${server.shortId} is shared by more than one accessible server; this row uses its Relay-qualified route`
          }
        >
          {server.shortId}
        </span>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden lg:table-cell">
        <div className="min-w-0">
          <p className="type-meta truncate text-foreground">
            {server.relayName}
          </p>
          <p className="type-meta truncate font-mono text-muted-foreground">
            {server.relayStatus}
          </p>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden xl:table-cell">
        <span
          className={`type-meta block truncate font-mono ${
            server.connectAddress.startsWith("Error:")
              ? "font-semibold text-destructive"
              : "text-foreground"
          }`}
          title={server.connectAddress}
        >
          {server.connectAddress.startsWith("Error:")
            ? "ERROR"
            : server.connectAddress}
        </span>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden md:table-cell">
        <div className="min-w-0">
          <p className="type-meta truncate font-mono text-foreground">
            {server.version}
          </p>
          <p className="type-meta truncate text-muted-foreground">
            {server.implementation}
          </p>
        </div>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="px-1 sm:px-3">
        <ServerActions
          canDelete={canDelete}
          routeIdentifier={routeIdentifier}
          server={server}
          onDelete={onDelete}
        />
      </WorkspaceTableCell>
    </tr>
  )
})

const ServerActions = React.memo(function ServerActions({
  canDelete,
  onDelete,
  routeIdentifier,
  server,
}: {
  canDelete: boolean
  onDelete: (target: ServerDeleteTarget) => void
  routeIdentifier: string
  server: ServerListInstance
}) {
  const deleteEnabled = server.relayStatus === "connected"
  return (
    <div className="flex items-center justify-end gap-1">
      <ServerActionLink
        icon={TerminalSquare}
        label={`Open ${server.name} console`}
        routeIdentifier={routeIdentifier}
        tab="console"
        tooltip="Console"
      />
      <ServerActionLink
        icon={Folder}
        label={`Open ${server.name} files`}
        routeIdentifier={routeIdentifier}
        tab="files"
        tooltip="Files"
      />
      <ServerActionLink
        icon={Network}
        label={`Open ${server.name} network`}
        routeIdentifier={routeIdentifier}
        tab="network"
        tooltip="Network"
      />
      {canDelete ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Delete ${server.name}`}
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              disabled={!deleteEnabled}
              onClick={() =>
                onDelete({
                  backupAvailable: !server.provisioning,
                  id: server.id,
                  name: server.name,
                  relayId: server.relayId,
                })
              }
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {deleteEnabled ? "Delete" : "Relay unavailable"}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
})

const ServerActionLink = React.memo(function ServerActionLink({
  icon: Icon,
  label,
  routeIdentifier,
  tab,
  tooltip,
}: {
  icon: typeof TerminalSquare
  label: string
  routeIdentifier: string
  tab: "console" | "files" | "network"
  tooltip: string
}) {
  const link =
    tab === "files" ? (
      <Link
        to="/server/$serverId/files/$"
        params={{ serverId: routeIdentifier, _splat: "" }}
        preload="intent"
        aria-label={label}
      >
        <Icon />
      </Link>
    ) : (
      <Link
        to={`/server/$serverId/${tab}`}
        params={{ serverId: routeIdentifier }}
        preload="intent"
        aria-label={label}
      >
        <Icon />
      </Link>
    )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground hover:text-primary"
        >
          {link}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
})

function canDeleteServer(
  access: ServerDeleteAccess,
  server: ServerListInstance
): boolean {
  if (server.brickId === builtinTailscaleBrickId) return false
  return (
    access.all ||
    access.relays.has(server.relayId) ||
    access.instances.has(`${server.relayId}:${server.id}`)
  )
}

function ServerStatus({ server }: { server: ServerListInstance }) {
  const status = serverStatus(server)
  return (
    <span
      aria-label={status.label}
      className={`type-label inline-flex items-center gap-1.5 ${status.text}`}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${status.dot}`} />
      <span className="hidden sm:inline">{status.label}</span>
    </span>
  )
}

function serverStatus(server: ServerListInstance) {
  return server.relayStatus === "unreachable"
    ? {
        dot: "bg-destructive",
        label: "Relay unavailable",
        text: "text-destructive",
      }
    : serverStatusTone(server.observedState)
}

function EmptyServerTable({
  canProvision,
  dialogStore,
  searchActive,
}: {
  canProvision: boolean
  dialogStore: AddServerDialogStore
  searchActive: boolean
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
      <Server className="size-6 text-muted-foreground/45" />
      <p className="mt-3 text-sm font-semibold">
        {searchActive ? "No servers match your search" : "No managed servers"}
      </p>
      <p className="type-support mt-1 max-w-sm text-muted-foreground">
        {searchActive
          ? "Try a server name, short ID, Relay, address, game, implementation, or version."
          : canProvision
            ? "Provision the first game server managed by Hearth."
            : "No server instances have been assigned to your account yet."}
      </p>
      {!searchActive && canProvision ? (
        <Button
          type="button"
          size="sm"
          className="mt-4"
          onClick={dialogStore.open}
        >
          <Plus /> Add Server
        </Button>
      ) : null}
    </div>
  )
}

function serverRowKey(server: ServerListInstance): string {
  return `${server.relayId}:${server.id}`
}

function serverSearchText(server: ServerListInstance): string {
  return [
    server.name,
    server.id,
    server.shortId,
    server.routeId,
    server.game,
    server.implementation,
    server.version,
    server.connectAddress,
    server.relayId,
    server.relayName,
    server.relayStatus,
    server.observedState,
  ]
    .join(" ")
    .toLowerCase()
}

function replaceServerSearch(search: string) {
  const url = new URL(window.location.href)
  if (search.length > 0) url.searchParams.set("search", search)
  else url.searchParams.delete("search")

  // TanStack patches the history instance methods so router consumers update
  // after navigation. Search typing is intentionally local to this workspace;
  // use the browser prototype method to update the current entry without
  // repainting the router's SafeFragment and CatchBoundary tree.
  History.prototype.replaceState.call(
    window.history,
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  )
}

function serverStatusTone(state: ServerListInstance["observedState"]) {
  if (state === "running") {
    return {
      dot: "bg-emerald-400",
      label: "Running",
      text: "text-emerald-300",
    }
  }
  if (state === "failed") {
    return {
      dot: "bg-destructive",
      label: "Failed",
      text: "text-destructive",
    }
  }
  if (state === "starting" || state === "provisioning") {
    return {
      dot: "bg-amber-400",
      label: state === "starting" ? "Starting" : "Provisioning",
      text: "text-amber-300",
    }
  }
  if (state === "stopping") {
    return {
      dot: "bg-amber-400/70",
      label: "Stopping",
      text: "text-amber-300",
    }
  }
  return {
    dot: "bg-muted-foreground/50",
    label: "Stopped",
    text: "text-muted-foreground",
  }
}
