import * as React from "react"
import { Link } from "@tanstack/react-router"
import { Cable, LoaderCircle, Network, Unplug } from "lucide-react"

import { useQuery } from "@tanstack/react-query"
import {
  databaseTailscaleMemberId,
  type RelayDatabaseMember,
} from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"

import {
  DatabaseNetworkPicker,
  databaseMemberKey,
  useDatabaseMemberCandidates,
  useDatabaseNetworkToggle,
  type DatabaseMemberCandidate,
} from "@/components/database/database-network"
import {
  databaseRelayAvailable,
  type ManagedDatabase,
} from "@/components/database/database-presentation"
import { useDatabaseWorkspace } from "@/components/database/database-workspace-context"
import { CopyMetaRow, InfoCard, InfoCardHeader } from "@/components/info-card"
import { InstanceCard } from "@/components/instance-card"
import { SettingsEmptyState } from "@/components/settings-panel"
import { TailscaleMembershipSection } from "@/components/tailscale-network-membership"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

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
            {database.name} has no public port. Game servers, Apps, and other
            databases on {database.relayName} reach it at this address once they
            are connected to its network. There, each answers to the name listed
            with it.
          </p>
          <CopyMetaRow
            label="Internal address"
            value={`${database.hostname}:${database.internalPort}`}
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

        <DatabaseTailscale database={database} />
      </div>
    </section>
  )
}

// The database can join Tailscale networks like a game server, keeping its
// address when its container is replaced. Managing Tailscale is for
// platform admins.
function DatabaseTailscale({
  database: { id, name, relayId, relayName, shortId },
}: {
  database: ManagedDatabase
}) {
  const { data: isPlatformAdmin } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) => capabilities.isPlatformAdmin,
  })
  const member = React.useMemo(
    () => ({
      memberId: databaseTailscaleMemberId(id),
      name,
      relayId,
      relayName,
      shortId,
    }),
    [id, name, relayId, relayName, shortId]
  )
  if (!isPlatformAdmin) return null
  return (
    <React.Suspense fallback={null}>
      <TailscaleMembershipSection member={member} noun="database" />
    </React.Suspense>
  )
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
      {kindNames[member.kind]} {member.id.slice(0, 8)}
      {reach ? ` · ${reach}` : ""}
    </span>
  )
  const routeId = candidate?.routeId
  if (!routeId) return name
  const className =
    "flex min-w-0 flex-1 items-center outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
  switch (member.kind) {
    case "instance":
      return (
        <Link
          to="/server/$serverId/console"
          params={{ serverId: routeId }}
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
          params={{ appId: routeId }}
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
          params={{ databaseId: routeId }}
          preload="intent"
          className={className}
        >
          {name}
        </Link>
      )
  }
}
