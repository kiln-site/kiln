import { DatabaseKindIcon } from "@/components/instance-kind-icon"
import { instanceInventoryScope } from "@/lib/instance-inventory"
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { appTailscaleMemberId } from "@workspace/contracts"
import type { AppPort } from "@workspace/contracts"
import {
  Cable,
  LoaderCircle,
  Network,
  Plus,
  Radio,
  Rocket,
  Trash2,
  Unplug,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
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
  appAddresses,
  appContainers,
  appRelayAvailable,
  appServices,
  showAppOperationError,
  type App,
} from "@/components/app/app-presentation"
import { useAppRunsCompose } from "@/components/app/app-compose"
import { useAppWorkspace } from "@/components/app/app-workspace-context"
import { CopyMetaRow, InfoCard, InfoCardHeader } from "@/components/info-card"
import { TailscaleMembershipSection } from "@/components/tailscale-network-membership"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import {
  WebRoutesSection,
  type WebRouteRow,
  type WebRouteServiceOption,
} from "@/components/web-routes-section"
import {
  accessCapabilitiesQueryOptions,
  appConfigQueryOptions,
  appWebRoutesQueryOptions,
  managedDatabaseDirectoryQueryOptions,
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
  // A repository's Compose file publishes its own ports, like a pasted one.
  const compose = useAppRunsCompose(
    app,
    config.data?.config.sourceType ?? "image"
  )
  const canManage =
    appRelayAvailable(app) && app.permissions.includes("app.manage")

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="mx-auto grid max-w-5xl gap-4 px-5 py-6 sm:px-8 sm:py-8">
        <InfoCard>
          <InfoCardHeader icon={<Network />} title="Private network" />
          <p className="border-b px-4 py-3 text-sm text-muted-foreground">
            {app.name}’s containers share a network of their own. Connected
            databases reach it, and it reaches them, by name.
          </p>
          {appAddresses(app).map(({ address, service }) =>
            service ? (
              <CopyMetaRow
                key={service}
                icon={Radio}
                label={`${service} service`}
                value={address}
              />
            ) : (
              <CopyMetaRow key="app" label="Internal address" value={address} />
            )
          )}
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
            <AppWebRoutes app={app} canManage={canManage} compose={compose} />
            <PublishedPorts
              // A fresh form when the saved ports change, and only then:
              // refetches of the same ports keep unsaved edits.
              key={JSON.stringify(config.data.config.ports)}
              app={app}
              canManage={canManage}
              compose={compose}
              saved={config.data.config.ports}
            />
            <ConnectedDatabases
              app={app}
              canManage={canManage}
              databaseIds={app.savedDatabaseIds}
            />
            <AppTailscale app={app} compose={compose} />
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
  const dnsResource = React.useMemo(
    () => ({
      relayId: app.relayId,
      resourceId: app.id,
      resourceType: "app" as const,
    }),
    [app.id, app.relayId]
  )
  const services = React.useMemo(
    () => appServiceOptions(app, compose),
    [app, compose]
  )
  const save = React.useCallback(
    async (routes: Array<WebRouteRow>) => {
      const next = await updateAppWebRoutes({
        data: {
          appId: app.id,
          relayId: app.relayId,
          routes: routes.map((route) => ({
            ...route,
            // A redirect reaches no service; it rides on the first one's
            // container.
            service: route.service ?? services[0]?.name ?? APP_SERVICE_NAME,
          })),
        },
      })
      queryClient.setQueryData(
        queryKeys.apps.webRoutes(app.relayId, app.id),
        next
      )
    },
    [app.id, app.relayId, queryClient, services]
  )

  return (
    <WebRoutesSection
      // Another app's routes start fresh, Undo included.
      key={`${app.relayId}:${app.id}`}
      canWrite={canManage}
      dnsResource={dnsResource}
      error={state.error}
      kind="app"
      routes={state.data?.routes}
      services={services}
      status={state.data ? appWebRouteStatus(state.data) : null}
      statusAction={
        canManage && state.data?.status === "pending_restart" ? (
          <AppDeployButton app={app} />
        ) : null
      }
      onSave={save}
    />
  )
}

function appWebRouteStatus(state: {
  message: string
  status: string
}): IdentityStatusPresentation {
  if (state.status === "ready")
    return { detail: state.message, label: "Live", tone: "success" }
  if (state.status === "pending_restart")
    return { detail: state.message, label: "Pending deploy", tone: "warning" }
  return { detail: state.message, label: "Unavailable", tone: "danger" }
}

// The services a route can reach: those the app's containers run, or the
// one an image or Dockerfile app runs before its first deploy. A Compose
// app names its services in its file, so until then they're typed.
function appServiceOptions(
  app: App,
  compose: boolean
): Array<WebRouteServiceOption> {
  const byService = new Map<string, Array<App["containers"][number]>>()
  for (const container of appContainers(app)) {
    byService.set(container.service, [
      ...(byService.get(container.service) ?? []),
      container,
    ])
  }
  const options = [...byService].map(([name, containers]) => ({
    image: containers[0]?.image ?? "",
    name,
    ports: [
      ...new Set(
        containers.flatMap((container) =>
          container.ports.map(({ containerPort }) => containerPort)
        )
      ),
    ],
    running: containers.some((container) => container.running),
    state: containers.some((container) => container.running)
      ? "running"
      : (containers[0]?.state ?? "stopped"),
  }))
  if (options.length > 0 || compose) return options
  return [
    {
      image: "",
      name: APP_SERVICE_NAME,
      ports: [],
      running: false,
      state: "not deployed",
    },
  ]
}

function AppDeployButton({ app }: { app: App }) {
  const queryClient = useQueryClient()
  const deploy = useMutation({
    mutationFn: () =>
      deployApp({ data: { appId: app.id, relayId: app.relayId } }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.apps.all }),
    onError: (error) => showAppOperationError("Deploy failed", error),
  })
  const deploying = deploy.isPending || app.deployment?.state === "running"
  return (
    <Button
      disabled={deploying}
      size="sm"
      type="button"
      variant="outline"
      onClick={() => deploy.mutate()}
    >
      {deploying ? <LoaderCircle className="animate-spin" /> : <Rocket />}
      Deploy to apply
    </Button>
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
    ...managedDatabaseDirectoryQueryOptions(),
    select: (overview) =>
      overview.filter((database) => database.relayId === app.relayId),
  })
  const [adding, setAdding] = React.useState("")
  const network = useMutation({
    mutationFn: (change: { connected: boolean; databaseId: string }) =>
      updateAppNetwork({
        data: { appId: app.id, relayId: app.relayId, ...change },
      }),
    onSuccess: async (_database, change) => {
      setAdding("")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: instanceInventoryScope({
            kind: "database",
            relayId: app.relayId,
            id: change.databaseId,
          }),
        }),
        queryClient.invalidateQueries({
          queryKey: instanceInventoryScope({
            kind: "app",
            relayId: app.relayId,
            id: app.id,
          }),
        }),
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
        icon={<DatabaseKindIcon />}
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
                onClick={() =>
                  network.mutate({ connected: true, databaseId: adding })
                }
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
                <DatabaseKindIcon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  {database ? (
                    <Link
                      className="text-sm font-medium hover:text-primary-ink"
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
                      network.mutate({ connected: false, databaseId: id })
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
