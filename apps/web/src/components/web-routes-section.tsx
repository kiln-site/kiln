import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  primaryWebRoute,
  relayInstanceWebRouteInputsSchema,
  webRouteHostnames,
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
  Trash2,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { dismissToast, showToast } from "@workspace/ui/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import {
  DataTableActionGroup,
  DataTableEmptyState,
} from "@/components/data-table"
import { DataTable } from "@/components/data-table-view"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { PrimaryStar } from "@/components/primary-star"
import { StatusIndicator } from "@/components/status-indicator"
import {
  WebRouteDialog,
  type WebRouteServiceOption,
} from "@/components/web-route-dialog"
import { WebCertificateStatus } from "@/components/web-certificate-status"
import {
  AdoptRecordButton,
  useAdoptableWebHostnames,
  useHeldWebHostnames,
  useWebHostnameProxied,
  WebHostnameDnsStatus,
  type WebHostnameResourceRef,
} from "@/components/web-hostname-dns"
import { queryKeys } from "@/lib/query-options"
import {
  createDataTableColumnHelper,
  dataTableColumnMeta,
  defineDataTable,
} from "@/lib/data-table"
import type { DataTableSource } from "@/lib/data-table-source"
import { forkPromise } from "@/effect/promise"
import type { ResourceWebHostname } from "@/server/domains"

const AdoptRecordDialog = React.lazy(async () => ({
  default: (await import("@/components/domains-dialogs")).AdoptRecordDialog,
}))
const ReleaseHostnameDialog = React.lazy(async () => ({
  default: (await import("@/components/domains-dialogs")).ReleaseHostnameDialog,
}))

// A route as this section edits it: an app's names the service it reaches.
export type WebRouteRow = RelayInstanceWebRouteInput & {
  readonly service?: string
}

type DisplayedRoute = WebRouteRow & { readonly rowId: string }

// A row of the table: a route, or a name held that no route serves yet.
type DomainRow =
  | { held?: undefined; route: DisplayedRoute; rowId: string }
  | { held: ResourceWebHostname; route?: undefined; rowId: string }

/** Whether a route's hostnames go through Cloudflare's proxy, as changed. */
export interface WebRouteProxyChange {
  hostnames: Array<string>
  proxied: boolean
}

export type { WebRouteServiceOption }

/** A port a name nothing serves yet might be pointed at. */
export interface WebRouteTarget {
  port: number
  service: string
}

// An instance's domains, in one table: each name it holds and where Traefik
// sends it. A name no route serves yet, such as a new App's own address, is
// a row too. Each change saves the whole list of routes, and the table shows
// it while it saves.
export function WebRoutesSection({
  canWrite,
  dnsResource,
  error,
  kind,
  routes,
  services,
  status,
  statusAction,
  targets = noTargets,
  onSave,
}: {
  canWrite: boolean
  // Whose DNS records the domains' badges read.
  dnsResource: WebHostnameResourceRef
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
  // The ports an App's running services listen on that could be a
  // website's: one click points a name nothing serves at one.
  targets?: ReadonlyArray<WebRouteTarget>
  // `proxy` when a route's dialog changed whether its hostnames go through
  // Cloudflare's proxy.
  onSave: (
    routes: Array<WebRouteRow>,
    proxy?: WebRouteProxyChange
  ) => Promise<unknown>
}) {
  const [editing, setEditing] = React.useState<
    | { hostname?: string; mode: "add" }
    | { mode: "edit"; route: DisplayedRoute }
    | null
  >(null)
  const [adopting, setAdopting] = React.useState<ResourceWebHostname | null>(
    null
  )
  const [releasing, setReleasing] = React.useState<ResourceWebHostname | null>(
    null
  )
  const held = useHeldWebHostnames(dnsResource)
  const queryClient = useQueryClient()
  const proxiedFor = useWebHostnameProxied(dnsResource)
  const adoptable = useAdoptableWebHostnames(dnsResource)
  const save = useMutation({
    mutationFn: async ({
      proxy,
      routes,
    }: {
      proxy?: WebRouteProxyChange
      routes: Array<WebRouteRow>
    }) => {
      const next = withPrimary(routes)
      // The checks every route list gets; an app's also names services.
      const parsed = relayInstanceWebRouteInputsSchema.safeParse(
        next.map(({ service: _service, ...route }) => route)
      )
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message ?? "Routes are invalid")
      }
      await onSave(next, proxy)
    },
    // Which names its routes serve decides what each can do: one that
    // nothing serves any more can be deleted.
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.domains.hostnames(
          dnsResource.relayId,
          dnsResource.resourceType,
          dnsResource.resourceId
        ),
      }),
  })
  const saved = React.useMemo(
    (): Array<WebRouteRow> | undefined => routes?.slice(),
    [routes]
  )
  // While a change saves, the table shows it.
  const displayed = React.useMemo(
    () =>
      (save.isPending ? save.variables?.routes : saved)?.map(
        (route, index): DisplayedRoute => ({
          ...route,
          rowId: route.id ?? `new-${index}-${route.hostname}`,
        })
      ),
    [save.isPending, save.variables, saved]
  )
  const primary = displayed ? primaryWebRoute(displayed) : undefined
  // The routes, then each name held that none of them serves.
  const rows = React.useMemo((): Array<DomainRow> | undefined => {
    if (!displayed || !held) return undefined
    const served = new Set(displayed.flatMap(webRouteHostnames))
    return [
      ...displayed.map((route) => ({ route, rowId: route.rowId })),
      ...held
        .filter((name) => !served.has(name.hostname))
        .map((name) => ({ held: name, rowId: `held-${name.id}` })),
    ]
  }, [displayed, held])
  // A game server is reached at its own address; only an app's header and
  // list show a domain.
  const showPrimary = kind === "app"

  // Saves in the background; a failure puts the table back and says why.
  const commit = React.useCallback(
    (next: Array<WebRouteRow>, failure: string, onSaved?: () => void) =>
      forkPromise(
        async () => {
          await save.mutateAsync({ routes: next })
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
  const latest = React.useRef({ held, pending: save.isPending, saved })
  React.useEffect(() => {
    latest.current = { held, pending: save.isPending, saved }
  }, [held, save.isPending, saved])
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
        commit(next, "Could not restore the domain")
      }
      // A name the instance holds anyway stays in the table, served by
      // nothing.
      const stays =
        latest.current.held?.some((name) => name.hostname === route.hostname) &&
        !remaining.some((other) =>
          webRouteHostnames(other).includes(route.hostname)
        )
      commit(remaining, "Could not remove the domain", () => {
        const message = stays
          ? `Stopped serving ${route.hostname}`
          : `Removed ${route.hostname}${route.path ?? ""}`
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
  const serve = React.useCallback(
    (hostname: string, target: WebRouteTarget) => {
      if (!saved || save.isPending) return
      commit(
        [
          ...saved,
          {
            hostname,
            httpsRedirect: true,
            name: "",
            path: null,
            primary: !primaryWebRoute(saved),
            redirect: null,
            service: target.service,
            stripPrefix: true,
            targetPort: target.port,
            www: "none",
          },
        ],
        "Could not point the domain"
      )
    },
    [commit, save.isPending, saved]
  )
  const point = React.useCallback((hostname: string) => {
    setEditing({ hostname, mode: "add" })
  }, [])

  const busy = !canWrite || !saved || save.isPending

  return (
    <section className="overflow-hidden border border-border/80 bg-card/55">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border/70 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Globe2 className="size-4 shrink-0 text-primary-ink" />
          <h2 className="truncate text-sm font-semibold">Domains</h2>
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
              Add domain
            </Button>
          ) : null}
        </div>
      </div>
      <WebRoutesTable
        adoptable={adoptable}
        canWrite={canWrite}
        disabled={busy}
        dnsResource={dnsResource}
        error={error}
        pending={save.isPending}
        primaryRowId={primary?.rowId}
        rows={rows}
        services={services}
        showPrimary={showPrimary}
        targets={targets}
        onAdd={canWrite ? () => setEditing({ mode: "add" }) : undefined}
        onAdopt={setAdopting}
        onEdit={edit}
        onMakePrimary={makePrimary}
        onPoint={point}
        onRelease={setReleasing}
        onRemove={remove}
        onServe={serve}
      />
      {editing && saved ? (
        <WebRouteDialog
          hostname={editing.mode === "add" ? editing.hostname : undefined}
          proxiedFor={proxiedFor}
          route={editing.mode === "edit" ? editing.route : undefined}
          services={services}
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          onSubmit={async (route, proxied) => {
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
                    // The first domain a server or app gets is its primary.
                    { ...route, primary: !primaryWebRoute(saved) },
                  ]
            await save.mutateAsync({
              proxy:
                proxied === undefined
                  ? undefined
                  : { hostnames: webRouteHostnames(route), proxied },
              routes: next,
            })
            setEditing(null)
          }}
        />
      ) : null}
      {adopting ? (
        <React.Suspense fallback={null}>
          <AdoptRecordDialog
            key={adopting.id}
            hostname={adopting}
            resource={dnsResource}
            onOpenChange={(open) => {
              if (!open) setAdopting(null)
            }}
          />
        </React.Suspense>
      ) : null}
      {releasing ? (
        <React.Suspense fallback={null}>
          <ReleaseHostnameDialog
            key={releasing.id}
            hostname={releasing}
            onOpenChange={(open) => {
              if (!open) setReleasing(null)
            }}
          />
        </React.Suspense>
      ) : null}
    </section>
  )
}

// Exactly one route that serves is primary: the one marked, else the first.
function withPrimary(routes: Array<WebRouteRow>): Array<WebRouteRow> {
  const primary = primaryWebRoute(routes)
  return routes.map((route) => ({ ...route, primary: route === primary }))
}

const noTargets: ReadonlyArray<WebRouteTarget> = []

const columnHelper = createDataTableColumnHelper<DomainRow>()

const WebRoutesTable = React.memo(function WebRoutesTable({
  adoptable,
  canWrite,
  disabled,
  dnsResource,
  error,
  pending,
  primaryRowId,
  rows,
  services,
  showPrimary,
  targets,
  onAdd,
  onAdopt,
  onEdit,
  onMakePrimary,
  onPoint,
  onRelease,
  onRemove,
  onServe,
}: {
  adoptable: ReadonlyArray<ResourceWebHostname>
  canWrite: boolean
  disabled: boolean
  dnsResource: WebHostnameResourceRef
  error: Error | null
  pending: boolean
  primaryRowId: string | undefined
  rows: ReadonlyArray<DomainRow> | undefined
  services: ReadonlyArray<WebRouteServiceOption> | undefined
  showPrimary: boolean
  targets: ReadonlyArray<WebRouteTarget>
  onAdd?: () => void
  onAdopt: (hostname: ResourceWebHostname) => void
  onEdit: (route: DisplayedRoute) => void
  onMakePrimary: (route: DisplayedRoute) => void
  onPoint: (hostname: string) => void
  onRelease: (hostname: ResourceWebHostname) => void
  onRemove: (route: DisplayedRoute) => void
  onServe: (hostname: string, target: WebRouteTarget) => void
}) {
  const source = React.useMemo(
    (): DataTableSource<DomainRow> => ({
      body: rows
        ? { kind: "ready" }
        : error
          ? { kind: "error", error }
          : { kind: "loading", rowCount: 2 },
      refreshing: false,
      rows: rows ? [...rows] : [],
    }),
    [error, rows]
  )
  const definition = React.useMemo(
    () =>
      defineDataTable({
        ariaLabel: "Domains",
        columns: columnHelper.columns([
          columnHelper.display({
            id: "kind",
            header: () => <span className="sr-only">Primary</span>,
            enableSorting: false,
            cell: ({ row }) =>
              row.original.route ? (
                <RouteKindCell
                  disabled={disabled || !canWrite}
                  primary={row.original.rowId === primaryRowId}
                  route={row.original.route}
                  showPrimary={showPrimary}
                  onMakePrimary={onMakePrimary}
                />
              ) : (
                <PlainKindIcon />
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
            cell: ({ row }) =>
              row.original.route ? (
                <RouteDomainCell
                  dnsResource={dnsResource}
                  route={row.original.route}
                  services={services}
                />
              ) : (
                <HeldDomainCell
                  dnsResource={dnsResource}
                  hostname={row.original.held.hostname}
                />
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
            cell: ({ row }) =>
              row.original.route ? (
                <RouteDestinationCell
                  route={row.original.route}
                  services={services}
                />
              ) : (
                <HeldDestinationCell
                  disabled={disabled}
                  hostname={row.original.held.hostname}
                  targets={canWrite ? targets : noTargets}
                  onServe={onServe}
                />
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
            cell: ({ row }) =>
              row.original.route ? (
                <RouteActions
                  adoptable={adoptable.find(
                    (hostname) =>
                      hostname.hostname === row.original.route?.hostname
                  )}
                  canWrite={canWrite}
                  disabled={disabled}
                  pending={pending && row.original.route.id === undefined}
                  route={row.original.route}
                  onAdopt={onAdopt}
                  onEdit={onEdit}
                  onRemove={onRemove}
                />
              ) : (
                <HeldActions
                  canWrite={canWrite}
                  disabled={disabled}
                  held={row.original.held}
                  onPoint={onPoint}
                  onRelease={onRelease}
                />
              ),
            meta: dataTableColumnMeta(
              {
                width:
                  adoptable.length > 0
                    ? { base: "5.5rem", sm: "11.5rem" }
                    : "5.5rem",
              },
              { cellClassName: "px-2", headerClassName: "px-2" }
            ),
          }),
        ]),
        getRowId: (row) => row.rowId,
      }),
    [
      adoptable,
      canWrite,
      disabled,
      dnsResource,
      onAdopt,
      onEdit,
      onMakePrimary,
      onPoint,
      onRelease,
      onRemove,
      onServe,
      pending,
      primaryRowId,
      services,
      showPrimary,
      targets,
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
                Add domain
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
          title="No domains"
        />
      }
      source={source}
    />
  )
})

function PlainKindIcon() {
  return (
    <span className="grid size-7 place-items-center text-muted-foreground">
      <Globe2 className="size-4" aria-hidden="true" />
    </span>
  )
}

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
  if (!showPrimary) return <PlainKindIcon />
  return (
    <PrimaryStar
      disabled={disabled}
      name={route.hostname}
      noun="domain"
      primary={primary}
      onMakePrimary={() => onMakePrimary(route)}
    />
  )
})

// A name the instance holds that no route serves.
const HeldDomainCell = React.memo(function HeldDomainCell({
  dnsResource,
  hostname,
}: {
  dnsResource: WebHostnameResourceRef
  hostname: string
}) {
  return (
    <div className="min-w-0">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">{hostname}</span>
        <WebHostnameDnsStatus hostname={hostname} resource={dnsResource} />
      </span>
      <span className="type-meta block truncate text-muted-foreground sm:hidden">
        Not pointed anywhere
      </span>
    </div>
  )
})

const HeldDestinationCell = React.memo(function HeldDestinationCell({
  disabled,
  hostname,
  targets,
  onServe,
}: {
  disabled: boolean
  hostname: string
  targets: ReadonlyArray<WebRouteTarget>
  onServe: (hostname: string, target: WebRouteTarget) => void
}) {
  if (targets.length === 0) {
    return (
      <span className="type-meta truncate text-muted-foreground">
        Not pointed anywhere
      </span>
    )
  }
  return (
    <span className="type-meta flex min-w-0 items-center gap-1.5 overflow-hidden text-muted-foreground">
      <span className="shrink-0">Point at</span>
      {targets.map((target) => (
        <Button
          key={`${target.service}:${target.port}`}
          className="h-6 shrink-0 px-2 font-mono text-xs"
          disabled={disabled}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => onServe(hostname, target)}
        >
          {target.service}:{target.port}
        </Button>
      ))}
    </span>
  )
})

const HeldActions = React.memo(function HeldActions({
  canWrite,
  disabled,
  held,
  onPoint,
  onRelease,
}: {
  canWrite: boolean
  disabled: boolean
  held: ResourceWebHostname
  onPoint: (hostname: string) => void
  onRelease: (hostname: ResourceWebHostname) => void
}) {
  if (!canWrite) return null
  return (
    <DataTableActionGroup>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={`Choose where ${held.hostname} goes`}
            disabled={disabled}
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={() => onPoint(held.hostname)}
          >
            <Pencil />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Choose where it goes</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={`Delete ${held.hostname}`}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive light:hover:bg-destructive/20"
            disabled={disabled || !held.canRelease}
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={() => onRelease(held)}
          >
            <Trash2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Delete</TooltipContent>
      </Tooltip>
    </DataTableActionGroup>
  )
})

const RouteDomainCell = React.memo(function RouteDomainCell({
  dnsResource,
  route,
  services,
}: {
  dnsResource: WebHostnameResourceRef
  route: DisplayedRoute
  services: ReadonlyArray<WebRouteServiceOption> | undefined
}) {
  const { aliases, served } = webRouteHosts(route)
  // Kept while the route's names stay the same.
  const hostnameKey = [...served, ...aliases].join(" ")
  const hostnames = React.useMemo(() => hostnameKey.split(" "), [hostnameKey])
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
      <span className="flex min-w-0 items-center gap-2">
        <a
          className="truncate text-sm font-medium transition-colors hover:text-primary-ink"
          href={webRouteUrl(route)}
          rel="noreferrer"
          target="_blank"
          title={webRouteUrl(route)}
        >
          {route.hostname}
          {route.path ?? ""}
        </a>
        <WebHostnameDnsStatus
          hostname={route.hostname}
          resource={dnsResource}
        />
        <WebCertificateStatus hostnames={hostnames} resource={dnsResource} />
      </span>
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
  adoptable,
  canWrite,
  disabled,
  pending,
  route,
  onAdopt,
  onEdit,
  onRemove,
}: {
  // Its hostname's existing record, when this person can hand it to Kiln.
  adoptable: ResourceWebHostname | undefined
  canWrite: boolean
  disabled: boolean
  pending: boolean
  route: DisplayedRoute
  onAdopt: (hostname: ResourceWebHostname) => void
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
  if (adoptable) {
    return (
      <DataTableActionGroup>
        <AdoptRecordButton
          disabled={disabled}
          hostname={adoptable.hostname}
          onClick={() => onAdopt(adoptable)}
        />
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
