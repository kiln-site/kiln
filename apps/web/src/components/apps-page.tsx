import type { AppTableInventory, InstanceInventory } from "@workspace/contracts"
import type { getAppDirectory } from "@/server/apps"
import * as React from "react"
import { useLiveSuspenseQuery } from "@tanstack/react-db"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  Boxes,
  Container,
  EllipsisVertical,
  LoaderCircle,
  Play,
  Plus,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  showAppOperationError,
  type App,
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
import { InstanceCard, InstanceStatus } from "@/components/instance-card"
import { statusColumnWidth } from "@/components/instance-name-presentation"
import { instanceInventoryScope } from "@/lib/instance-inventory"
import { infraAppsCollectionOptions } from "@/lib/collections/infra-directories"
import { InfraSyncButton } from "@/components/infra-sync-button"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import {
  replaceDataTableUrlSearch,
  type DataTableSearchStore,
} from "@/lib/data-table-search"
import {
  loadingInfraTableSource,
  useInfraTableSource,
  type InfraInstanceRow,
} from "@/lib/infra-table-source"
import {
  infraRelayOptionsQueryOptions,
  refreshInfraTable,
} from "@/lib/infra-directory"
import type { DataTableSource } from "@/lib/data-table-source"
import type { InstanceFavorite } from "@/lib/instance-favorites"
import { queryKeys } from "@/lib/query-options"
import { createApp, deployApp, runAppAction } from "@/server/apps"
import type { getInfraRelayOptions } from "@/server/infra-directory"

type AppRelay = Awaited<
  ReturnType<typeof getInfraRelayOptions>
>["relays"][number]

type AppDirectory = Awaited<ReturnType<typeof getAppDirectory>>[number]
type AppDirectoryRow = InfraInstanceRow<AppDirectory, AppTableInventory>
type AppDeleteTarget = Pick<App, "id" | "name" | "relayId">
const appTableInventory = (inventory: InstanceInventory) =>
  inventory.kind === "app" && inventory.view === "table"
    ? (inventory.data ?? undefined)
    : undefined
const appReference = (row: AppDirectory) => ({
  kind: "app" as const,
  id: row.id,
  relayId: row.relayId,
})

const appTableColumnHelper = createDataTableColumnHelper<AppDirectoryRow>()
const appTableSearchFields = [
  (row: AppDirectoryRow) => row.name,
  (row: AppDirectoryRow) => row.id,
  (row: AppDirectoryRow) => row.shortId,
  (row: AppDirectoryRow) => row.relayId,
  (row: AppDirectoryRow) => row.relayName,
  (row: AppDirectoryRow) => row.instanceStatus,
  (row: AppDirectoryRow) => row.detail?.containerSearchText,
] as const

export const AppsPage = React.memo(function AppsPage({
  searchStore,
}: {
  searchStore: DataTableSearchStore
}) {
  const { data } = useQuery(infraRelayOptionsQueryOptions("app"))
  const [createOpen, setCreateOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState<AppDeleteTarget | null>(null)
  const openCreate = React.useCallback(() => setCreateOpen(true), [])
  const canCreate = data?.relays.some((relay) => relay.canCreate)

  return (
    <div className="mx-auto flex h-full min-h-[34rem] w-full max-w-[90rem] flex-col px-3 pb-3 sm:px-5 sm:pb-5">
      <DataTableWorkspace
        toolbar={
          <AppToolbar
            canCreate={canCreate}
            searchStore={searchStore}
            onCreate={openCreate}
          />
        }
      >
        <React.Suspense
          fallback={
            <AppTable
              source={loadingInfraTableSource}
              canCreate={canCreate === true}
              searchStore={searchStore}
              onCreate={openCreate}
              onDelete={setDeleting}
            />
          }
        >
          <AppTableData
            canCreate={canCreate === true}
            searchStore={searchStore}
            onCreate={openCreate}
            onDelete={setDeleting}
          />
        </React.Suspense>
      </DataTableWorkspace>

      {createOpen && data ? (
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

const AppToolbar = React.memo(function AppToolbar({
  canCreate,
  onCreate,
  searchStore,
}: {
  canCreate: boolean | undefined
  onCreate: () => void
  searchStore: DataTableSearchStore
}) {
  return (
    <DataTableToolbar
      actions={
        canCreate !== false ? (
          <Button type="button" disabled={!canCreate} onClick={onCreate}>
            <Plus /> Add App
          </Button>
        ) : null
      }
      controls={<FavoritesOnlyButton table="apps" />}
      leading={<AppSyncButton />}
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

const AppSyncButton = React.memo(function AppSyncButton() {
  const queryClient = useQueryClient()
  const sync = React.useCallback(
    () => refreshInfraTable(queryClient, "app"),
    [queryClient]
  )
  return <InfraSyncButton label="Sync apps" sync={sync} />
})

interface AppTableProps {
  canCreate: boolean
  onCreate: () => void
  onDelete: (app: AppDeleteTarget) => void
  searchStore: DataTableSearchStore
}

const AppTableData = React.memo(function AppTableData(props: AppTableProps) {
  const { data } = useLiveSuspenseQuery({
    query: (query) => query.from({ app: infraAppsCollectionOptions }),
  })
  const source = useInfraTableSource({
    rows: data,
    reference: appReference,
    view: "table",
    selectDetail: appTableInventory,
  })
  return <AppTable {...props} source={source} />
})

const AppTable = React.memo(function AppTable({
  canCreate,
  onCreate,
  onDelete,
  searchStore,
  source,
}: AppTableProps & { source: DataTableSource<AppDirectoryRow> }) {
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
      appTableColumnHelper.accessor((app) => app.instanceStatus, {
        id: "status",
        header: () => <span className="sr-only sm:not-sr-only">Status</span>,
        sortFn: "text",
        cell: ({ row }) => (
          <InstanceStatus
            state={row.original.instanceState}
            instance={{
              kind: "app",
              id: row.original.id,
              relayId: row.original.relayId,
            }}
          />
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
              <InstanceCard
                state={app.instanceState}
                className="min-w-0 flex-1"
                instance={{ id: app.id, kind: "app", relayId: app.relayId }}
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
      appTableColumnHelper.accessor((app) => appRowContainersLabel(app), {
        id: "containers",
        header: "Containers",
        sortFn: "text",
        cell: ({ row }) => (
          <DataTableTextCell
            className={
              row.original.instanceState.phase === "checking"
                ? "reveal-delayed"
                : undefined
            }
            value={appRowContainersLabel(row.original)}
          />
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
          <AppActions
            app={row.original}
            state={row.original.instanceState}
            onDelete={onDelete}
          />
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
  state,
  onDelete,
}: {
  app: AppDirectoryRow
  state: import("@/lib/instance-state").InstanceState
  onDelete: (app: AppDeleteTarget) => void
}) {
  const queryClient = useQueryClient()
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: instanceInventoryScope({
        kind: "app",
        relayId: app.relayId,
        id: app.id,
      }),
    })
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
  const available =
    state.phase === "ready" &&
    state.observation.reachability === "connected" &&
    state.observation.inventory === "available"
  const canManage = app.permissions.includes("app.manage")
  const deploying = app.detail?.deploying === true
  const running =
    state.phase === "ready" && state.observation.runtime === "running"
  const busy = deploy.isPending || action.isPending

  return (
    <DataTableActionGroup>
      {canManage ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={`Deploy ${app.name}`}
              className="text-muted-foreground hover:text-primary"
              disabled={!available || !app.detail || busy || deploying}
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
          {canManage && available && (app.detail?.containerCount ?? 0) > 0 ? (
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
      // The app's page resolves it from the directory, so the directory has
      // it before the page opens.
      await queryClient.invalidateQueries({ queryKey: queryKeys.apps.all })
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

function appRowKey(app: { id: string; relayId: string }): string {
  return `${app.relayId}:${app.id}`
}

function appFavorite(app: { id: string; relayId: string }): InstanceFavorite {
  return { id: app.id, kind: "app", relayId: app.relayId }
}

function appRowContainersLabel(row: AppDirectoryRow): string {
  if (row.instanceState.phase === "checking") return "Checking"
  if (!row.detail) return "Unavailable"
  return row.detail.containerCount === 0
    ? "Not deployed"
    : `${row.detail.runningContainerCount} of ${row.detail.containerCount} running`
}
