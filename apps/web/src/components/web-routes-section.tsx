import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  primaryWebRoute,
  relayInstanceWebRouteInputsSchema,
  webRouteHostnames,
  webRouteHosts,
  webRouteService,
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
import { ensuringPromise, forkPromise } from "@/effect/promise"
import { TailscaleLogo } from "@/components/brand-logos"
import type { InstanceTunnelName } from "@/components/tunnel/tunnel-data"
import type { ResourceWebHostname } from "@/server/domains"

const AdoptRecordDialog = React.lazy(async () => ({
  default: (await import("@/components/domains-dialogs")).AdoptRecordDialog,
}))
const ReleaseHostnameDialog = React.lazy(async () => ({
  default: (await import("@/components/domains-dialogs")).ReleaseHostnameDialog,
}))
const DomainNameDialog = React.lazy(async () => ({
  default: (await import("@/components/domain-name-dialog")).DomainNameDialog,
}))

/** A route as this section edits it. */
export type WebRouteRow = RelayInstanceWebRouteInput

type DisplayedRoute = WebRouteRow & { readonly rowId: string }

// A row of the table: a route, a name held that no route serves yet, or a
// name in a tunnel the instance is connected to.
type DomainRow =
  | {
      held?: undefined
      route: DisplayedRoute
      rowId: string
      tunnel?: undefined
    }
  | {
      held: ResourceWebHostname
      route?: undefined
      rowId: string
      tunnel?: undefined
    }
  | {
      held?: undefined
      route?: undefined
      rowId: string
      tunnel: InstanceTunnelName
    }

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

/**
 * A database's names, which no route serves: each row is one, added,
 * renamed and deleted as one list, all going where `destination` says.
 */
export interface DomainNames {
  destination: string
  onSave: (hostnames: Array<string>) => Promise<unknown>
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
  names,
  primaryElsewhere = false,
  primaryRouteId,
  routes,
  services,
  status,
  statusAction,
  targets = noTargets,
  tunnelNames = noTunnelNames,
  onSave,
  onMakePrimary,
  onMakeTunnelPrimary,
}: {
  canWrite: boolean
  // Whose DNS records the domains' badges read.
  dnsResource: WebHostnameResourceRef
  error: Error | null
  kind: "app" | "database" | "server"
  // A database's names, in place of routes.
  names?: DomainNames
  // Its primary address is none of these routes (a tunnel name).
  primaryElsewhere?: boolean
  // The route its instance's primary address names, if one does.
  primaryRouteId?: string | null
  routes: ReadonlyArray<RelayInstanceWebRoute> | undefined
  // An app's services, which routes choose between; none for a game server.
  services?: ReadonlyArray<WebRouteServiceOption>
  status: IdentityStatusPresentation | null
  // Applies saved routes, such as by deploying or restarting.
  statusAction?: React.ReactNode
  // The ports an App's running services listen on that could be a
  // website's: one click points a name nothing serves at one.
  targets?: ReadonlyArray<WebRouteTarget>
  // Its names in the tunnels it's connected to, listed with its domains.
  tunnelNames?: ReadonlyArray<InstanceTunnelName>
  // Makes one of them its primary address; an App's only.
  onMakeTunnelPrimary?: (name: InstanceTunnelName) => void
  // `proxy` when a route's dialog changed whether its hostnames go through
  // Cloudflare's proxy.
  onSave: (
    routes: Array<WebRouteRow>,
    proxy?: WebRouteProxyChange
  ) => Promise<unknown>
  // Makes a route its App's primary address; a game server has none.
  onMakePrimary?: (routeId: string) => Promise<unknown>
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
  // A database's name being added (null) or renamed.
  const [naming, setNaming] = React.useState<{
    hostname: string | null
  } | null>(null)
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
      const parsed = relayInstanceWebRouteInputsSchema.safeParse(routes)
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message ?? "Routes are invalid")
      }
      await onSave(routes, proxy)
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
  // While a choice of primary saves, the table shows it.
  const [choosing, setChoosing] = React.useState<string | null>(null)
  const primary =
    displayed && (choosing !== null || !primaryElsewhere)
      ? primaryWebRoute(displayed, choosing ?? primaryRouteId)
      : undefined
  // The routes, then each name held that none of them serves, then its
  // names in tunnels.
  const rows = React.useMemo((): Array<DomainRow> | undefined => {
    if (!displayed || !held) return undefined
    const served = new Set(displayed.flatMap(webRouteHostnames))
    return [
      ...displayed.map((route) => ({ route, rowId: route.rowId })),
      ...held
        .filter((name) => !served.has(name.hostname))
        .map((name) => ({ held: name, rowId: `held-${name.id}` })),
      ...tunnelNames.map((tunnel) => ({
        rowId: `tunnel-${tunnel.name.id}`,
        tunnel,
      })),
    ]
  }, [displayed, held, tunnelNames])
  // A game server is reached at its own address; only an app's header and
  // list show a domain.
  const showPrimary = kind === "app" && onMakePrimary !== undefined

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
      const id = route.id
      if (!onMakePrimary || !id || choosing !== null) return
      setChoosing(id)
      forkPromise(
        () =>
          ensuringPromise(
            () => onMakePrimary(id),
            () => setChoosing(null)
          ),
        (cause) =>
          showToast({
            description: errorMessage(cause),
            message: "Could not change the primary domain",
            type: "error",
          })
      )
    },
    [choosing, onMakePrimary]
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
      // Put back with its ID, it is primary again if it was and nothing
      // else was chosen since.
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
        const next = current.saved.slice()
        next.splice(Math.min(index, next.length), 0, removed)
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
  const point = React.useCallback(
    (hostname: string) => {
      if (names) setNaming({ hostname })
      else setEditing({ hostname, mode: "add" })
    },
    [names]
  )
  const add = React.useCallback(() => {
    if (names) setNaming({ hostname: null })
    else setEditing({ mode: "add" })
  }, [names])

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
              disabled={
                busy || (names ? (held?.length ?? 0) : saved.length) >= 16
              }
              size="sm"
              type="button"
              onClick={add}
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
        heldDestination={names?.destination}
        pending={save.isPending}
        primaryRowId={primary?.rowId}
        rows={rows}
        services={services}
        showPrimary={showPrimary}
        targets={targets}
        onAdd={canWrite ? add : undefined}
        onMakeTunnelPrimary={onMakeTunnelPrimary}
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
                      ? { ...route, id: candidate.id }
                      : candidate
                  )
                : // The first domain an App gets is its primary until
                  // another is chosen.
                  [...saved, route]
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
      {naming && names && held ? (
        <React.Suspense fallback={null}>
          <DomainNameDialog
            hostname={naming.hostname}
            onOpenChange={(open) => {
              if (!open) setNaming(null)
            }}
            onSubmit={async (hostname) => {
              const current = held.map((name) => name.hostname)
              await names.onSave(
                naming.hostname === null
                  ? [...current, hostname]
                  : current.map((name) =>
                      name === naming.hostname ? hostname : name
                    )
              )
              await queryClient.invalidateQueries({
                queryKey: queryKeys.domains.hostnames(
                  dnsResource.relayId,
                  dnsResource.resourceType,
                  dnsResource.resourceId
                ),
              })
              setNaming(null)
            }}
          />
        </React.Suspense>
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

const noTargets: ReadonlyArray<WebRouteTarget> = []

const columnHelper = createDataTableColumnHelper<DomainRow>()

const WebRoutesTable = React.memo(function WebRoutesTable({
  adoptable,
  canWrite,
  disabled,
  dnsResource,
  error,
  heldDestination,
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
  onMakeTunnelPrimary,
}: {
  adoptable: ReadonlyArray<ResourceWebHostname>
  canWrite: boolean
  disabled: boolean
  dnsResource: WebHostnameResourceRef
  error: Error | null
  // Where every name nothing routes goes, for a database's.
  heldDestination: string | undefined
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
  onMakeTunnelPrimary?: (name: InstanceTunnelName) => void
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
              row.original.tunnel ? (
                <TunnelKindCell
                  disabled={disabled}
                  name={row.original.tunnel}
                  onMakePrimary={onMakeTunnelPrimary}
                />
              ) : row.original.route ? (
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
              row.original.tunnel ? (
                <TunnelDomainCell name={row.original.tunnel} />
              ) : row.original.route ? (
                <RouteDomainCell
                  dnsResource={dnsResource}
                  route={row.original.route}
                  services={services}
                />
              ) : (
                <HeldDomainCell
                  destination={heldDestination}
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
              row.original.tunnel ? (
                <span className="type-meta text-muted-foreground">
                  Every port, on the tailnet
                </span>
              ) : row.original.route ? (
                <RouteDestinationCell
                  route={row.original.route}
                  services={services}
                />
              ) : heldDestination ? (
                <span className="type-meta truncate text-muted-foreground">
                  {heldDestination}
                </span>
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
              row.original.tunnel ? null : row.original.route ? (
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
                  renames={heldDestination !== undefined}
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
      heldDestination,
      onAdopt,
      onEdit,
      onMakePrimary,
      onPoint,
      onRelease,
      onRemove,
      onServe,
      onMakeTunnelPrimary,
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
              {heldDestination
                ? "Give it a name to reach it at from the internet."
                : "Serve a domain over HTTPS, or redirect one somewhere else."}
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

const noTunnelNames: ReadonlyArray<InstanceTunnelName> = []

// A name in a tunnel: Tailscale's mark, or the primary star where the
// instance's primary address can be one.
const TunnelKindCell = React.memo(function TunnelKindCell({
  disabled,
  name,
  onMakePrimary,
}: {
  disabled: boolean
  name: InstanceTunnelName
  onMakePrimary?: (name: InstanceTunnelName) => void
}) {
  if (onMakePrimary) {
    return (
      <PrimaryStar
        disabled={disabled}
        name={name.hostname}
        noun="address"
        primary={name.name.primary}
        onMakePrimary={() => onMakePrimary(name)}
      />
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="grid size-7 place-items-center text-muted-foreground">
          <TailscaleLogo className="size-4" aria-label="On a tunnel" />
        </span>
      </TooltipTrigger>
      <TooltipContent>Reached on {name.tunnelName}'s tailnet</TooltipContent>
    </Tooltip>
  )
})

const TunnelDomainCell = React.memo(function TunnelDomainCell({
  name,
}: {
  name: InstanceTunnelName
}) {
  return (
    <div className="min-w-0">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">{name.hostname}</span>
        <TailscaleLogo
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      </span>
      <span className="type-meta block truncate text-muted-foreground">
        {name.tunnelName}
        {name.name.generated ? "" : " · alias"}
      </span>
    </div>
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
  destination,
  dnsResource,
  hostname,
}: {
  destination: string | undefined
  dnsResource: WebHostnameResourceRef
  hostname: string
}) {
  return (
    <div className="min-w-0">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">{hostname}</span>
        <WebHostnameDnsStatus hostname={hostname} resource={dnsResource} />
        {destination ? (
          <WebCertificateStatus hostnames={[hostname]} resource={dnsResource} />
        ) : null}
      </span>
      <span className="type-meta block truncate text-muted-foreground sm:hidden">
        {destination ?? "Not pointed anywhere"}
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
  renames,
  onPoint,
  onRelease,
}: {
  canWrite: boolean
  disabled: boolean
  held: ResourceWebHostname
  // A database's name is renamed; an App's is pointed somewhere.
  renames: boolean
  onPoint: (hostname: string) => void
  onRelease: (hostname: ResourceWebHostname) => void
}) {
  if (!canWrite) return null
  return (
    <DataTableActionGroup>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={
              renames
                ? `Rename ${held.hostname}`
                : `Choose where ${held.hostname} goes`
            }
            disabled={disabled}
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={() => onPoint(held.hostname)}
          >
            <Pencil />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {renames ? "Rename" : "Choose where it goes"}
        </TooltipContent>
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
    ? `${webRouteService(route)}:${route.targetPort ?? ""}`
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
