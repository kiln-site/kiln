import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { appTailscaleMemberId } from "@workspace/contracts"
import type { AppPort, RelayAppWebRoute } from "@workspace/contracts"
import {
  Cable,
  Database,
  Globe2,
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  Radio,
  Rocket,
  Trash2,
  Unplug,
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
  appRelayAvailable,
  appServices,
  showAppOperationError,
  type App,
} from "@/components/app/app-presentation"
import { useAppWorkspace } from "@/components/app/app-workspace-context"
import { CopyMetaRow, InfoCard, InfoCardHeader } from "@/components/info-card"
import { TailscaleMembershipSection } from "@/components/tailscale-network-membership"
import {
  parseWebRouteForm,
  WebRouteFields,
} from "@/components/web-route-fields"
import {
  accessCapabilitiesQueryOptions,
  appConfigQueryOptions,
  appWebRoutesQueryOptions,
  managedDatabasesQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import {
  deployApp,
  updateAppConfig,
  updateAppNetwork,
  updateAppWebRoutes,
} from "@/server/apps"

export function AppNetworkPage() {
  const { app } = useAppWorkspace()
  const config = useQuery(appConfigQueryOptions(app.relayId, app.id))
  const canManage =
    appRelayAvailable(app) && app.permissions.includes("app.manage")
  const services = appServices(app)

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="mx-auto grid max-w-5xl gap-4 px-5 py-6 sm:px-8 sm:py-8">
        <InfoCard>
          <InfoCardHeader icon={<Network />} title="Private network" />
          <p className="border-b px-4 py-3 text-sm text-muted-foreground">
            {app.name}’s containers share a network of their own. Connected
            databases reach it, and it reaches them, by name.
          </p>
          <CopyMetaRow label="Internal address" value={app.hostname} />
          {services.length > 1
            ? services.map((service) => (
                <CopyMetaRow
                  key={service}
                  icon={Radio}
                  label={`${service} service`}
                  value={`${service}.${app.hostname}`}
                />
              ))
            : null}
          {app.network ? (
            <CopyMetaRow
              icon={Cable}
              label="Docker network"
              value={app.network}
            />
          ) : null}
        </InfoCard>

        {config.data ? (
          <>
            <AppWebRoutes
              app={app}
              canManage={canManage}
              compose={config.data.config.sourceType === "compose"}
            />
            <PublishedPorts
              key={config.dataUpdatedAt}
              app={app}
              canManage={canManage}
              compose={config.data.config.sourceType === "compose"}
              saved={config.data.config.ports}
            />
            <ConnectedDatabases
              app={app}
              canManage={canManage}
              databaseIds={config.data.config.databaseIds}
            />
            <AppTailscale
              app={app}
              compose={config.data.config.sourceType === "compose"}
            />
          </>
        ) : (
          <div className="grid h-40 place-items-center">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    </section>
  )
}

// Domains Traefik serves from one of the app's services, like a server's
// web routes.
function AppWebRoutes({
  app,
  canManage,
  compose,
}: {
  app: App
  canManage: boolean
  compose: boolean
}) {
  const queryClient = useQueryClient()
  const state = useQuery(appWebRoutesQueryOptions(app.relayId, app.id))
  const [editing, setEditing] = React.useState<RelayAppWebRoute | "new" | null>(
    null
  )
  const save = useMutation({
    mutationFn: (
      routes: Array<RelayAppWebRoute | Omit<RelayAppWebRoute, "id">>
    ) =>
      updateAppWebRoutes({
        data: { appId: app.id, relayId: app.relayId, routes },
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(
        queryKeys.apps.webRoutes(app.relayId, app.id),
        next
      )
      setEditing(null)
    },
    onError: (error) => showAppOperationError("Could not save routes", error),
  })
  const deploy = useMutation({
    mutationFn: () =>
      deployApp({ data: { appId: app.id, relayId: app.relayId } }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.all }),
    onError: (error) => showAppOperationError("Deploy failed", error),
  })
  const routes = state.data?.routes ?? []
  const deploying = app.deployment?.state === "running"

  return (
    <InfoCard>
      <InfoCardHeader
        icon={<Globe2 />}
        title="Web routes"
        action={
          canManage ? (
            <Button
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => setEditing("new")}
            >
              <Plus />
              Add route
            </Button>
          ) : null
        }
      />
      {state.isPending ? (
        <div className="grid h-20 place-items-center">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : state.isError ? (
        <p className="px-4 py-4 text-xs text-destructive">
          {state.error.message}
        </p>
      ) : routes.length === 0 ? (
        <p className="border-b px-4 py-4 text-xs text-muted-foreground">
          No domains point at this app. Add a route to serve one of its services
          over HTTPS through Traefik.
        </p>
      ) : (
        <ul className="border-b">
          {routes.map((route) => (
            <li
              key={route.id}
              className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
            >
              <Globe2 className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <a
                    className="truncate text-sm font-medium hover:text-primary"
                    href={`https://${route.hostname}${route.path ?? ""}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {route.hostname}
                    {route.path ?? ""}
                  </a>
                  <span className="type-meta text-muted-foreground">
                    {route.name}
                  </span>
                </span>
                <span className="type-meta block font-mono text-muted-foreground">
                  → {route.service}:{route.targetPort}
                  {route.path && route.stripPrefix ? " · strips path" : ""}
                </span>
              </span>
              {canManage ? (
                <>
                  <Button
                    aria-label={`Edit ${route.hostname}`}
                    disabled={save.isPending}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                    onClick={() => setEditing(route)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    aria-label={`Remove ${route.hostname}`}
                    className="text-muted-foreground hover:text-destructive"
                    disabled={save.isPending}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      save.mutate(
                        routes.filter((candidate) => candidate.id !== route.id)
                      )
                    }
                  >
                    <Trash2 />
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {state.data ? (
        <div className="flex items-center gap-3 px-4 py-3">
          <span
            aria-hidden="true"
            className={`size-2 shrink-0 rounded-full ${
              state.data.status === "ready"
                ? "bg-emerald-400"
                : state.data.status === "pending_restart"
                  ? "bg-amber-400"
                  : "bg-destructive"
            }`}
          />
          <span className="type-meta min-w-0 flex-1 text-muted-foreground">
            {state.data.message}
          </span>
          {canManage && state.data.status === "pending_restart" ? (
            <Button
              disabled={deploy.isPending || deploying}
              size="sm"
              type="button"
              onClick={() => deploy.mutate()}
            >
              {deploy.isPending || deploying ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Rocket />
              )}
              Deploy to apply
            </Button>
          ) : null}
        </div>
      ) : null}
      {editing ? (
        <AppWebRouteDialog
          compose={compose}
          pending={save.isPending}
          route={editing === "new" ? undefined : editing}
          services={appServices(app)}
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          onSubmit={(route) =>
            save.mutate(
              editing === "new"
                ? [...routes, route]
                : routes.map((candidate) =>
                    candidate.id === editing.id
                      ? { ...route, id: editing.id }
                      : candidate
                  )
            )
          }
        />
      ) : null}
    </InfoCard>
  )
}

function AppWebRouteDialog({
  compose,
  onOpenChange,
  onSubmit,
  pending,
  route,
  services,
}: {
  compose: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (route: Omit<RelayAppWebRoute, "id">) => void
  pending: boolean
  route?: RelayAppWebRoute
  services: ReadonlyArray<string>
}) {
  const [error, setError] = React.useState<string | null>(null)
  const [service, setService] = React.useState(
    route?.service ?? services[0] ?? (compose ? "" : "app")
  )
  // A Compose app names its services in its file; before it's deployed they
  // can't be listed yet.
  const chooseService = compose || services.length > 1

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {route ? "Edit web route" : "Add web route"}
          </DialogTitle>
          <DialogDescription>
            Traefik serves this domain over HTTPS from one of the app’s
            services.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            const parsed = parseWebRouteForm(
              new FormData(event.currentTarget),
              route?.id
            )
            if (!parsed.success) {
              setError(
                parsed.error.issues[0]?.message ?? "Web route is invalid"
              )
              return
            }
            if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/u.test(service)) {
              setError("Choose the service this route reaches")
              return
            }
            setError(null)
            const { id: _id, ...fields } = parsed.data
            onSubmit({ ...fields, service })
          }}
        >
          <WebRouteFields route={route}>
            {chooseService ? (
              <label className="type-label block space-y-1.5">
                Service
                {services.length > 0 ? (
                  <Select value={service} onValueChange={setService}>
                    <SelectTrigger
                      aria-label="Service"
                      className="h-9 w-full px-3 font-mono text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {services.map((name) => (
                        <SelectItem
                          key={name}
                          value={name}
                          className="font-mono"
                        >
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    className="font-mono"
                    placeholder="web"
                    value={service}
                    onChange={(event) => setService(event.currentTarget.value)}
                  />
                )}
              </label>
            ) : null}
          </WebRouteFields>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button
              disabled={pending}
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button disabled={pending} type="submit">
              {pending ? <LoaderCircle className="animate-spin" /> : null}
              {route ? "Save route" : "Add route"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// Each service can join Tailscale networks like a server, keeping its
// address across deploys. Managing Tailscale is for platform admins.
function AppTailscale({ app, compose }: { app: App; compose: boolean }) {
  const { data: isPlatformAdmin } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) => capabilities.isPlatformAdmin,
  })
  if (!isPlatformAdmin) return null
  const services = appServices(app)
  const members =
    services.length > 0 ? services : compose ? [] : [APP_SERVICE_NAME]
  if (members.length === 0) {
    return (
      <InfoCard>
        <InfoCardHeader icon={<Network />} title="Tailscale networks" />
        <p className="px-4 py-4 text-xs text-muted-foreground">
          Deploy this app once so its services can join Tailscale networks.
        </p>
      </InfoCard>
    )
  }
  return (
    <React.Suspense fallback={null}>
      {members.map((service) => (
        <TailscaleMembershipSection
          key={service}
          member={{
            id: appTailscaleMemberId(app.id, service),
            name: members.length > 1 ? `${service}-${app.name}` : app.name,
            relayId: app.relayId,
            relayName: app.relayName,
            shortId: app.shortId,
          }}
          noun={members.length > 1 ? "service" : "app"}
          title={
            members.length > 1
              ? `Tailscale networks · ${service}`
              : "Tailscale networks"
          }
        />
      ))}
    </React.Suspense>
  )
}

// Image and Dockerfile apps run one service under this name.
const APP_SERVICE_NAME = "app"

function PublishedPorts({
  app,
  canManage,
  compose,
  saved,
}: {
  app: App
  canManage: boolean
  compose: boolean
  saved: ReadonlyArray<AppPort>
}) {
  const queryClient = useQueryClient()
  const [ports, setPorts] = React.useState<Array<AppPort>>(() => [...saved])
  const dirty = JSON.stringify(ports) !== JSON.stringify(saved)
  const live = app.containers.flatMap((container) =>
    container.ports.map((port) => ({ ...port, service: container.service }))
  )
  const save = useMutation({
    mutationFn: () =>
      updateAppConfig({
        data: { appId: app.id, config: { ports }, relayId: app.relayId },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.apps.config(app.relayId, app.id),
      })
      showToast({
        message: "Ports saved. Deploy to publish them.",
        type: "success",
      })
    },
    onError: (error) => showAppOperationError("Could not save ports", error),
  })
  const update = (index: number, patch: Partial<AppPort>) =>
    setPorts((current) =>
      current.map((port, position) =>
        position === index ? { ...port, ...patch } : port
      )
    )

  return (
    <InfoCard>
      <InfoCardHeader
        icon={<Radio />}
        title="Published ports"
        action={
          canManage && !compose ? (
            <Button
              size="xs"
              type="button"
              variant="ghost"
              onClick={() =>
                setPorts((current) => [
                  ...current,
                  { containerPort: 80, hostPort: 8080, protocol: "tcp" },
                ])
              }
            >
              <Plus />
              Add port
            </Button>
          ) : null
        }
      />
      {compose ? (
        <p className="border-b px-4 py-3 text-xs text-muted-foreground">
          Compose apps publish the ports their Compose file lists.
        </p>
      ) : ports.length === 0 ? (
        <p className="border-b px-4 py-3 text-xs text-muted-foreground">
          No ports are published; the app is reachable only on its network.
        </p>
      ) : (
        <ul className="border-b">
          {ports.map((port, index) => (
            <li
              key={index}
              className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5 last:border-b-0"
            >
              <PortInput
                disabled={!canManage}
                label="Host port"
                value={port.hostPort}
                onChange={(hostPort) => update(index, { hostPort })}
              />
              <span className="text-muted-foreground">→</span>
              <PortInput
                disabled={!canManage}
                label="Container port"
                value={port.containerPort}
                onChange={(containerPort) => update(index, { containerPort })}
              />
              <Select
                disabled={!canManage}
                value={port.protocol}
                onValueChange={(protocol) =>
                  update(index, { protocol: protocol as AppPort["protocol"] })
                }
              >
                <SelectTrigger
                  aria-label="Protocol"
                  className="h-8 w-20 px-2.5 font-mono text-xs uppercase"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tcp">TCP</SelectItem>
                  <SelectItem value="udp">UDP</SelectItem>
                </SelectContent>
              </Select>
              {canManage ? (
                <Button
                  aria-label="Remove port"
                  className="ml-auto text-muted-foreground hover:text-destructive"
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setPorts((current) =>
                      current.filter((_, position) => position !== index)
                    )
                  }
                >
                  <Trash2 />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
        <span className="type-technical-label text-muted-foreground">Live</span>
        {live.length === 0 ? (
          <span className="type-meta text-muted-foreground">
            Nothing published right now
          </span>
        ) : (
          live.map((port) => (
            <span
              key={`${port.service}:${port.hostPort}/${port.protocol}`}
              className="type-meta font-mono"
            >
              {port.hostPort}→{port.service}:{port.containerPort}/
              {port.protocol}
            </span>
          ))
        )}
        {dirty ? (
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => setPorts([...saved])}
            >
              Discard
            </Button>
            <Button
              disabled={save.isPending}
              size="sm"
              type="button"
              onClick={() => save.mutate()}
            >
              {save.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : null}
              Save ports
            </Button>
          </div>
        ) : null}
      </div>
    </InfoCard>
  )
}

function PortInput({
  disabled,
  label,
  onChange,
  value,
}: {
  disabled: boolean
  label: string
  onChange: (value: number) => void
  value: number
}) {
  return (
    <Input
      aria-label={label}
      className="h-8 w-24 font-mono text-xs"
      disabled={disabled}
      inputMode="numeric"
      max={65_535}
      min={1}
      type="number"
      value={value}
      onChange={(event) => {
        const next = Number(event.currentTarget.value)
        if (Number.isInteger(next) && next >= 1 && next <= 65_535) {
          onChange(next)
        }
      }}
    />
  )
}

function ConnectedDatabases({
  app,
  canManage,
  databaseIds,
}: {
  app: App
  canManage: boolean
  databaseIds: ReadonlyArray<string>
}) {
  const queryClient = useQueryClient()
  const databases = useQuery({
    ...managedDatabasesQueryOptions(),
    select: (overview) =>
      overview.databases.filter((database) => database.relayId === app.relayId),
  })
  const [adding, setAdding] = React.useState("")
  const network = useMutation({
    mutationFn: (next: Array<string>) =>
      updateAppNetwork({
        data: { appId: app.id, databaseIds: next, relayId: app.relayId },
      }),
    onSuccess: async () => {
      setAdding("")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.apps.config(app.relayId, app.id),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.apps.list }),
      ])
    },
    onError: (error) =>
      showAppOperationError("Could not update databases", error),
  })
  const byId = new Map(
    (databases.data ?? []).map((database) => [database.id, database])
  )
  const connectable = (databases.data ?? []).filter(
    (database) =>
      !databaseIds.includes(database.id) &&
      database.permissions.includes("database.network.write")
  )

  return (
    <InfoCard>
      <InfoCardHeader
        icon={<Database />}
        title="Databases"
        action={
          canManage && connectable.length > 0 ? (
            <div className="flex items-center gap-2">
              <Select value={adding} onValueChange={setAdding}>
                <SelectTrigger
                  aria-label="Database to connect"
                  className="h-8 w-48 px-3 text-xs"
                >
                  <SelectValue placeholder="Choose a database" />
                </SelectTrigger>
                <SelectContent>
                  {connectable.map((database) => (
                    <SelectItem key={database.id} value={database.id}>
                      {database.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                disabled={!adding || network.isPending}
                size="sm"
                type="button"
                onClick={() => network.mutate([...databaseIds, adding])}
              >
                {network.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Cable />
                )}
                Connect
              </Button>
            </div>
          ) : null
        }
      />
      {databaseIds.length === 0 ? (
        <p className="px-4 py-5 text-xs text-muted-foreground">
          No databases are connected. Connected databases join the app’s
          containers on their private network, now and on every deploy.
        </p>
      ) : (
        <ul>
          {databaseIds.map((id) => {
            const database = byId.get(id)
            const attached = app.connectedDatabaseIds.includes(id)
            return (
              <li
                key={id}
                className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
              >
                <Database className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  {database ? (
                    <Link
                      className="text-sm font-medium hover:text-primary"
                      params={{ databaseId: id }}
                      to="/db/$databaseId"
                    >
                      {database.name}
                    </Link>
                  ) : (
                    <span className="text-sm font-medium">
                      {id.slice(0, 8)}
                    </span>
                  )}
                  <span className="type-meta block font-mono text-muted-foreground">
                    {database
                      ? `${database.hostname}:${database.internalPort}`
                      : "Not visible to you"}
                    {app.containers.length > 0 && !attached
                      ? " · applies on next deploy"
                      : ""}
                  </span>
                </span>
                {canManage ? (
                  <Button
                    disabled={network.isPending}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      network.mutate(
                        databaseIds.filter((candidate) => candidate !== id)
                      )
                    }
                  >
                    <Unplug />
                    Disconnect
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </InfoCard>
  )
}
