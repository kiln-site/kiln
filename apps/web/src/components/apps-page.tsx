import * as React from "react"
import { useDbClient, useLiveQuery } from "@tanstack/react-db"
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  Boxes,
  Container,
  EllipsisVertical,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react"

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
  appRelayAvailable,
  appStatusPresentation,
  showAppOperationError,
  type App,
  type AppOverview,
} from "@/components/app/app-presentation"
import { DeleteAppDialog } from "@/components/app/app-dialogs"
import { CopyIdentifierMenuItem } from "@/components/copy-identifier-menu-item"
import {
  DataTableActionGroup,
  DataTableEmptyState,
  DataTableTextCell,
} from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import {
  DataTableToolbar,
  DataTableWorkspace,
} from "@/components/data-table-workspace"
import {
  FavoritesOnlyButton,
  FavoritesOnlyEmptyState,
  InstanceFavoriteMenuItem,
  InstanceFavoriteToggle,
  useFavoritesOnly,
  useFavoritesOnlySource,
} from "@/components/instance-favorite"
import { InstanceName } from "@/components/instance-name"
import { statusColumnWidth } from "@/components/instance-name-presentation"
import { StatusIndicator } from "@/components/status-indicator"
import { ensuringPromise, forkPromise } from "@/effect/promise"
import { getAppsCollection } from "@/lib/collections/apps"
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
import type { InstanceFavorite } from "@/lib/instance-favorites"
import { appsQueryOptions, queryKeys } from "@/lib/query-options"
import { createApp, deployApp, runAppAction } from "@/server/apps"

type AppRelay = AppOverview["relays"][number]

const appInventoryError = new Error("Could not load apps")
const minimumManualSyncFeedbackMs = 500
const appTableColumnHelper = createDataTableColumnHelper<App>()
const appTableSearchFields = [
  (app: App) => app.name,
  (app: App) => app.id,
  (app: App) => app.shortId,
  (app: App) => app.hostname,
  (app: App) => app.relayId,
  (app: App) => app.relayName,
  (app: App) => app.containers.map((container) => container.name).join(" "),
  (app: App) => app.containers.map((container) => container.image).join(" "),
] as const

export const AppsPage = React.memo(function AppsPage({
  searchStore,
}: {
  searchStore: DataTableSearchStore
}) {
  const { data } = useSuspenseQuery({
    ...appsQueryOptions(),
    select: selectAppPageMeta,
  })
  const [createOpen, setCreateOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState<App | null>(null)
  const openCreate = React.useCallback(() => setCreateOpen(true), [])
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
      id: "app-inventory-relay-errors",
      message: `${relayErrorNames} could not report app inventory`,
      type: "warning",
    })
  }, [relayErrorKey, relayErrorNames])

  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-3 pb-3 sm:px-5 sm:pb-5">
      <DataTableWorkspace
        toolbar={
          <AppToolbar
            canCreate={canCreate}
            relayErrors={data.relayErrors}
            searchStore={searchStore}
            onCreate={openCreate}
          />
        }
      >
        <AppTable
          canCreate={canCreate}
          searchStore={searchStore}
          onCreate={openCreate}
          onDelete={setDeleting}
        />
      </DataTableWorkspace>

      {createOpen ? (
        <CreateAppDialog relays={data.relays} onOpenChange={setCreateOpen} />
      ) : null}
      {deleting ? (
        <DeleteAppDialog
          key={`${deleting.relayId}:${deleting.id}`}
          app={deleting}
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null)
          }}
        />
      ) : null}
    </div>
  )
})

function selectAppPageMeta(data: AppOverview) {
  return { relayErrors: data.relayErrors, relays: data.relays }
}

const AppToolbar = React.memo(function AppToolbar({
  canCreate,
  onCreate,
  relayErrors,
  searchStore,
}: {
  canCreate: boolean
  onCreate: () => void
  relayErrors: AppOverview["relayErrors"]
  searchStore: DataTableSearchStore
}) {
  return (
    <DataTableToolbar
      actions={
        canCreate ? (
          <Button type="button" onClick={onCreate}>
            <Plus /> Add App
          </Button>
        ) : null
      }
      controls={<FavoritesOnlyButton table="apps" />}
      leading={<AppSyncButton relayErrors={relayErrors} />}
      search={{
        ariaLabel: "Search apps",
        closeMobileWhenEmpty: true,
        id: "app-search",
        onValueChange: replaceDataTableUrlSearch,
        placeholder: "Search apps",
        store: searchStore,
      }}
    />
  )
})

const AppSyncButton = React.memo(function AppSyncButton({
  relayErrors,
}: {
  relayErrors: AppOverview["relayErrors"]
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

  const syncApps = React.useCallback(() => {
    if (syncingRef.current) return
    syncingRef.current = true
    setSyncing(true)
    const startedAt = performance.now()
    forkPromise(() =>
      ensuringPromise(
        () => getAppsCollection(dbClient).utils.refetch({ throwOnError: true }),
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
          aria-label="Sync apps"
          aria-busy={syncing}
          disabled={syncing}
          size="icon"
          type="button"
          variant="outline"
          onClick={syncApps}
        >
          <RefreshCw className={syncing ? "animate-spin" : ""} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {relayErrors.length > 0
          ? `Inventory unavailable from ${relayErrors.map((error) => error.relayName).join(", ")}. Sync again.`
          : "Sync apps"}
      </TooltipContent>
    </Tooltip>
  )
})

const AppTable = React.memo(function AppTable({
  canCreate,
  onCreate,
  onDelete,
  searchStore,
}: {
  canCreate: boolean
  onCreate: () => void
  onDelete: (app: App) => void
  searchStore: DataTableSearchStore
}) {
  const dbClient = useDbClient()
  const collection = getAppsCollection(dbClient)
  const result = useLiveQuery(collection)
  const retry = React.useCallback(() => {
    forkPromise(() => collection.utils.refetch({ throwOnError: true }))
  }, [collection])
  const source = useLiveDataTableSource<App>({
    data: result.data,
    error: appInventoryError,
    isError: result.isError,
    isLoading: result.isLoading,
    retry,
  })
  const [favoritesOnly] = useFavoritesOnly("apps")
  const visibleSource = useFavoritesOnlySource(
    source,
    favoritesOnly,
    appFavorite
  )
  const favoritesFiltered = favoritesOnly && source.rows.length > 0
  const [initialTableState] = React.useState(() => ({
    sorting: [{ desc: false, id: "app" }],
  }))
  const definition = React.useMemo(() => {
    const columns = appTableColumnHelper.columns([
      appTableColumnHelper.accessor((app) => appStatusPresentation(app).label, {
        id: "status",
        header: () => <span className="sr-only sm:not-sr-only">Status</span>,
        sortFn: "text",
        cell: ({ row }) => (
          <StatusIndicator status={appStatusPresentation(row.original)} />
        ),
        meta: dataTableColumnMeta(
          { width: { base: "2.5rem", sm: statusColumnWidth } },
          {
            cellClassName: "px-2 sm:px-3",
            headerClassName: "px-2 sm:px-3",
            headerLabelClassName: "shrink-0 overflow-visible text-clip",
          }
        ),
      }),
      appTableColumnHelper.display({
        id: "favorite",
        header: () => <span className="sr-only">Favorite</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <InstanceFavoriteToggle
            id={row.original.id}
            kind="app"
            name={row.original.name}
            relayId={row.original.relayId}
          />
        ),
        meta: dataTableColumnMeta(
          { width: { base: "1.75rem" } },
          { cellClassName: "px-0", headerClassName: "px-0" }
        ),
      }),
      appTableColumnHelper.accessor((app) => app.name, {
        id: "app",
        header: "App",
        sortFn: "text",
        cell: ({ row }) => {
          const app = row.original
          return (
            <Link
              to="/app/$appId"
              // The full ID always resolves; the route shortens it when no
              // other app shares its short ID.
              params={{ appId: app.id }}
              preload="intent"
              className="group/app-link flex min-h-14 w-full min-w-0 items-center outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
            >
              <InstanceName
                className="min-w-0 flex-1"
                instance={{
                  id: app.id,
                  inventoryStatus: app.inventoryStatus,
                  kind: "app",
                  observedState: app.observedState,
                  relayId: app.relayId,
                  relayStatus: app.relayStatus,
                  relayUpdating: app.relayUpdating,
                }}
                live={false}
                name={app.name}
                nameClassName="transition-colors group-hover/app-link:text-primary"
                meta={app.shortId}
                metaClassName="font-mono"
                showFavorite={false}
              />
            </Link>
          )
        },
        meta: dataTableColumnMeta({
          width: { base: "minmax(0,1fr)", md: "minmax(0,1.5fr)" },
        }),
      }),
      appTableColumnHelper.accessor((app) => appContainersLabel(app), {
        id: "containers",
        header: "Containers",
        sortFn: "text",
        cell: ({ row }) => (
          <DataTableTextCell value={appContainersLabel(row.original)} />
        ),
        meta: dataTableColumnMeta({ hideBelow: "md", width: "9rem" }),
      }),
      appTableColumnHelper.accessor((app) => app.relayName, {
        id: "relay",
        header: "Relay",
        sortFn: "text",
        cell: ({ row }) => <DataTableTextCell value={row.original.relayName} />,
        meta: dataTableColumnMeta({
          hideBelow: "md",
          width: "minmax(8rem,0.8fr)",
        }),
      }),
      appTableColumnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <AppActions app={row.original} onDelete={onDelete} />
        ),
        meta: dataTableColumnMeta(
          { width: { base: "6.5rem", sm: "7.5rem" } },
          { cellClassName: "px-1 sm:px-3", headerClassName: "px-1 sm:px-3" }
        ),
      }),
    ])
    return defineDataTable({
      ariaLabel: "Apps",
      columns,
      getRowId: appRowKey,
      model: { initialState: initialTableState },
      search: { fields: appTableSearchFields },
      virtualization: true,
    })
  }, [initialTableState, onDelete])

  return (
    <DataTable
      definition={definition}
      emptyState={({ searchActive }) =>
        favoritesFiltered ? (
          <FavoritesOnlyEmptyState
            icon={<Boxes className="size-6 text-muted-foreground/45" />}
            searchActive={searchActive}
            table="apps"
          />
        ) : (
          <EmptyAppTable
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

const AppActions = React.memo(function AppActions({
  app,
  onDelete,
}: {
  app: App
  onDelete: (app: App) => void
}) {
  const queryClient = useQueryClient()
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.apps.list })
  const deploy = useMutation({
    mutationFn: () =>
      deployApp({ data: { appId: app.id, relayId: app.relayId } }),
    onSuccess: invalidate,
    onError: (error) => showAppOperationError("Deploy failed", error),
  })
  const action = useMutation({
    mutationFn: (nextAction: "restart" | "start" | "stop") =>
      runAppAction({
        data: { action: nextAction, appId: app.id, relayId: app.relayId },
      }),
    onSuccess: invalidate,
    onError: (error) => showAppOperationError("App action failed", error),
  })
  const available = appRelayAvailable(app)
  const canManage = available && app.permissions.includes("app.manage")
  const deploying = app.deployment?.state === "running"
  const running = app.observedState === "running"
  const busy = deploy.isPending || action.isPending

  return (
    <DataTableActionGroup>
      {canManage ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={`Deploy ${app.name}`}
              className="text-muted-foreground hover:text-primary"
              disabled={busy || deploying}
              size="icon-sm"
              type="button"
              variant="ghost"
              onClick={() => deploy.mutate()}
            >
              {deploying || deploy.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Rocket />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {deploying ? "Deploying" : "Deploy"}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {app.permissions.includes("app.delete") ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={`Delete ${app.name}`}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={busy}
              size="icon-sm"
              type="button"
              variant="ghost"
              onClick={() => onDelete(app)}
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
                aria-label={`More actions for ${app.name}`}
                disabled={busy}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                {action.isPending ? (
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
            favorite={{ id: app.id, kind: "app", relayId: app.relayId }}
          />
          <DropdownMenuSeparator />
          {canManage && app.containers.length > 0 ? (
            <>
              <DropdownMenuItem
                disabled={deploying}
                onSelect={() => action.mutate(running ? "stop" : "start")}
              >
                {running ? <Square /> : <Play />}
                {running ? "Stop" : "Start"}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={deploying}
                onSelect={() => action.mutate("restart")}
              >
                <RotateCw /> Restart
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <CopyIdentifierMenuItem label="App ID" value={app.id} />
          <CopyIdentifierMenuItem label="Relay ID" value={app.relayId} />
        </DropdownMenuContent>
      </DropdownMenu>
    </DataTableActionGroup>
  )
})

// What an app can run as. Docker is the only kind for now; more arrive with
// a richer catalog.
const appKinds = [
  {
    description: "An image, Dockerfile, or Compose file",
    icon: Container,
    id: "docker",
    label: "Docker",
  },
] as const

function CreateAppDialog({
  onOpenChange,
  relays,
}: {
  onOpenChange: (open: boolean) => void
  relays: Array<AppRelay>
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const availableRelays = relays.filter((relay) => relay.canCreate)
  const [kind, setKind] = React.useState<(typeof appKinds)[number]["id"]>(
    appKinds[0].id
  )
  const [name, setName] = React.useState("")
  const [relayId, setRelayId] = React.useState(
    () => availableRelays.at(0)?.id ?? ""
  )
  const relayLabelId = React.useId()
  const create = useMutation({
    mutationFn: () => createApp({ data: { name: name.trim(), relayId } }),
    onSuccess: async (created) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.all })
      // Leaving the list closes the dialog with it.
      await navigate({
        params: { appId: created.id },
        to: "/app/$appId/info",
      })
    },
  })

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add app</DialogTitle>
          <DialogDescription>
            Hearth creates the app with its own network and data directory.
            Choose what it runs on the next page, then deploy it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <fieldset>
            <legend className="mb-2 text-xs font-medium">Type</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {appKinds.map((option) => (
                <button
                  key={option.id}
                  aria-pressed={kind === option.id}
                  className={`flex items-start gap-2.5 rounded-lg border px-3 py-3 text-left transition-colors ${
                    kind === option.id
                      ? "border-primary/60 bg-primary/10 text-foreground"
                      : "border-border/70 bg-background/30 text-muted-foreground hover:bg-accent/30"
                  }`}
                  type="button"
                  onClick={() => setKind(option.id)}
                >
                  <option.icon className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span>
                    <span className="type-card-title block">
                      {option.label}
                    </span>
                    <span className="type-meta mt-0.5 block">
                      {option.description}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
          <label className="block">
            <span className="mb-2 block text-xs font-medium">Name</span>
            <Input
              autoFocus
              maxLength={120}
              placeholder="Website"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && name.trim() && relayId) {
                  create.mutate()
                }
              }}
            />
          </label>
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
            Create app
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EmptyAppTable({
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
            <Plus /> Add App
          </Button>
        ) : null
      }
      description={
        <span className="block max-w-sm">
          {searchActive
            ? "Try an app name, ID, Relay, container, or image."
            : canCreate
              ? "Deploy a Docker image, a Dockerfile, or a Compose project."
              : "No apps have been assigned to your account yet."}
        </span>
      }
      icon={<Boxes className="size-6 text-muted-foreground/45" />}
      title={searchActive ? "No apps match your search" : "No apps"}
    />
  )
}

function appContainersLabel(app: App): string {
  if (app.containers.length === 0) return "Not deployed"
  const running = app.containers.filter((container) => container.running)
  return `${running.length} of ${app.containers.length} running`
}

function appRowKey(app: App): string {
  return `${app.relayId}:${app.id}`
}

function appFavorite(app: App): InstanceFavorite {
  return { id: app.id, kind: "app", relayId: app.relayId }
}
