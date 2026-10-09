import * as React from "react"
import { useQuery, useSuspenseQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Cable, LoaderCircle, Network, Unplug } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import {
  DatabaseNetworkPicker,
  useDatabaseNetworkToggle,
} from "@/components/database/database-network"
import {
  databaseRelayAvailable,
  type ManagedDatabase,
} from "@/components/database/database-presentation"
import { useDatabaseWorkspace } from "@/components/database/database-workspace-context"
import { CopyMetaRow, InfoCard, InfoCardHeader } from "@/components/info-card"
import { InstanceName } from "@/components/instance-name"
import { SettingsEmptyState } from "@/components/settings-panel"
import { canAccessInstancePermission } from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import { relayInstanceRouteIdentifier } from "@/lib/relay-selectors"

export function DatabaseNetworkPage() {
  const { database } = useDatabaseWorkspace()
  const canWrite =
    databaseRelayAvailable(database) &&
    database.permissions.includes("database.network.write")

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="mx-auto grid max-w-5xl gap-4 px-5 py-6 sm:px-8 sm:py-8">
        <InfoCard>
          <InfoCardHeader icon={<Network />} title="Private network" />
          <p className="border-b px-4 py-3 text-sm text-muted-foreground">
            {database.name} has no public port. Servers on {database.relayName}{" "}
            reach it at this address once they are connected to its network.
          </p>
          <CopyMetaRow
            label="Internal address"
            value={`${database.hostname}:${database.internalPort}`}
          />
        </InfoCard>

        <InfoCard>
          <InfoCardHeader
            icon={<Cable />}
            title="Connected servers"
            action={
              canWrite ? (
                <DatabaseNetworkPicker database={database} variant="button" />
              ) : null
            }
          />
          <ConnectedServers canWrite={canWrite} database={database} />
        </InfoCard>
      </div>
    </section>
  )
}

function ConnectedServers({
  canWrite,
  database,
}: {
  canWrite: boolean
  database: ManagedDatabase
}) {
  const selectServers = React.useCallback(
    (snapshot: RelayFleetSnapshot) =>
      database.connectedInstanceIds.map((instanceId) => {
        const instance = snapshot.instances.find(
          (candidate) =>
            candidate.id === instanceId &&
            candidate.relayId === database.relayId
        )
        return {
          id: instanceId,
          instance: instance ?? null,
          routeId: instance
            ? relayInstanceRouteIdentifier(snapshot.instances, instance)
            : null,
        }
      }),
    [database.connectedInstanceIds, database.relayId]
  )
  const { data: servers = [] } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectServers,
  })
  const { data: capabilities } = useSuspenseQuery(
    accessCapabilitiesQueryOptions()
  )
  const { pendingInstanceId, toggle } = useDatabaseNetworkToggle(database)

  if (servers.length === 0) {
    return (
      <SettingsEmptyState icon={<Unplug />}>
        <p className="font-medium text-foreground">No servers connected</p>
        <p>
          {canWrite
            ? "Connect a server to let it reach this database."
            : "Servers connected to this database appear here."}
        </p>
      </SettingsEmptyState>
    )
  }

  return (
    <ul>
      {servers.map(({ id, instance, routeId }) => {
        const canDisconnect =
          canWrite &&
          canAccessInstancePermission(
            capabilities,
            { id, relayId: database.relayId },
            "instance.network.write"
          )
        const pending = pendingInstanceId === id
        const name = instance ? (
          <InstanceName
            className="min-w-0 flex-1"
            instance={{
              brickId: instance.brickId,
              brickSource: instance.brickSource,
              id: instance.id,
              implementation: instance.implementation,
              kind: "server",
              observedState: instance.observedState,
              relayId: instance.relayId,
            }}
            meta={`${instance.implementation} ${instance.version} · ${instance.shortId}`}
            name={instance.name}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            Server {id.slice(0, 8)}
          </span>
        )
        return (
          <li
            key={id}
            className="flex min-h-16 items-center gap-3 border-b px-4 py-2.5 last:border-b-0"
          >
            {routeId ? (
              <Link
                to="/server/$serverId/console"
                params={{ serverId: routeId }}
                preload="intent"
                className="flex min-w-0 flex-1 items-center outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {name}
              </Link>
            ) : (
              name
            )}
            {canDisconnect ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                disabled={pendingInstanceId !== null}
                onClick={() => toggle({ connected: false, instanceId: id })}
              >
                {pending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Unplug />
                )}
                Disconnect
              </Button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
