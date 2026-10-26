import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import {
  primaryWebRoute,
  relayInstanceWebRouteInputsSchema,
  webRouteHosts,
  webRouteUrl,
} from "@workspace/contracts"
import type {
  RelayInstanceWebRoute,
  RelayInstanceWebRouteInput,
} from "@workspace/contracts"
import {
  CornerUpRight,
  Globe2,
  LoaderCircle,
  Pencil,
  Plus,
  Star,
  Trash2,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { dismissToast, showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import {
  DataTableActionGroup,
  DataTableEmptyState,
} from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { StatusIndicator } from "@/components/status-indicator"
import {
  WebRouteDialog,
  type WebRouteServiceOption,
} from "@/components/web-route-dialog"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import type { DataTableSource } from "@/lib/data-table-source"
import { forkPromise } from "@/effect/promise"

// A route as this section edits it: an app's names the service it reaches.
export type WebRouteRow = RelayInstanceWebRouteInput & {
  readonly service?: string
}

type DisplayedRoute = WebRouteRow & { readonly rowId: string }

export type { WebRouteServiceOption }

// Domains Traefik serves for a game server or an app, in one table. Each
// change saves the whole list, and the table shows it while it saves.
export function WebRoutesSection({
  canWrite,
  error,
  kind,
  routes,
  services,
  status,
  statusAction,
  onSave,
}: {
  canWrite: boolean
  error: Error | null
  kind: "app" | "server"
  routes:
    | ReadonlyArray<RelayInstanceWebRoute & { readonly service?: string }>
    | undefined
  // An app's services, which routes choose between; none for a game server.
  services?: ReadonlyArray<WebRouteServiceOption>
  status: IdentityStatusPresentation | null
  // Applies saved routes, such as by deploying or restarting.
  statusAction?: React.ReactNode
  onSave: (routes: Array<WebRouteRow>) => Promise<unknown>
}) {
  const [editing, setEditing] = React.useState<
    { mode: "add" } | { mode: "edit"; route: DisplayedRoute } | null
  >(null)
  const save = useMutation({
    mutationFn: async (routes: Array<WebRouteRow>) => {
      const next = withPrimary(routes)
      // The checks every route list gets; an app's also names services.
      const parsed = relayInstanceWebRouteInputsSchema.safeParse(
        next.map(({ service: _service, ...route }) => route)
      )
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message ?? "Routes are invalid")
      }
      await onSave(next)
    },
  })
  const saved = React.useMemo(
    (): Array<WebRouteRow> | undefined => routes?.slice(),
    [routes]
  )
  // While a change saves, the table shows it.
  const displayed = React.useMemo(
    () =>
      (save.isPending ? save.variables : saved)?.map(
        (route, index): DisplayedRoute => ({
          ...route,
          rowId: route.id ?? `new-${index}-${route.hostname}`,
        })
      ),
    [save.isPending, save.variables, saved]
  )
  const primary = displayed ? primaryWebRoute(displayed) : undefined
  // A game server is reached at its own address; only an app's header and
  // list show a domain.
  const showPrimary = kind === "app"

  // Saves in the background; a failure puts the table back and says why.
  const commit = React.useCallback(
    (next: Array<WebRouteRow>, failure: string, onSaved?: () => void) =>
      forkPromise(
        async () => {
          await save.mutateAsync(next)
          onSaved?.()
        },
        (cause) =>
          showToast({
            description: errorMessage(cause),
            message: failure,
            type: "error",
          })
      ),
    [save]
  )
  const makePrimary = React.useCallback(
    (route: DisplayedRoute) => {
      if (!saved || save.isPending) return
      commit(
        saved.map((candidate) => ({
          ...candidate,
          primary: candidate.id === route.id,
        })),
        "Could not change the primary domain"
      )
    },
    [commit, save.isPending, saved]
  )
  // Undo acts on the routes as they are when it's clicked, not as they were
  // when the toast appeared. Leaving the page takes its Undo away, since
  // the routes can change elsewhere after that.
  const latest = React.useRef({ pending: save.isPending, saved })
  React.useEffect(() => {
    latest.current = { pending: save.isPending, saved }
  }, [save.isPending, saved])
  const undoToasts = React.useRef(new Set<number | string>())
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    const toasts = undoToasts.current
    return () => {
      mounted.current = false
      for (const toast of toasts) dismissToast(toast)
      toasts.clear()
    }
  }, [])
  const remove = React.useCallback(
    (route: DisplayedRoute) => {
      if (!saved || save.isPending) return
      const index = saved.findIndex((candidate) => candidate.id === route.id)
      const { rowId: _rowId, ...removed } = route
      const remaining = saved.filter((candidate) => candidate.id !== route.id)
      const wasPrimary = primaryWebRoute(saved)?.id === route.id
      // The route that became primary in its place, if it was primary.
      const promoted = wasPrimary ? primaryWebRoute(remaining)?.id : undefined
      const restore = () => {
        const current = latest.current
        if (!current.saved || current.pending) {
          showToast({
            message: "Undo once the current change has saved",
            type: "warning",
          })
          return
        }
        if (current.saved.some((candidate) => candidate.id === route.id)) {
          return
        }
        // It's primary again only if no other route was chosen since.
        const primary =
          wasPrimary && primaryWebRoute(current.saved)?.id === promoted
        const next = current.saved.map((candidate) =>
          primary ? { ...candidate, primary: false } : candidate
        )
        next.splice(Math.min(index, next.length), 0, { ...removed, primary })
        commit(next, "Could not restore the route")
      }
      commit(remaining, "Could not remove the route", () => {
        const message = `Removed ${route.hostname}${route.path ?? ""}`
        if (!mounted.current) {
          showToast({ message, type: "success" })
          return
        }
        const toast = showToast({
          action: {
            label: "Undo",
            onClick: () => {
              undoToasts.current.delete(toast)
              restore()
            },
          },
          // Long enough to notice a mistaken removal.
          duration: 10_000,
          message,
          onAutoClose: () => undoToasts.current.delete(toast),
          onDismiss: () => undoToasts.current.delete(toast),
          type: "success",
        })
        undoToasts.current.add(toast)
      })
    },
    [commit, save.isPending, saved]
  )
  const edit = React.useCallback((route: DisplayedRoute) => {
    setEditing({ mode: "edit", route })
  }, [])

  const busy = !canWrite || !saved || save.isPending

  return (
    <section className="overflow-hidden border border-border/80 bg-card/55">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border/70 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Globe2 className="size-4 shrink-0 text-primary-ink" />
          <h2 className="truncate text-sm font-semibold">Web routes</h2>
          {status && displayed?.length ? (
            <StatusIndicator status={status} />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {statusAction}
          {canWrite ? (
            <Button
              disabled={busy || saved.length >= 16}
              size="sm"
              type="button"
              onClick={() => setEditing({ mode: "add" })}
            >
              <Plus />
              Add route
            </Button>
          ) : null}
        </div>
      </div>
      <WebRoutesTable
        canWrite={canWrite}
        disabled={busy}
        error={error}
        pending={save.isPending}
        primaryRowId={primary?.rowId}
        routes={displayed}
        services={services}
        showPrimary={showPrimary}
        onAdd={canWrite ? () => setEditing({ mode: "add" }) : undefined}
        onEdit={edit}
        onMakePrimary={makePrimary}
        onRemove={remove}
      />
      {editing && saved ? (
        <WebRouteDialog
          route={editing.mode === "edit" ? editing.route : undefined}
          services={services}
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          onSubmit={async (route) => {
            const next =
              editing.mode === "edit"
                ? saved.map((candidate) =>
                    candidate.id === editing.route.id
                      ? {
                          ...route,
                          id: candidate.id,
                          primary: candidate.primary,
                        }
                      : candidate
                  )
                : [
                    ...saved,
                    // The first route a server or app gets is its primary.
                    { ...route, primary: !primaryWebRoute(saved) },
                  ]
            await save.mutateAsync(next)
            setEditing(null)
          }}
        />
      ) : null}
    </section>
  )
}

// Exactly one route that serves is primary: the one marked, else the first.
function withPrimary(routes: Array<WebRouteRow>): Array<WebRouteRow> {
  const primary = primaryWebRoute(routes)
  return routes.map((route) => ({ ...route, primary: route === primary }))
}

const columnHelper = createDataTableColumnHelper<DisplayedRoute>()

const WebRoutesTable = React.memo(function WebRoutesTable({
  canWrite,
  disabled,
  error,
  pending,
  primaryRowId,
  routes,
  services,
  showPrimary,
  onAdd,
  onEdit,
  onMakePrimary,
  onRemove,
}: {
  canWrite: boolean
  disabled: boolean
  error: Error | null
  pending: boolean
  primaryRowId: string | undefined
  routes: ReadonlyArray<DisplayedRoute> | undefined
  services: ReadonlyArray<WebRouteServiceOption> | undefined
  showPrimary: boolean
  onAdd?: () => void
  onEdit: (route: DisplayedRoute) => void
  onMakePrimary: (route: DisplayedRoute) => void
  onRemove: (route: DisplayedRoute) => void
}) {
  const source = React.useMemo(
    (): DataTableSource<DisplayedRoute> => ({
      body: routes
        ? { kind: "ready" }
        : error
          ? { kind: "error", error }
          : { kind: "loading", rowCount: 2 },
      refreshing: false,
      rows: routes ? [...routes] : [],
    }),
    [error, routes]
  )
  const definition = React.useMemo(
    () =>
      defineDataTable({
        ariaLabel: "Web routes",
        columns: columnHelper.columns([
          columnHelper.display({
            id: "kind",
            header: () => <span className="sr-only">Primary</span>,
            enableSorting: false,
            cell: ({ row }) => (
              <RouteKindCell
                disabled={disabled || !canWrite}
                primary={row.original.rowId === primaryRowId}
                route={row.original}
                showPrimary={showPrimary}
                onMakePrimary={onMakePrimary}
              />
            ),
            meta: dataTableColumnMeta(
              { width: "3rem" },
              {
                cellClassName: "justify-center px-1",
                headerClassName: "px-1",
              }
            ),
          }),
          columnHelper.display({
            id: "domain",
            header: "Domain",
            enableSorting: false,
            cell: ({ row }) => (
              <RouteDomainCell route={row.original} services={services} />
            ),
            meta: dataTableColumnMeta(
              { width: { base: "minmax(0,1fr)", sm: "minmax(0,1.3fr)" } },
              { cellClassName: "pl-1", headerClassName: "pl-1" }
            ),
          }),
          columnHelper.display({
            id: "destination",
            header: "Destination",
            enableSorting: false,
            cell: ({ row }) => (
              <RouteDestinationCell route={row.original} services={services} />
            ),
            meta: dataTableColumnMeta({
              hideBelow: "sm",
              width: "minmax(0,1fr)",
            }),
          }),
          columnHelper.display({
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }) => (
              <RouteActions
                canWrite={canWrite}
                disabled={disabled}
                pending={pending && row.original.id === undefined}
                route={row.original}
                onEdit={onEdit}
                onRemove={onRemove}
              />
            ),
            meta: dataTableColumnMeta(
              { width: "5.5rem" },
              { cellClassName: "px-2", headerClassName: "px-2" }
            ),
          }),
        ]),
        getRowId: (route) => route.rowId,
      }),
    [
      canWrite,
      disabled,
      onEdit,
      onMakePrimary,
      onRemove,
      pending,
      primaryRowId,
      services,
      showPrimary,
    ]
  )

  return (
    <DataTable
      definition={definition}
      emptyState={
        <DataTableEmptyState
          action={
            onAdd ? (
              <Button size="sm" type="button" onClick={onAdd}>
                <Plus />
                Add route
              </Button>
            ) : undefined
          }
          description={
            <span className="block max-w-sm">
              Serve a domain over HTTPS, or redirect one somewhere else.
            </span>
          }
          icon={
            <Globe2 className="size-6 text-muted-foreground/45 light:text-muted-foreground/72" />
          }
          title="No web routes"
        />
      }
      source={source}
    />
  )
})

const RouteKindCell = React.memo(function RouteKindCell({
  disabled,
  primary,
  route,
  showPrimary,
  onMakePrimary,
}: {
  disabled: boolean
  primary: boolean
  route: DisplayedRoute
  showPrimary: boolean
  onMakePrimary: (route: DisplayedRoute) => void
}) {
  if (route.redirect) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="grid size-7 place-items-center text-muted-foreground">
            <CornerUpRight className="size-4" aria-label="Redirect" />
          </span>
        </TooltipTrigger>
        <TooltipContent>Redirects to another URL</TooltipContent>
      </Tooltip>
    )
  }
  if (!showPrimary) {
    return (
      <span className="grid size-7 place-items-center text-muted-foreground">
        <Globe2 className="size-4" aria-hidden="true" />
      </span>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={
            primary
              ? `${route.hostname} is the primary domain`
              : `Make ${route.hostname} the primary domain`
          }
          aria-pressed={primary}
          className={cn(
            primary
              ? "text-primary-ink hover:text-primary-ink"
              : "text-muted-foreground/70 hover:text-primary-ink"
          )}
          disabled={disabled && !primary}
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={() => {
            if (!primary) onMakePrimary(route)
          }}
        >
          <Star className={cn(primary && "fill-current")} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {primary ? "Primary domain" : "Make primary"}
      </TooltipContent>
    </Tooltip>
  )
})

const RouteDomainCell = React.memo(function RouteDomainCell({
  route,
  services,
}: {
  route: DisplayedRoute
  services: ReadonlyArray<WebRouteServiceOption> | undefined
}) {
  const { aliases, served } = webRouteHosts(route)
  const details = [
    route.name,
    // A redirect sends its counterpart along with it.
    aliases[0]
      ? route.redirect
        ? `also ${aliases[0]}`
        : `${aliases[0]} redirects here`
      : null,
    served[1] ? `also ${served[1]}` : null,
    !route.redirect && !route.httpsRedirect ? "serves HTTP" : null,
  ].filter(Boolean)
  return (
    <div className="min-w-0">
      <a
        className="block truncate text-sm font-medium transition-colors hover:text-primary-ink"
        href={webRouteUrl(route)}
        rel="noreferrer"
        target="_blank"
        title={webRouteUrl(route)}
      >
        {route.hostname}
        {route.path ?? ""}
      </a>
      <span className="type-meta block truncate text-muted-foreground">
        {/* Phones hide the destination column; it leads the details. */}
        <span className="sm:hidden">
          {routeDestination(route, services)}
          {details.length ? " · " : ""}
        </span>
        {details.join(" · ")}
      </span>
    </div>
  )
})

const RouteDestinationCell = React.memo(function RouteDestinationCell({
  route,
  services,
}: {
  route: DisplayedRoute
  services: ReadonlyArray<WebRouteServiceOption> | undefined
}) {
  const detail = route.redirect
    ? `${route.redirect.permanent ? "301 permanent" : "302 temporary"} · ${
        route.redirect.preservePath ? "keeps path" : "drops path"
      }`
    : route.path && route.stripPrefix
      ? `strips ${route.path}`
      : null
  return (
    <div className="min-w-0">
      <span className="type-code block truncate text-foreground">
        {routeDestination(route, services)}
      </span>
      {detail ? (
        <span className="type-meta block truncate text-muted-foreground">
          {detail}
        </span>
      ) : null}
    </div>
  )
})

function routeDestination(
  route: WebRouteRow,
  services: ReadonlyArray<WebRouteServiceOption> | undefined
): string {
  if (route.redirect) return `→ ${route.redirect.to.replace(/\/$/u, "")}`
  return services
    ? `${route.service ?? "app"}:${route.targetPort ?? ""}`
    : `Port ${route.targetPort ?? ""}`
}

const RouteActions = React.memo(function RouteActions({
  canWrite,
  disabled,
  pending,
  route,
  onEdit,
  onRemove,
}: {
  canWrite: boolean
  disabled: boolean
  pending: boolean
  route: DisplayedRoute
  onEdit: (route: DisplayedRoute) => void
  onRemove: (route: DisplayedRoute) => void
}) {
  if (!canWrite) return null
  if (pending) {
    return (
      <DataTableActionGroup>
        <span
          aria-label="Saving route"
          className="grid size-7 place-items-center text-muted-foreground"
          role="status"
        >
          <LoaderCircle className="size-4 animate-spin" />
        </span>
      </DataTableActionGroup>
    )
  }
  const address = `${route.hostname}${route.path ?? ""}`
  return (
    <DataTableActionGroup>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={`Edit ${address}`}
            disabled={disabled}
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={() => onEdit(route)}
          >
            <Pencil />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Edit</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={`Remove ${address}`}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive light:hover:bg-destructive/20"
            disabled={disabled}
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={() => onRemove(route)}
          >
            <Trash2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Remove</TooltipContent>
      </Tooltip>
    </DataTableActionGroup>
  )
})

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The change failed."
}
