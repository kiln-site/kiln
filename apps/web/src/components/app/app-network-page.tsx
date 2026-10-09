import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { AppPort } from "@workspace/contracts"
import {
  Cable,
  Database,
  LoaderCircle,
  Network,
  Plus,
  Radio,
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
  appRelayAvailable,
  appServices,
  showAppOperationError,
  type App,
} from "@/components/app/app-presentation"
import { useAppWorkspace } from "@/components/app/app-workspace-context"
import { CopyMetaRow, InfoCard, InfoCardHeader } from "@/components/info-card"
import {
  appConfigQueryOptions,
  managedDatabasesQueryOptions,
  queryKeys,
} from "@/lib/query-options"
import { updateAppConfig, updateAppNetwork } from "@/server/apps"

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
