import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { Cable, Copy, LoaderCircle, Network, Unplug } from "lucide-react"

import {
  databaseEngineRuntimes,
  databasePublicConnectionUrl,
  databaseTailscaleMemberId,
  type RelayDatabaseMember,
  type RelayDatabasePublicStatus,
  type RelayInstanceWebRoute,
} from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"

import {
  DatabaseNetworkPicker,
  databaseMemberKey,
  useDatabaseMemberCandidates,
  useDatabaseNetworkToggle,
  type DatabaseMemberCandidate,
} from "@/components/database/database-network"
import {
  databaseAddress,
  databaseRelayAvailable,
  type ManagedDatabase,
} from "@/components/database/database-presentation"
import { useDatabaseWorkspace } from "@/components/database/database-workspace-context"
import { CopyMetaRow, InfoCard, InfoCardHeader } from "@/components/info-card"
import { InstanceCard } from "@/components/instance-card"
import { SettingsEmptyState } from "@/components/settings-panel"
import type { IdentityStatusPresentation } from "@/components/identity-name"
import { useInstanceTunnelNames } from "@/components/tunnel/tunnel-data"
import { forkPromise } from "@/effect/promise"
import { managedDatabaseCredentialQueryOptions } from "@/lib/query-options"
import { InstanceTunnelsSection } from "@/components/tunnel/instance-tunnels-section"
import { WebRoutesSection } from "@/components/web-routes-section"
import { saveManagedDatabaseNames } from "@/server/databases"

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
            Game servers, Apps, and other databases on {database.relayName}{" "}
            reach {database.name} at this address once they are connected to its
            network. There, each answers to the name listed with it.
          </p>
          <CopyMetaRow
            label="Internal address"
            value={databaseAddress(database.hostname, database)}
          />
        </InfoCard>

        <InfoCard>
          <InfoCardHeader
            icon={<Cable />}
            title="Connected"
            action={
              canWrite ? (
                <DatabaseNetworkPicker database={database} variant="button" />
              ) : null
            }
          />
          <ConnectedMembers canWrite={canWrite} database={database} />
        </InfoCard>

        <DatabaseDomains database={database} />

        <DatabaseTunnels database={database} />
      </div>
    </section>
  )
}

const noRoutes: ReadonlyArray<RelayInstanceWebRoute> = []

// Where opening it stands, as its Relay says.
const publicStatuses: Record<
  RelayDatabasePublicStatus["state"],
  Pick<IdentityStatusPresentation, "label" | "pulse" | "tone">
> = {
  failed: { label: "Can't open", tone: "danger" },
  getting_certificate: {
    label: "Getting its certificate",
    pulse: true,
    tone: "info",
  },
  open: { label: "Open", tone: "success" },
  opening: { label: "Opening", pulse: true, tone: "info" },
  waiting_for_dns: {
    label: "Waiting for its names to resolve",
    pulse: true,
    tone: "warning",
  },
}

// Its names, in the Domains table every instance has: each public domain,
// reached at one port with TLS, and its names in tunnels. One with a public
// domain is open to the internet; adding its first opens it and deleting its
// last closes it.
function DatabaseDomains({ database }: { database: ManagedDatabase }) {
  const { engine, id, permissions, public: open, relayId, relayName } = database
  const canWrite =
    databaseRelayAvailable(database) &&
    permissions.includes("database.network.public-port.write")
  const dnsResource = React.useMemo(
    () => ({ relayId, resourceId: id, resourceType: "database" as const }),
    [id, relayId]
  )
  const memberId = databaseTailscaleMemberId(id)
  const isMember = React.useCallback(
    (candidate: string) => candidate === memberId,
    [memberId]
  )
  const tunnelNames = useInstanceTunnelNames(isMember)
  const port = open?.port ?? databaseEngineRuntimes[engine].port
  const names = React.useMemo(
    () => ({
      destination: `Port ${port} on ${relayName}, TLS required`,
      port,
      portHost: relayName,
      onSave: (change: {
        generate?: boolean
        hostnames: Array<string>
        port: number
      }) =>
        saveManagedDatabaseNames({
          data: { ...change, databaseId: id, relayId },
        }),
    }),
    [id, port, relayId, relayName]
  )
  const status = React.useMemo((): IdentityStatusPresentation | null => {
    if (!open) return null
    return {
      ...publicStatuses[open.state],
      ...(open.error ? { detail: open.error } : {}),
    }
  }, [open])
  return (
    <WebRoutesSection
      canWrite={canWrite}
      dnsResource={dnsResource}
      error={null}
      kind="database"
      names={names}
      routes={noRoutes}
      status={status}
      statusAction={
        open ? <CopyConnectionUrl database={database} open={open} /> : null
      }
      tunnelNames={tunnelNames}
      onSave={rejectRoutes}
    />
  )
}

// Copies a connection URL that checks the database's certificate, as many
// clients don't unless they're told to; its password is read as it's
// copied.
function CopyConnectionUrl({
  database,
  open,
}: {
  database: ManagedDatabase
  open: RelayDatabasePublicStatus
}) {
  const queryClient = useQueryClient()
  const [copied, setCopied] = React.useState(false)
  if (!database.permissions.includes("database.credentials.read")) return null
  const host = open.hostnames[0]
  if (!host) return null
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() =>
        forkPromise(
          async () => {
            const login = await queryClient.fetchQuery(
              managedDatabaseCredentialQueryOptions(
                database.relayId,
                database.id
              )
            )
            await navigator.clipboard.writeText(
              databasePublicConnectionUrl({
                databaseName: database.databaseName,
                engine: database.engine,
                host,
                password: encodeURIComponent(login.password),
                port: open.port,
                username: login.username,
              })
            )
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1_800)
          },
          (cause) =>
            showToast({
              description:
                cause instanceof Error ? cause.message : String(cause),
              message: "Could not copy the connection URL",
              type: "error",
            })
        )
      }
    >
      <Copy />
      {copied ? "Copied" : "Connection URL"}
    </Button>
  )
}

// A database has names, not routes.
const rejectRoutes = () =>
  Promise.reject(new Error("A database's domains have no routes"))

// The tunnels the database is connected to, keeping its address there when
// its container is replaced, and its names in each.
function DatabaseTunnels({
  database: { id, name, relayId, relayName },
}: {
  database: ManagedDatabase
}) {
  const member = React.useMemo(
    () => ({
      memberId: databaseTailscaleMemberId(id),
      name,
      relayId,
      relayName,
    }),
    [id, name, relayId, relayName]
  )
  return <InstanceTunnelsSection member={member} />
}

const kindNames = {
  app: "App",
  database: "Database",
  instance: "Game server",
} as const

// When its containers next join the network or take their name there: an
// App's on its next deploy, others' when they next start or restart.
const nextChange = {
  app: "on its next deploy",
  database: "when it next starts or restarts",
  instance: "when it next starts or restarts",
} as const

// What the member's names there are, now and once its containers change.
function memberReach(member: RelayDatabaseMember): string | null {
  const pending = member.pendingHostnames.join(", ")
  if (!member.attached) {
    if (!member.saved) return null
    return pending
      ? `Joins as ${pending} ${nextChange[member.kind]}`
      : `Joins ${nextChange[member.kind]}`
  }
  return (
    [
      member.hostnames.length > 0
        ? `Reachable as ${member.hostnames.join(", ")}`
        : null,
      pending ? `Gets ${pending} ${nextChange[member.kind]}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || null
  )
}

const kindOrder = { instance: 0, app: 1, database: 2 } as const

function ConnectedMembers({
  canWrite,
  database,
}: {
  canWrite: boolean
  database: ManagedDatabase
}) {
  const candidates = useDatabaseMemberCandidates(database)
  const { pendingKey, toggle } = useDatabaseNetworkToggle(database)
  const members = React.useMemo(
    () =>
      [...database.members].sort(
        (left, right) =>
          kindOrder[left.kind] - kindOrder[right.kind] ||
          (
            candidates.get(databaseMemberKey(left))?.item.name ?? left.id
          ).localeCompare(
            candidates.get(databaseMemberKey(right))?.item.name ?? right.id
          )
      ),
    [candidates, database.members]
  )

  if (members.length === 0) {
    return (
      <SettingsEmptyState icon={<Unplug />}>
        <p className="font-medium text-foreground">Nothing is connected</p>
        <p>
          {canWrite
            ? "Connect a game server, App, or database to let it reach this database."
            : "Game servers, Apps, and databases connected to this database appear here."}
        </p>
      </SettingsEmptyState>
    )
  }

  return (
    <ul>
      {members.map((member) => {
        const key = databaseMemberKey(member)
        const candidate = candidates.get(key) ?? null
        return (
          <li
            key={key}
            className="flex min-h-16 items-center gap-3 border-b px-4 py-2.5 last:border-b-0"
          >
            <MemberName candidate={candidate} member={member} />
            {canWrite && candidate?.canChange ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                disabled={pendingKey !== null}
                onClick={() =>
                  toggle({
                    connected: false,
                    member: { id: member.id, kind: member.kind },
                  })
                }
              >
                {pendingKey === key ? (
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

function MemberName({
  candidate,
  member,
}: {
  candidate: DatabaseMemberCandidate | null
  member: RelayDatabaseMember
}) {
  const reach = memberReach(member)
  const name = candidate ? (
    <InstanceCard
      className="min-w-0 flex-1"
      instance={candidate.item.identity}
      meta={reach ? `${candidate.item.meta} · ${reach}` : candidate.item.meta}
      name={candidate.item.name}
    />
  ) : (
    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
      {kindNames[member.kind]} {member.id}
      {reach ? ` · ${reach}` : ""}
    </span>
  )
  if (!candidate) return name
  const className =
    "flex min-w-0 flex-1 items-center outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
  switch (member.kind) {
    case "instance":
      return (
        <Link
          to="/server/$serverId/console"
          params={{ serverId: member.id }}
          preload="intent"
          className={className}
        >
          {name}
        </Link>
      )
    case "app":
      return (
        <Link
          to="/app/$appId/network"
          params={{ appId: member.id }}
          preload="intent"
          className={className}
        >
          {name}
        </Link>
      )
    case "database":
      return (
        <Link
          to="/db/$databaseId/network"
          params={{ databaseId: member.id }}
          preload="intent"
          className={className}
        >
          {name}
        </Link>
      )
  }
}
