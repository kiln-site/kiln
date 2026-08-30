import * as React from "react"
import { useLiveSuspenseQuery } from "@tanstack/react-db"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import type { DatabaseEngine } from "@workspace/contracts"
import {
  CircleAlert,
  Copy,
  Database,
  Download,
  EllipsisVertical,
  KeyRound,
  LoaderCircle,
  Network,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  Trash2,
  Upload,
  X,
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
import { showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  WorkspaceDataTable,
  WorkspaceTableCell,
  WorkspaceTableHead,
  WorkspaceTableHeading,
  createWorkspaceTableSearchStore,
  useWorkspaceTableSearchInput,
} from "@/components/workspace-data-table"
import type { WorkspaceTableSearchStore } from "@/components/workspace-data-table"
import { InstanceName } from "@/components/instance-name"
import { managedDatabasesCollectionOptions } from "@/lib/collections/managed-databases"
import {
  ServerPickerList,
  serverPickerOptionKey,
} from "@/components/server-picker-list"
import { roleHasPermission } from "@/lib/permissions"
import type { AccessPermission } from "@/lib/permissions"
import {
  accessCapabilitiesQueryOptions,
  managedDatabaseCredentialQueryOptions,
  managedDatabasesQueryOptions,
  queryKeys,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import {
  createManagedDatabase,
  deleteManagedDatabase,
  exportManagedDatabase,
  importManagedDatabase,
  rotateManagedDatabasePassword,
  runManagedDatabaseAction,
  updateManagedDatabaseNetwork,
} from "@/server/databases"
import type { getManagedDatabases } from "@/server/databases"

type ManagedDatabaseOverview = Awaited<ReturnType<typeof getManagedDatabases>>
type ManagedDatabase = ManagedDatabaseOverview["databases"][number]
type ManagedRelay = ManagedDatabaseOverview["relays"][number]
type DatabaseDialog =
  | { kind: "credentials"; database: ManagedDatabase }
  | { kind: "delete"; database: ManagedDatabase }
  | { kind: "import"; database: ManagedDatabase }
  | null

const engineOptions: ReadonlyArray<{
  description: string
  label: string
  value: DatabaseEngine
}> = [
  { value: "mysql", label: "MySQL", description: "8.4 LTS" },
  { value: "mariadb", label: "MariaDB", description: "11.8 LTS" },
  { value: "postgres", label: "Postgres", description: "17" },
  { value: "redis", label: "Redis", description: "8" },
  { value: "valkey", label: "Valkey", description: "8" },
]

const engineBadgeClasses: Record<DatabaseEngine, string> = {
  mariadb:
    "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  mysql: "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  postgres:
    "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  redis: "border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-300",
  valkey:
    "border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300",
}

const emptyDatabases: Array<ManagedDatabase> = []
const dumpLimitBytes = 700_000

export type DatabaseSearchStore = WorkspaceTableSearchStore

export function createDatabaseSearchStore(
  initialValue: string
): DatabaseSearchStore {
  return createWorkspaceTableSearchStore(initialValue)
}

export const DatabasesPage = React.memo(function DatabasesPage({
  searchStore,
}: {
  searchStore: DatabaseSearchStore
}) {
  const { data } = useSuspenseQuery({
    ...managedDatabasesQueryOptions(),
    select: selectDatabasePageMeta,
  })
  const [createOpen, setCreateOpen] = React.useState(false)
  const [dialog, setDialog] = React.useState<DatabaseDialog>(null)
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
    <div className="mx-auto w-full max-w-[90rem] px-3 pb-10 sm:px-5">
      <section
        data-slot="databases-workspace"
        className="overflow-hidden rounded-xl border bg-card/45 [contain:paint]"
      >
        <DatabaseToolbar
          canCreate={canCreate}
          relayErrors={data.relayErrors}
          searchStore={searchStore}
          onCreate={() => setCreateOpen(true)}
        />
        <DatabaseTable
          canCreate={canCreate}
          searchStore={searchStore}
          onCreate={() => setCreateOpen(true)}
          onDialog={openDialog}
        />
      </section>

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
  searchStore: DatabaseSearchStore
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [mobileSearchOpen, setMobileSearchOpen] = React.useState(
    () => searchStore.getSnapshot().length > 0
  )
  const { fetchStatus, refetch } = useQuery({
    ...managedDatabasesQueryOptions(),
    notifyOnChangeProps: ["fetchStatus"],
  })
  const syncing = fetchStatus === "fetching"
  useWorkspaceTableSearchInput(inputRef, searchStore)

  React.useEffect(() => {
    if (mobileSearchOpen) inputRef.current?.focus()
  }, [mobileSearchOpen])

  return (
    <div className="flex min-w-0 items-center gap-2 border-b bg-background/25 p-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="Sync databases"
            aria-busy={syncing}
            disabled={syncing}
            size="icon"
            type="button"
            variant="outline"
            onClick={() => void refetch()}
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

      {!mobileSearchOpen ? (
        <Button
          aria-label="Search databases"
          className="sm:hidden"
          size="icon"
          type="button"
          variant="outline"
          onClick={() => setMobileSearchOpen(true)}
        >
          <Search />
        </Button>
      ) : null}
      <div
        className={`${mobileSearchOpen ? "block" : "hidden"} relative min-w-0 flex-1 sm:block sm:max-w-md`}
      >
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          aria-label="Search databases"
          className="pl-9 text-base md:text-sm"
          defaultValue={searchStore.getServerSnapshot()}
          placeholder="Search databases"
          type="search"
          onChange={(event) => searchStore.set(event.currentTarget.value)}
        />
      </div>
      {mobileSearchOpen ? (
        <Button
          aria-label="Close database search"
          className="sm:hidden"
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => {
            searchStore.set("")
            setMobileSearchOpen(false)
          }}
        >
          <X />
        </Button>
      ) : null}
      <div
        className={`${mobileSearchOpen ? "hidden sm:flex" : "flex"} ml-auto shrink-0`}
      >
        <Button disabled={!canCreate} type="button" onClick={onCreate}>
          <Plus /> Add Database
        </Button>
      </div>
    </div>
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
  searchStore: DatabaseSearchStore
}) {
  const { data: databases } = useLiveSuspenseQuery({
    query: (query) =>
      query
        .from({ database: managedDatabasesCollectionOptions })
        .orderBy(({ database }) => database.name),
  })
  const renderRow = React.useCallback(
    (database: ManagedDatabase) => (
      <DatabaseTableRow database={database} onDialog={onDialog} />
    ),
    [onDialog]
  )
  const renderEmpty = React.useCallback(
    (searchActive: boolean) => (
      <EmptyDatabaseTable
        canCreate={canCreate}
        searchActive={searchActive}
        onCreate={onCreate}
      />
    ),
    [canCreate, onCreate]
  )

  return (
    <WorkspaceDataTable
      getRowKey={databaseRowKey}
      getSearchText={databaseSearchText}
      head={<DatabaseTableHead />}
      items={databases.length > 0 ? databases : emptyDatabases}
      renderEmpty={renderEmpty}
      renderRow={renderRow}
      searchStore={searchStore}
    />
  )
})

const DatabaseTableHead = React.memo(function DatabaseTableHead() {
  return (
    <WorkspaceTableHead>
      <WorkspaceTableHeading className="w-10 px-2 sm:w-24 sm:px-3">
        <span className="sr-only sm:not-sr-only">Status</span>
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-auto sm:w-[26%]">
        Database
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[14%] md:table-cell">
        Engine
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[18%] lg:table-cell">
        Relay
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="hidden w-[25%] xl:table-cell">
        Internal host
      </WorkspaceTableHeading>
      <WorkspaceTableHeading className="w-32 px-1 text-right sm:w-40 sm:px-3">
        Actions
      </WorkspaceTableHeading>
    </WorkspaceTableHead>
  )
})

const DatabaseTableRow = React.memo(function DatabaseTableRow({
  database,
  onDialog,
}: {
  database: ManagedDatabase
  onDialog: (dialog: DatabaseDialog) => void
}) {
  const status = databaseStatusPresentation(
    database.inventoryStatus,
    database.observedState
  )
  return (
    <tr className="group transition-colors hover:bg-accent/25">
      <WorkspaceTableCell className="px-2 sm:px-3">
        <DatabaseStatus status={status} />
      </WorkspaceTableCell>
      <WorkspaceTableCell>
        <InstanceName
          instance={{
            id: database.id,
            inventoryStatus: database.inventoryStatus,
            kind: "database",
            observedState: database.observedState,
            relayId: database.relayId,
          }}
          name={database.name}
          meta={`${database.shortId} · ${database.databaseName}`}
          metaClassName="font-mono"
        />
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden md:table-cell">
        <Badge
          variant="outline"
          className={`type-meta font-mono uppercase ${engineBadgeClasses[database.engine]}`}
        >
          {engineLabel(database.engine)}
        </Badge>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden lg:table-cell">
        <p className="type-meta truncate text-foreground">
          {database.relayName}
        </p>
        <p className="type-meta font-mono text-muted-foreground">
          {database.inventoryStatus === "available"
            ? `${database.connectedInstanceIds.length} connected`
            : database.inventoryStatus === "missing"
              ? "container missing"
              : "inventory unavailable"}
        </p>
      </WorkspaceTableCell>
      <WorkspaceTableCell className="hidden xl:table-cell">
        {database.inventoryStatus === "available" ? (
          <>
            <p className="type-meta truncate font-mono text-foreground">
              {database.hostname}:{database.internalPort}
            </p>
            <p className="type-meta text-muted-foreground">
              private network only
            </p>
          </>
        ) : (
          <p className="type-meta text-muted-foreground">
            {database.inventoryStatus === "missing"
              ? "Container missing"
              : "Relay unavailable"}
          </p>
        )}
      </WorkspaceTableCell>
      <WorkspaceTableCell className="px-1 sm:px-3">
        <DatabaseActions database={database} onDialog={onDialog} />
      </WorkspaceTableCell>
    </tr>
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
    onError: (error) => showOperationError("Database action failed", error),
  })
  const exportDump = useMutation({
    mutationFn: () =>
      exportManagedDatabase({
        data: { databaseId: database.id, relayId: database.relayId },
      }),
    onSuccess: (result) => {
      downloadTextFile(result.fileName, result.content)
      showToast({ message: `Exported ${database.name}`, type: "success" })
    },
    onError: (error) => showOperationError("Export failed", error),
  })
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
  const hasMenuActions =
    (available && can("database.power")) ||
    hasDumpActions ||
    can("database.delete")

  return (
    <div className="flex items-center justify-end gap-1">
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
      {hasMenuActions ? (
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
            {available && can("database.power") ? (
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
            {available &&
            can("database.power") &&
            (hasDumpActions || can("database.delete")) ? (
              <DropdownMenuSeparator />
            ) : null}
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
            {hasDumpActions && can("database.delete") ? (
              <DropdownMenuSeparator />
            ) : null}
            {can("database.delete") ? (
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => onDialog({ kind: "delete", database })}
              >
                <Trash2 /> Delete
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
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

function CredentialsDialog({
  database,
  open,
  onOpenChange,
}: {
  database: ManagedDatabase
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const credential = useQuery(
    managedDatabaseCredentialQueryOptions(database.relayId, database.id)
  )
  const close = React.useCallback(() => {
    queryClient.removeQueries({
      exact: true,
      queryKey: queryKeys.databases.credential(database.relayId, database.id),
    })
    onOpenChange(false)
  }, [database.id, database.relayId, onOpenChange, queryClient])
  const rotate = useMutation({
    mutationFn: () =>
      rotateManagedDatabasePassword({
        data: { databaseId: database.id, relayId: database.relayId },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.databases.credential(database.relayId, database.id),
      })
      showToast({ message: "Database password rotated", type: "success" })
    },
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Credentials</DialogTitle>
          <DialogDescription>
            Use these values from a server connected to {database.name}'s
            private network.
          </DialogDescription>
        </DialogHeader>
        {credential.isPending ? (
          <div className="flex min-h-40 items-center justify-center">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : credential.error ? (
          <p className="text-xs text-destructive">{credential.error.message}</p>
        ) : credential.data ? (
          <div className="space-y-3">
            {database.inventoryStatus === "available" ? (
              <>
                <CredentialField label="Host" value={database.hostname} />
                <div className="grid grid-cols-2 gap-3">
                  <CredentialField
                    label="Port"
                    value={String(database.internalPort)}
                  />
                  <CredentialField
                    label="Database"
                    value={credential.data.databaseName}
                  />
                </div>
              </>
            ) : (
              <CredentialField
                label="Database"
                value={credential.data.databaseName}
              />
            )}
            <CredentialField
              label="Username"
              value={credential.data.username}
            />
            <CredentialField
              label="Password"
              value={credential.data.password}
              secret
            />
          </div>
        ) : null}
        {rotate.error ? (
          <p className="text-xs text-destructive">{rotate.error.message}</p>
        ) : null}
        <DialogFooter className="sm:justify-between">
          {database.inventoryStatus === "available" &&
          database.permissions.includes("database.credentials.rotate") ? (
            <Button
              disabled={rotate.isPending}
              type="button"
              variant="outline"
              onClick={() => rotate.mutate()}
            >
              {rotate.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <RotateCw />
              )}
              Rotate password
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" onClick={close}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CredentialField({
  label,
  secret = false,
  value,
}: {
  label: string
  secret?: boolean
  value: string
}) {
  const [revealed, setRevealed] = React.useState(!secret)
  return (
    <label className="block">
      <span className="type-technical-label mb-1.5 block text-muted-foreground">
        {label}
      </span>
      <div className="flex gap-1.5">
        <Input
          className="font-mono text-xs"
          readOnly
          type={revealed ? "text" : "password"}
          value={value}
          onFocus={(event) => event.currentTarget.select()}
        />
        {secret ? (
          <Button
            aria-label={revealed ? "Hide password" : "Reveal password"}
            type="button"
            variant="outline"
            onClick={() => setRevealed((current) => !current)}
          >
            {revealed ? "Hide" : "Show"}
          </Button>
        ) : null}
        <Button
          aria-label={`Copy ${label.toLowerCase()}`}
          size="icon"
          type="button"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(value)
            showToast({ message: `${label} copied`, type: "success" })
          }}
        >
          <Copy />
        </Button>
      </div>
    </label>
  )
}

const DatabaseNetworkPicker = React.memo(function DatabaseNetworkPicker({
  database,
}: {
  database: ManagedDatabase
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              aria-label={`Connect servers to ${database.name}`}
              aria-expanded={open}
              className="text-muted-foreground hover:text-primary"
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Network />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Connect servers</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="w-[min(32rem,calc(100vw-2rem))] p-1.5"
      >
        {open ? <DatabaseNetworkPickerContent database={database} /> : null}
      </PopoverContent>
    </Popover>
  )
})

function DatabaseNetworkPickerContent({
  database,
}: {
  database: ManagedDatabase
}) {
  const queryClient = useQueryClient()
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  const { data: snapshot } = useQuery(relaySnapshotQueryOptions())
  const servers = React.useMemo(
    () =>
      (snapshot?.instances ?? [])
        .flatMap((instance) => {
          if (instance.relayId !== database.relayId) return []
          const canWrite =
            capabilities.isPlatformAdmin ||
            capabilities.grants.some(
              (grant) =>
                grant.relayId === database.relayId &&
                roleHasPermission(grant.role, "instance.network.write") &&
                (grant.resourceType === "relay" ||
                  (grant.resourceType === "instance" &&
                    grant.resourceId === instance.id))
            )
          return canWrite
            ? [
                {
                  id: instance.id,
                  name: instance.name,
                  relayId: instance.relayId,
                  relayName: instance.relayName,
                },
              ]
            : []
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
    [capabilities, database.relayId, snapshot?.instances]
  )
  const selectedKeys = React.useMemo(
    () =>
      new Set(
        database.connectedInstanceIds.map(
          (instanceId) => `${database.relayId}:${instanceId}`
        )
      ),
    [database.connectedInstanceIds, database.relayId]
  )
  const update = useMutation({
    mutationFn: (input: { connected: boolean; instanceId: string }) =>
      updateManagedDatabaseNetwork({
        data: {
          ...input,
          databaseId: database.id,
          relayId: database.relayId,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.databases.list,
      })
    },
    onError: (error) => showOperationError("Network update failed", error),
  })
  const pendingKey = update.isPending
    ? serverPickerOptionKey({
        id: update.variables.instanceId,
        name: "",
        relayId: database.relayId,
        relayName: "",
      })
    : undefined

  return (
    <ServerPickerList
      ariaLabel={`Servers available to ${database.name}`}
      emptyMessage={`No connectable servers are hosted on ${database.relayName}.`}
      pendingKey={pendingKey}
      selectedKeys={selectedKeys}
      servers={servers}
      onSelect={(server) =>
        update.mutate({
          connected: !selectedKeys.has(serverPickerOptionKey(server)),
          instanceId: server.id,
        })
      }
    />
  )
}

function ImportDatabaseDialog({
  database,
  open,
  onOpenChange,
}: {
  database: ManagedDatabase
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [file, setFile] = React.useState<File | null>(null)
  const [localError, setLocalError] = React.useState<string | null>(null)
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a SQL dump first")
      if (file.size > dumpLimitBytes) {
        throw new Error("SQL dumps are currently limited to 700 KB")
      }
      return importManagedDatabase({
        data: {
          content: await file.text(),
          databaseId: database.id,
          relayId: database.relayId,
        },
      })
    },
    onSuccess: () => {
      showToast({
        message: `Imported ${file?.name ?? "SQL dump"}`,
        type: "success",
      })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import SQL dump</DialogTitle>
          <DialogDescription>
            Statements run against {database.databaseName}. Existing data is not
            cleared first. Current upload limit: 700 KB.
          </DialogDescription>
        </DialogHeader>
        <label className="block rounded-lg border border-dashed border-border p-4 text-center">
          <Upload className="mx-auto size-5 text-muted-foreground" />
          <span className="mt-2 block text-xs font-medium">
            {file?.name ?? "Choose a .sql file"}
          </span>
          <span className="type-meta mt-1 block text-muted-foreground">
            MySQL, MariaDB, and PostgreSQL text dumps
          </span>
          <input
            accept=".sql,application/sql,text/plain"
            className="sr-only"
            type="file"
            onChange={(event) => {
              const next = event.currentTarget.files?.[0] ?? null
              setFile(next)
              setLocalError(
                next && next.size > dumpLimitBytes
                  ? "SQL dumps are currently limited to 700 KB"
                  : null
              )
            }}
          />
        </label>
        {localError || upload.error ? (
          <p className="text-xs text-destructive">
            {localError ?? upload.error?.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={!file || Boolean(localError) || upload.isPending}
            type="button"
            onClick={() => upload.mutate()}
          >
            {upload.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Upload />
            )}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteDatabaseDialog({
  database,
  open,
  onOpenChange,
}: {
  database: ManagedDatabase
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () =>
      deleteManagedDatabase({
        data: { databaseId: database.id, relayId: database.relayId },
      }),
    onSuccess: async () => {
      queryClient.removeQueries({
        queryKey: queryKeys.databases.credential(database.relayId, database.id),
      })
      await queryClient.invalidateQueries({
        queryKey: queryKeys.databases.all,
      })
      showToast({ message: `${database.name} deleted`, type: "success" })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {database.name}?</DialogTitle>
          <DialogDescription>
            The container, isolated network, persistent data volume,
            credentials, and access grants will be permanently removed.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          This action cannot be undone. Export a SQL dump first if you need a
          recovery copy.
        </div>
        {remove.error ? (
          <p className="text-xs text-destructive">{remove.error.message}</p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={remove.isPending}
            type="button"
            variant="destructive"
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Trash2 />
            )}
            Delete database
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function databaseStatusPresentation(
  inventoryStatus: ManagedDatabase["inventoryStatus"],
  state: string
) {
  return inventoryStatus === "missing"
    ? {
        dot: "bg-destructive",
        label: "Missing",
        text: "text-destructive",
      }
    : inventoryStatus === "unavailable"
      ? {
          dot: "bg-amber-300",
          label: "Unavailable",
          text: "text-amber-200",
        }
      : state === "running"
        ? {
            dot: "bg-emerald-400",
            label: "Running",
            text: "text-emerald-300",
          }
        : state === "starting"
          ? {
              dot: "bg-amber-300",
              label: "Starting",
              text: "text-amber-200",
            }
          : state === "failed"
            ? {
                dot: "bg-destructive",
                label: "Failed",
                text: "text-destructive",
              }
            : {
                dot: "bg-muted-foreground",
                label: "Stopped",
                text: "text-muted-foreground",
              }
}

function DatabaseStatus({
  status,
}: {
  status: ReturnType<typeof databaseStatusPresentation>
}) {
  return (
    <span
      aria-label={status.label}
      className={`type-label inline-flex items-center gap-1.5 ${status.text}`}
    >
      <span className={`size-1.5 rounded-full ${status.dot}`} />
      <span className="hidden sm:inline">{status.label}</span>
    </span>
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
    <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
      <Database className="size-6 text-muted-foreground/45" />
      <p className="mt-3 text-sm font-semibold">
        {searchActive
          ? "No databases match your search"
          : "No managed databases"}
      </p>
      <p className="type-support mt-1 max-w-sm text-muted-foreground">
        {searchActive
          ? "Try a database name, engine, ID, Relay, or internal hostname."
          : canCreate
            ? "Provision a private MySQL, MariaDB, PostgreSQL, Redis, or Valkey database."
            : "No databases have been assigned to your account yet."}
      </p>
      {!searchActive && canCreate ? (
        <Button className="mt-4" size="sm" type="button" onClick={onCreate}>
          <Plus /> Add Database
        </Button>
      ) : null}
    </div>
  )
}

function databaseRowKey(database: ManagedDatabase): string {
  return `${database.relayId}:${database.id}`
}

function databaseSearchText(database: ManagedDatabase): string {
  return [
    database.name,
    database.id,
    database.shortId,
    database.engine,
    database.databaseName,
    database.hostname,
    database.relayName,
  ].join(" ")
}

function engineLabel(engine: DatabaseEngine): string {
  return (
    engineOptions.find((option) => option.value === engine)?.label ?? engine
  )
}

function downloadTextFile(fileName: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/sql" })
  )
  const link = document.createElement("a")
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

function showOperationError(message: string, error: Error) {
  showToast({
    message: `${message}: ${error.message}`,
    type: "error",
  })
}
