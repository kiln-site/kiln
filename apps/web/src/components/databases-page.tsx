import {
  PendingResourceInvitations,
  PendingResourceInvitationBadge,
  resourceInvitationScopeKey,
} from "@/components/pending-resource-invitations"
import * as React from "react"
import { useDbClient, useLiveQuery } from "@tanstack/react-db"
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { DatabaseEngine } from "@workspace/contracts"
import {
  Database,
  Download,
  EllipsisVertical,
  KeyRound,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Square,
  Trash2,
  Upload,
} from "lucide-react"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  DataTableActionGroup,
  DataTableEmptyState,
  DataTableTextCell,
} from "@/components/data-table"
import { CopyIdentifierMenuItem } from "@/components/copy-identifier-menu-item"
import {
  CredentialsDialog,
  DeleteDatabaseDialog,
  ImportDatabaseDialog,
  useDatabaseExport,
} from "@/components/database/database-dialogs"
import { DatabaseNetworkPicker } from "@/components/database/database-network"
import {
  DatabaseStatus,
  databaseStatusPresentation,
  engineBadgeClasses,
  engineLabel,
  engineOptions,
  showDatabaseOperationError,
  type ManagedDatabase,
  type ManagedDatabaseOverview,
} from "@/components/database/database-presentation"
import {
  FavoritesOnlyButton,
  FavoritesOnlyEmptyState,
  InstanceFavoriteMenuItem,
  InstanceFavoriteToggle,
  useFavoritesOnly,
  useFavoritesOnlySource,
} from "@/components/instance-favorite"
import { DataTable } from "@/components/data-table-view"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import { InstanceName } from "@/components/instance-name"
import { getManagedDatabasesCollection } from "@/lib/collections/managed-databases"
import type { InstanceFavorite } from "@/lib/instance-favorites"
import type { AccessPermission } from "@/lib/permissions"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import {
  replaceDataTableUrlSearch,
  type DataTableSearchStore,
} from "@/lib/data-table-search"
import { useLiveDataTableSource } from "@/lib/data-table-source"
import { managedDatabasesQueryOptions, queryKeys } from "@/lib/query-options"
import { ensuringPromise, forkPromise } from "@/effect/promise"
import {
  createManagedDatabase,
  runManagedDatabaseAction,
} from "@/server/databases"

type ManagedRelay = ManagedDatabaseOverview["relays"][number]
type DatabaseDialog =
  | { kind: "credentials"; database: ManagedDatabase }
  | { kind: "delete"; database: ManagedDatabase }
  | { kind: "import"; database: ManagedDatabase }
  | null

const databaseInventoryError = new Error("Could not load databases")
const minimumManualSyncFeedbackMs = 500
const databaseTableColumnHelper = createDataTableColumnHelper<ManagedDatabase>()
const databaseTableSearchFields = [
  (database: ManagedDatabase) => database.name,
  (database: ManagedDatabase) => database.id,
  (database: ManagedDatabase) => database.shortId,
  (database: ManagedDatabase) => database.engine,
  (database: ManagedDatabase) => database.databaseName,
  (database: ManagedDatabase) => database.hostname,
  (database: ManagedDatabase) => database.relayId,
  (database: ManagedDatabase) => database.relayName,
] as const

export const DatabasesPage = React.memo(function DatabasesPage({
  searchStore,
}: {
  searchStore: DataTableSearchStore
}) {
  const { data } = useSuspenseQuery({
    ...managedDatabasesQueryOptions(),
    select: selectDatabasePageMeta,
  })
  const [createOpen, setCreateOpen] = React.useState(false)
  const [dialog, setDialog] = React.useState<DatabaseDialog>(null)
  const openCreate = React.useCallback(() => setCreateOpen(true), [])
  const openDialog = React.useCallback((next: DatabaseDialog) => {
    setDialog(next)
  }, [])
  const canCreate = data.relays.some((relay) => relay.canCreate)
  const relayErrorKey = data.relayErrors
    .map((error) => `${error.relayId}:${error.message}`)
    .join("|")
  const relayErrorNames = data.relayErrors
    .map((error) => error.relayName)
    .join(", ")

  React.useEffect(() => {
    if (!relayErrorKey) return
    showToast({
      id: "database-inventory-relay-errors",
      message: `${relayErrorNames} could not report database inventory`,
      type: "warning",
    })
  }, [relayErrorKey, relayErrorNames])

  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-3 pb-3 sm:px-5 sm:pb-5">
      <DataTableWorkspace
        toolbar={
          <DatabaseToolbar
            canCreate={canCreate}
            relayErrors={data.relayErrors}
            searchStore={searchStore}
            onCreate={openCreate}
          />
        }
      >
        <DatabaseTable
          canCreate={canCreate}
          searchStore={searchStore}
          onCreate={openCreate}
          onDialog={openDialog}
        />
      </DataTableWorkspace>

      {createOpen ? (
        <CreateDatabaseDialog
          open
          relays={data.relays}
          onOpenChange={setCreateOpen}
        />
      ) : null}
      {dialog?.kind === "credentials" ? (
        <CredentialsDialog
          key={`${dialog.database.relayId}:${dialog.database.id}`}
          database={dialog.database}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
        />
      ) : null}
      {dialog?.kind === "import" ? (
        <ImportDatabaseDialog
          key={`${dialog.database.relayId}:${dialog.database.id}`}
          database={dialog.database}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <DeleteDatabaseDialog
          key={`${dialog.database.relayId}:${dialog.database.id}`}
          database={dialog.database}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
        />
      ) : null}
    </div>
  )
})

function selectDatabasePageMeta(data: ManagedDatabaseOverview) {
  return { relayErrors: data.relayErrors, relays: data.relays }
}

const DatabaseToolbar = React.memo(function DatabaseToolbar({
  canCreate,
  onCreate,
  relayErrors,
  searchStore,
}: {
  canCreate: boolean
  onCreate: () => void
  relayErrors: ManagedDatabaseOverview["relayErrors"]
  searchStore: DataTableSearchStore
}) {
  return (
    <DataTableToolbar
      actions={
        canCreate ? (
          <Button type="button" onClick={onCreate}>
            <Plus /> Add Database
          </Button>
        ) : null
      }
      controls={<FavoritesOnlyButton table="databases" />}
      leading={<DatabaseSyncButton relayErrors={relayErrors} />}
      search={{
        ariaLabel: "Search databases",
        closeMobileWhenEmpty: true,
        id: "database-search",
        onValueChange: replaceDataTableUrlSearch,
        placeholder: "Search databases",
        store: searchStore,
      }}
    />
  )
})

const DatabaseSyncButton = React.memo(function DatabaseSyncButton({
  relayErrors,
}: {
  relayErrors: ManagedDatabaseOverview["relayErrors"]
}) {
  const dbClient = useDbClient()
  const [syncing, setSyncing] = React.useState(false)
  const syncingRef = React.useRef(false)
  const feedbackTimeoutRef = React.useRef<number>(undefined)
  const mountedRef = React.useRef(true)

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (feedbackTimeoutRef.current !== undefined) {
        window.clearTimeout(feedbackTimeoutRef.current)
      }
    }
  }, [])

  const syncDatabases = React.useCallback(() => {
    if (syncingRef.current) return
    syncingRef.current = true
    setSyncing(true)
    const startedAt = performance.now()

    forkPromise(() =>
      ensuringPromise(
        () =>
          getManagedDatabasesCollection(dbClient).utils.refetch({
            throwOnError: true,
          }),
        () => {
          if (!mountedRef.current) return
          const elapsed = performance.now() - startedAt
          const remaining = Math.max(0, minimumManualSyncFeedbackMs - elapsed)
          feedbackTimeoutRef.current = window.setTimeout(() => {
            syncingRef.current = false
            setSyncing(false)
            feedbackTimeoutRef.current = undefined
          }, remaining)
        }
      )
    )
  }, [dbClient])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label="Sync databases"
          aria-busy={syncing}
          disabled={syncing}
          size="icon"
          type="button"
          variant="outline"
          onClick={syncDatabases}
        >
          <RefreshCw className={syncing ? "animate-spin" : ""} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {relayErrors.length > 0
          ? `Inventory unavailable from ${relayErrors.map((error) => error.relayName).join(", ")}. Sync again.`
          : "Sync databases"}
      </TooltipContent>
    </Tooltip>
  )
})

const DatabaseTable = React.memo(function DatabaseTable({
  canCreate,
  onCreate,
  onDialog,
  searchStore,
}: {
  canCreate: boolean
  onCreate: () => void
  onDialog: (dialog: DatabaseDialog) => void
  searchStore: DataTableSearchStore
}) {
  const dbClient = useDbClient()
  const collection = getManagedDatabasesCollection(dbClient)
  const result = useLiveQuery(collection)
  const retry = React.useCallback(() => {
    forkPromise(() => collection.utils.refetch({ throwOnError: true }))
  }, [collection])
  const source = useLiveDataTableSource<ManagedDatabase>({
    data: result.data,
    error: databaseInventoryError,
    isError: result.isError,
    isLoading: result.isLoading,
    retry,
  })
  const [favoritesOnly] = useFavoritesOnly("databases")
  const visibleSource = useFavoritesOnlySource(
    source,
    favoritesOnly,
    databaseFavorite
  )
  const favoritesFiltered = favoritesOnly && source.rows.length > 0
  const visibleResourceKeys = React.useMemo(
    () =>
      new Set(
        visibleSource.rows.map((database) =>
          resourceInvitationScopeKey(database.relayId, database.id)
        )
      ),
    [visibleSource.rows]
  )
  const [initialTableState] = React.useState(() => ({
    sorting: [{ desc: false, id: "database" }],
  }))
  const definition = React.useMemo(() => {
    const columns = databaseTableColumnHelper.columns([
      databaseTableColumnHelper.accessor(
        (database) =>
          databaseStatusPresentation(
            database.inventoryStatus,
            database.observedState
          ).label,
        {
          id: "status",
          header: () => <span className="sr-only sm:not-sr-only">Status</span>,
          sortFn: "text",
          cell: ({ row }) => (
            <DatabaseStatus
              status={databaseStatusPresentation(
                row.original.inventoryStatus,
                row.original.observedState
              )}
            />
          ),
          meta: dataTableColumnMeta(
            { width: { base: "2.5rem", sm: "7.5rem" } },
            {
              cellClassName: "px-2 sm:px-3",
              headerClassName: "px-2 sm:px-3",
              headerLabelClassName: "shrink-0 overflow-visible text-clip",
            }
          ),
        }
      ),
      databaseTableColumnHelper.display({
        id: "favorite",
        header: () => <span className="sr-only">Favorite</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <InstanceFavoriteToggle
            id={row.original.id}
            kind="database"
            name={row.original.name}
            relayId={row.original.relayId}
          />
        ),
        meta: dataTableColumnMeta(
          { width: { base: "1.75rem" } },
          { cellClassName: "px-0", headerClassName: "px-0" }
        ),
      }),
      databaseTableColumnHelper.accessor((database) => database.name, {
        id: "database",
        header: "Database",
        sortFn: "text",
        cell: ({ row }) => {
          const database = row.original
          return (
            <div className="flex w-full min-w-0 items-center gap-1">
              <Link
                to="/db/$databaseId"
                // The full ID always resolves; the route shortens it when
                // no other database shares its short ID.
                params={{ databaseId: database.id }}
                preload="intent"
                className="group/database-link flex min-h-14 min-w-0 flex-1 items-center outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
              >
                <InstanceName
                  className="min-w-0 flex-1"
                  instance={{
                    id: database.id,
                    inventoryStatus: database.inventoryStatus,
                    kind: "database",
                    observedState: database.observedState,
                    relayId: database.relayId,
                  }}
                  live={false}
                  name={database.name}
                  nameClassName="transition-colors group-hover/database-link:text-primary"
                  meta={database.shortId}
                  metaClassName="font-mono"
                  showFavorite={false}
                />
              </Link>
              <PendingResourceInvitationBadge
                resourceType="database"
                relayId={database.relayId}
                resourceId={database.id}
              />
            </div>
          )
        },
        meta: dataTableColumnMeta({
          width: { base: "minmax(0,1fr)", md: "minmax(0,1.5fr)" },
        }),
      }),
      databaseTableColumnHelper.accessor((database) => database.engine, {
        id: "engine",
        header: "Engine",
        sortFn: "text",
        cell: ({ row }) => (
          <Badge
            variant="outline"
            className={`type-meta font-mono uppercase ${engineBadgeClasses[row.original.engine]}`}
          >
            {engineLabel(row.original.engine)}
          </Badge>
        ),
        meta: dataTableColumnMeta({
          hideBelow: "md",
          width: "8.5rem",
        }),
      }),
      databaseTableColumnHelper.accessor((database) => database.relayName, {
        id: "relay",
        header: "Relay",
        sortFn: "text",
        cell: ({ row }) => <DataTableTextCell value={row.original.relayName} />,
        meta: dataTableColumnMeta({
          hideBelow: "md",
          width: "minmax(8rem,0.8fr)",
        }),
      }),
      databaseTableColumnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <DatabaseActions database={row.original} onDialog={onDialog} />
        ),
        meta: dataTableColumnMeta(
          { width: { base: "8.5rem", sm: "9.5rem" } },
          {
            cellClassName: "px-1 sm:px-3",
            headerClassName: "px-1 sm:px-3",
          }
        ),
      }),
    ])
    return defineDataTable({
      ariaLabel: "Databases",
      columns,
      getRowId: databaseRowKey,
      model: {
        initialState: initialTableState,
      },
      search: { fields: databaseTableSearchFields },
      virtualization: true,
    })
  }, [initialTableState, onDialog])

  return (
    <DataTable
      leadingBody={
        <PendingResourceInvitations
          resourceType="database"
          visibleResourceKeys={visibleResourceKeys}
          searchStore={searchStore}
        />
      }
      definition={definition}
      emptyState={({ searchActive }) =>
        favoritesFiltered ? (
          <FavoritesOnlyEmptyState
            icon={<Database className="size-6 text-muted-foreground/45" />}
            searchActive={searchActive}
            table="databases"
          />
        ) : (
          <EmptyDatabaseTable
            canCreate={canCreate}
            searchActive={searchActive}
            onCreate={onCreate}
          />
        )
      }
      searchStore={searchStore}
      source={visibleSource}
    />
  )
})

const DatabaseActions = React.memo(function DatabaseActions({
  database,
  onDialog,
}: {
  database: ManagedDatabase
  onDialog: (dialog: DatabaseDialog) => void
}) {
  const queryClient = useQueryClient()
  const action = useMutation({
    mutationFn: (nextAction: "restart" | "start" | "stop") =>
      runManagedDatabaseAction({
        data: {
          action: nextAction,
          databaseId: database.id,
          relayId: database.relayId,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.databases.list,
      })
    },
    onError: (error) =>
      showDatabaseOperationError("Database action failed", error),
  })
  const exportDump = useDatabaseExport(database)
  const can = React.useCallback(
    (permission: AccessPermission) => database.permissions.includes(permission),
    [database.permissions]
  )
  const running = database.observedState === "running"
  const available = database.inventoryStatus === "available"
  const busy = action.isPending || exportDump.isPending
  const canExport =
    available &&
    database.hasCredentials &&
    database.supportsImportExport &&
    can("database.dump.export")
  const canImport =
    available &&
    database.hasCredentials &&
    database.supportsImportExport &&
    can("database.dump.import")
  const hasDumpActions = canExport || canImport
  const canPower = available && can("database.power")
  const canDelete = can("database.delete")
  const hasOperationalActions = canPower || hasDumpActions

  return (
    <DataTableActionGroup>
      {can("database.credentials.read") && database.hasCredentials ? (
        <ActionIconButton
          icon={KeyRound}
          label={`View ${database.name} credentials`}
          tooltip="Credentials"
          onClick={() => onDialog({ kind: "credentials", database })}
        />
      ) : null}
      {available && can("database.network.write") ? (
        <DatabaseNetworkPicker database={database} />
      ) : null}
      {canDelete ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={`Delete ${database.name}`}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={busy}
              size="icon-sm"
              type="button"
              variant="ghost"
              onClick={() => onDialog({ kind: "delete", database })}
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Delete</TooltipContent>
        </Tooltip>
      ) : null}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={`More actions for ${database.name}`}
                disabled={busy}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                {busy ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <EllipsisVertical />
                )}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-44">
          <InstanceFavoriteMenuItem
            favorite={{
              id: database.id,
              kind: "database",
              relayId: database.relayId,
            }}
          />
          <DropdownMenuSeparator />
          {canPower ? (
            <>
              <DropdownMenuItem
                onSelect={() => action.mutate(running ? "stop" : "start")}
              >
                {running ? <Square /> : <Play />}
                {running ? "Stop" : "Start"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => action.mutate("restart")}>
                <RotateCw /> Restart
              </DropdownMenuItem>
            </>
          ) : null}
          {canPower && hasDumpActions ? <DropdownMenuSeparator /> : null}
          {canExport ? (
            <DropdownMenuItem onSelect={() => exportDump.mutate()}>
              <Download /> Export SQL
            </DropdownMenuItem>
          ) : null}
          {canImport ? (
            <DropdownMenuItem
              onSelect={() => onDialog({ kind: "import", database })}
            >
              <Upload /> Import SQL
            </DropdownMenuItem>
          ) : null}
          {hasOperationalActions ? <DropdownMenuSeparator /> : null}
          <CopyIdentifierMenuItem label="Database ID" value={database.id} />
          <CopyIdentifierMenuItem label="Relay ID" value={database.relayId} />
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
  )
})

function ActionIconButton({
  disabled = false,
  icon: Icon,
  label,
  onClick,
  tooltip,
}: {
  disabled?: boolean
  icon: typeof Database
  label: string
  onClick: () => void
  tooltip: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className="text-muted-foreground hover:text-primary"
          disabled={disabled}
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={onClick}
        >
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

function CreateDatabaseDialog({
  open,
  onOpenChange,
  relays,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  relays: Array<ManagedRelay>
}) {
  const queryClient = useQueryClient()
  const availableRelays = relays.filter((relay) => relay.canCreate)
  const [name, setName] = React.useState("")
  const [engine, setEngine] = React.useState<DatabaseEngine>("postgres")
  const [relayId, setRelayId] = React.useState(
    () => availableRelays.at(0)?.id ?? ""
  )
  const relayLabelId = React.useId()
  const create = useMutation({
    mutationFn: () =>
      createManagedDatabase({
        data: { engine, name: name.trim(), relayId },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.databases.all,
      })
      showToast({ message: `${name.trim()} is ready`, type: "success" })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add database</DialogTitle>
          <DialogDescription>
            Hearth creates a private network, persistent volume, and generated
            credentials. No host port is published.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block">
            <span className="mb-2 block text-xs font-medium">Name</span>
            <Input
              autoFocus
              maxLength={64}
              placeholder="Production data"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <fieldset>
            <legend className="mb-2 text-xs font-medium">Engine</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {engineOptions.map((option) => (
                <button
                  key={option.value}
                  aria-pressed={engine === option.value}
                  className={`rounded-lg border px-2 py-3 text-left transition-colors ${
                    engine === option.value
                      ? "border-primary/60 bg-primary/10 text-foreground"
                      : "border-border/70 bg-background/30 text-muted-foreground hover:bg-accent/30"
                  }`}
                  type="button"
                  onClick={() => setEngine(option.value)}
                >
                  <span className="type-card-title block">{option.label}</span>
                  <span className="type-meta mt-0.5 block font-mono">
                    {option.description}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
          <div>
            <span id={relayLabelId} className="mb-2 block text-xs font-medium">
              Relay
            </span>
            <Select value={relayId} onValueChange={setRelayId}>
              <SelectTrigger
                aria-labelledby={relayLabelId}
                className="h-9 w-full px-3"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableRelays.map((relay) => (
                  <SelectItem key={relay.id} value={relay.id}>
                    {relay.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {create.error ? (
            <p className="text-xs text-destructive">{create.error.message}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={create.isPending || !name.trim() || !relayId}
            type="button"
            onClick={() => create.mutate()}
          >
            {create.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Plus />
            )}
            Create database
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EmptyDatabaseTable({
  canCreate,
  onCreate,
  searchActive,
}: {
  canCreate: boolean
  onCreate: () => void
  searchActive: boolean
}) {
  return (
    <DataTableEmptyState
      action={
        !searchActive && canCreate ? (
          <Button size="sm" type="button" onClick={onCreate}>
            <Plus /> Add Database
          </Button>
        ) : null
      }
      description={
        <span className="block max-w-sm">
          {searchActive
            ? "Try a database name, engine, ID, Relay, or internal hostname."
            : canCreate
              ? "Provision a private MySQL, MariaDB, PostgreSQL, Redis, or Valkey database."
              : "No databases have been assigned to your account yet."}
        </span>
      }
      icon={<Database className="size-6 text-muted-foreground/45" />}
      title={
        searchActive ? "No databases match your search" : "No managed databases"
      }
    />
  )
}

function databaseRowKey(database: ManagedDatabase): string {
  return `${database.relayId}:${database.id}`
}

function databaseFavorite(database: ManagedDatabase): InstanceFavorite {
  return { id: database.id, kind: "database", relayId: database.relayId }
}
