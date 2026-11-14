import { DatabaseKindIcon } from "@/components/instance-kind-icon"
import { instanceInventoryScope } from "@/lib/instance-inventory"
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  appPortSchema,
  appTailscaleMemberId,
  webPortCandidates,
} from "@workspace/contracts"
import type { AppPort } from "@workspace/contracts"
import {
  Cable,
  LoaderCircle,
  Network,
  Plus,
  Radio,
  Rocket,
  Unplug,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
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
import {
  formatHostPort,
  formatPortProtocol,
  PortFields,
  PortRow,
  PortRowActions,
  PortsNote,
  PortsSection,
  PortsTable,
  RemovePortDialog,
  type PortNotice,
} from "@/components/ports-section"
import { TailscaleMembershipSection } from "@/components/tailscale-network-membership"
import { useHeldWebHostnames } from "@/components/web-hostname-dns"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import {
  WebRoutesSection,
  type WebRouteProxyChange,
  type WebRouteRow,
  type WebRouteServiceOption,
} from "@/components/web-routes-section"
import {
  accessCapabilitiesQueryOptions,
  appConfigQueryOptions,
  managedDatabaseDirectoryQueryOptions,
  queryKeys,
  webRoutesQueryOptions,
} from "@/lib/query-options"
import { deployApp, updateAppConfig, updateAppNetwork } from "@/server/apps"
import { updateWebRoutes } from "@/server/domains"
import { useAppDeployState } from "@/components/app/use-app-deploy-state"

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
            <AppPorts
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

// Domains Traefik serves from one of the app's services, like a server's.
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
  const dnsResource = React.useMemo(
    () => ({
      relayId: app.relayId,
      resourceId: app.id,
      resourceType: "app" as const,
    }),
    [app.id, app.relayId]
  )
  const state = useQuery(webRoutesQueryOptions(dnsResource))
  const services = React.useMemo(
    () => appServiceOptions(app, compose),
    [app, compose]
  )
  const save = React.useCallback(
    async (routes: Array<WebRouteRow>, proxy?: WebRouteProxyChange) => {
      const next = await updateWebRoutes({
        data: {
          ...dnsResource,
          proxy,
          routes: routes.map((route) => ({
            ...route,
            // A redirect reaches no service; it rides on the first one's
            // container.
            service: route.service ?? services[0]?.name ?? APP_SERVICE_NAME,
          })),
        },
      })
      queryClient.setQueryData(
        queryKeys.relay.webRoutes(app.relayId, app.id),
        next
      )
    },
    [app.id, app.relayId, dnsResource, queryClient, services]
  )

  // The ports its running services listen on that could be its website's:
  // a name nothing serves yet is offered to them.
  const targets = React.useMemo(
    () =>
      services
        .filter((service) => service.running)
        .flatMap((service) =>
          webPortCandidates(service.ports).map((port) => ({
            port,
            service: service.name,
          }))
        )
        .slice(0, 3),
    [services]
  )

  return (
    <WebRoutesSection
      // Another app's routes start fresh, Undo included.
      key={`${app.relayId}:${app.id}`}
      canWrite={
        appRelayAvailable(app) &&
        app.permissions.includes("instance.network.write")
      }
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
      targets={targets}
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
    // What it publishes, and what it only says it listens on that could
    // be a website's.
    ports: [
      ...new Set(
        containers.flatMap((container) => [
          ...container.ports.map(({ containerPort }) => containerPort),
          ...webPortCandidates(container.exposedPorts),
        ])
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
    onSuccess: () => {
      showToast({ message: "Deploy queued", type: "success" })
      return queryClient.invalidateQueries({ queryKey: queryKeys.apps.all })
    },
    onError: (error) => showAppOperationError("Deploy failed", error),
  })
  // Asked during a build, it applies once that ends; once asked, it waits.
  const queued = useAppDeployState(app.id)?.queuedId != null
  const deploying = deploy.isPending || queued
  return (
    <Button
      disabled={deploying}
      size="sm"
      type="button"
      variant="outline"
      onClick={() => deploy.mutate()}
    >
      {deploying ? <LoaderCircle className="animate-spin" /> : <Rocket />}
      {queued ? "Deploy queued" : "Deploy to apply"}
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
            id: app.id,
            memberId: appTailscaleMemberId(app.id, service),
            name: members.length > 1 ? `${service}-${app.name}` : app.name,
            relayId: app.relayId,
            relayName: app.relayName,
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

// The ports the App publishes on its Relay. An image or Dockerfile App's are
// its configuration's, published by its next deploy. A Compose App's are
// whatever its file lists, shown as its containers publish them.
function AppPorts({
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
  // The port being edited by its place in the list, or a new one.
  const [editing, setEditing] = React.useState<number | "new" | null>(null)
  const [removing, setRemoving] = React.useState<number | null>(null)
  const live = React.useMemo(
    () =>
      app.containers.flatMap((container) =>
        container.ports.map((port) => ({ ...port, service: container.service }))
      ),
    [app.containers]
  )
  const save = useMutation({
    mutationFn: (ports: Array<AppPort>) =>
      updateAppConfig({
        data: { appId: app.id, config: { ports }, relayId: app.relayId },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.apps.config(app.relayId, app.id),
      })
      setEditing(null)
      setRemoving(null)
      showToast({
        message: "Ports saved. Deploy to publish them.",
        type: "success",
      })
    },
    onError: (error) => showAppOperationError("Could not save ports", error),
  })
  const dnsResource = React.useMemo(
    () => ({
      relayId: app.relayId,
      resourceId: app.id,
      resourceType: "app" as const,
    }),
    [app.id, app.relayId]
  )
  // The App's own address reaches its ports too, unless it goes through
  // Cloudflare's proxy, which carries web traffic only.
  const host = useHeldWebHostnames(dnsResource)?.find(
    (held) => held.status === "active" && held.proxied === false
  )?.hostname
  const address = (port: number, name: string) =>
    host
      ? {
          copy: formatHostPort(host, port),
          label: `${name} public address`,
        }
      : String(port)
  const running = app.containers.some((container) => container.running)
  const published = (port: AppPort) =>
    live.some(
      (candidate) =>
        candidate.hostPort === port.hostPort &&
        candidate.containerPort === port.containerPort &&
        candidate.protocol === port.protocol
    )
  // What it publishes differs from what's saved: its next deploy applies it.
  const stale =
    running &&
    !compose &&
    (saved.some((port) => !published(port)) || live.length !== saved.length)
  const removal = removing === null ? undefined : saved[removing]

  return (
    <PortsSection
      action={
        canManage && !compose ? (
          <>
            {stale ? <AppDeployButton app={app} /> : null}
            <Button
              disabled={save.isPending || saved.length >= 32}
              size="sm"
              type="button"
              onClick={() => setEditing("new")}
            >
              <Plus />
              Add port
            </Button>
          </>
        ) : null
      }
      footer={
        compose ? (
          <PortsNote>
            Compose Apps publish the ports their Compose file lists.
          </PortsNote>
        ) : null
      }
    >
      {compose ? (
        live.length === 0 ? (
          <p className="type-support px-4 py-3 text-muted-foreground">
            Nothing published right now.
          </p>
        ) : (
          <PortsTable>
            {live.map((port) => (
              <PortRow
                key={`${port.service}:${port.hostPort}/${port.protocol}`}
                address={address(port.hostPort, port.service)}
                detail={formatPortProtocol(port.protocol)}
                internalPort={port.containerPort}
                name={port.service}
              />
            ))}
          </PortsTable>
        )
      ) : saved.length === 0 ? (
        <p className="type-support px-4 py-3 text-muted-foreground">
          No ports. This App is reachable only on its network.
        </p>
      ) : (
        <PortsTable>
          {saved.map((port, index) => (
            <PortRow
              key={`${port.hostPort}/${port.protocol}`}
              actions={
                canManage ? (
                  <PortRowActions
                    disabled={save.isPending}
                    name={`port ${port.hostPort}`}
                    onEdit={() => setEditing(index)}
                    onRemove={() => setRemoving(index)}
                  />
                ) : null
              }
              address={address(port.hostPort, `port ${port.hostPort}`)}
              detail={formatPortProtocol(port.protocol)}
              internalPort={port.containerPort}
              name={app.name}
              notice={running && !published(port) ? unpublished : undefined}
            />
          ))}
        </PortsTable>
      )}
      {editing !== null ? (
        <AppPortDialog
          others={saved.filter((_, index) => index !== editing)}
          pending={save.isPending}
          port={editing === "new" ? undefined : saved[editing]}
          onOpenChange={(open) => {
            if (!open && !save.isPending) setEditing(null)
          }}
          onSubmit={(port) =>
            save.mutate(
              editing === "new"
                ? [...saved, port]
                : saved.map((current, index) =>
                    index === editing ? port : current
                  )
            )
          }
        />
      ) : null}
      {removal ? (
        <RemovePortDialog
          address={`${removal.hostPort} → ${removal.containerPort}`}
          name={`${app.name} · ${formatPortProtocol(removal.protocol)}`}
          open
          onConfirm={() =>
            save.mutate(saved.filter((_, index) => index !== removing))
          }
          onOpenChange={(open) => {
            if (!open && !save.isPending) setRemoving(null)
          }}
        />
      ) : null}
    </PortsSection>
  )
}

const unpublished: PortNotice = {
  label: "View why this port isn't published",
  tone: "warning",
  tooltip: "Deploy to publish",
  onClick: () =>
    showToast({
      description: "Deploy this App to publish it.",
      message: "Port not published yet",
      type: "warning",
    }),
}

function AppPortDialog({
  others,
  pending,
  port,
  onOpenChange,
  onSubmit,
}: {
  /** The App's other ports, which this one can't repeat. */
  others: ReadonlyArray<AppPort>
  pending: boolean
  port?: AppPort
  onOpenChange: (open: boolean) => void
  onSubmit: (port: AppPort) => void
}) {
  const [protocol, setProtocol] = React.useState<AppPort["protocol"]>(
    port?.protocol ?? "tcp"
  )
  // Kept here, not in the form: React clears a form's own fields when its
  // action returns, which would lose them to a refused save.
  const [internalPort, setInternalPort] = React.useState(
    port ? String(port.containerPort) : ""
  )
  const [publicPort, setPublicPort] = React.useState(
    port ? String(port.hostPort) : ""
  )
  const [error, setError] = React.useState<string | null>(null)

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{port ? "Edit port" : "Add port"}</DialogTitle>
          <DialogDescription className="sr-only">
            Publish a TCP or UDP port of this App on its Relay.
          </DialogDescription>
        </DialogHeader>
        <form
          action={() => {
            const parsed = appPortSchema.safeParse({
              containerPort: Number(internalPort),
              hostPort: Number(publicPort),
              protocol,
            })
            if (!parsed.success) {
              setError("Ports must be between 1 and 65535")
              return
            }
            if (
              others.some(
                (other) =>
                  other.hostPort === parsed.data.hostPort &&
                  other.protocol === parsed.data.protocol
              )
            ) {
              setError(
                `This App already publishes ${parsed.data.hostPort}/${parsed.data.protocol}`
              )
              return
            }
            setError(null)
            onSubmit(parsed.data)
          }}
          className="space-y-4"
        >
          <PortFields
            internalPort={{ value: internalPort, onChange: setInternalPort }}
            protocol={protocol}
            publicPort={{ value: publicPort, onChange: setPublicPort }}
            onProtocolChange={(next) => {
              if (next !== "both") setProtocol(next)
            }}
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <DialogFooter>
            <DialogClose
              render={
                <Button disabled={pending} type="button" variant="outline" />
              }
            >
              Cancel
            </DialogClose>
            <Button disabled={pending} type="submit">
              {pending ? (
                <LoaderCircle className="animate-spin" />
              ) : port ? null : (
                <Plus />
              )}
              {port ? "Save" : "Add port"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
                    <span className="text-sm font-medium">{id}</span>
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
