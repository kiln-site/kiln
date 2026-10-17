import { Effect } from "effect"

import { isPlatformAdmin, listUserGrantsEffect } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { grantHasPermission } from "@/lib/permissions"
import { effectiveScopePermissions } from "@/lib/resource-permissions"
import { listPersistedRelaysEffect } from "@/lib/relay-registry"
import { builtinTailscaleBrickId } from "@workspace/contracts"
import { listInstanceDirectoryEffect } from "@/lib/instance-directory"
import { relayInstanceRouteId } from "@/lib/relay-fleet"
import {
  loadManagedDomainAddressesEffect,
  managedAddressForInstance,
} from "@/server/domains.server"

export const readInfraServerDirectory = Effect.fn("Infra.directory.servers")(
  function* (user: AuthenticatedUser) {
    const { relays, grants, records, addresses } = yield* Effect.all(
      {
        relays: listPersistedRelaysEffect(),
        grants: isPlatformAdmin(user)
          ? Effect.succeed([])
          : listUserGrantsEffect(user.id),
        records: listInstanceDirectoryEffect(),
        addresses: loadManagedDomainAddressesEffect(),
      },
      { concurrency: 4 }
    )
    const relayNames = new Map(
      relays
        .filter((relay) => relay.enabled)
        .map((relay) => [relay.id, relay.name])
    )
    return records.flatMap((record) => {
      const relayName = relayNames.get(record.relayId)
      if (!relayName || record.brickId === builtinTailscaleBrickId) return []
      if (
        !isPlatformAdmin(user) &&
        !effectiveScopePermissions(grants, {
          relayId: record.relayId,
          resourceType: "instance",
          resourceId: record.id,
        }).has("instance.read")
      )
        return []
      const {
        publicHost: _host,
        publicPort: _port,
        tailscaleEnabled,
        ...metadata
      } = record
      return [
        {
          ...metadata,
          // A managed domain applies only while it still points at this
          // server's public endpoint.
          connectAddress: tailscaleEnabled
            ? record.connectAddress
            : managedAddressForInstance(addresses, record),
          relayName,
          shortId: record.id.slice(0, 8),
          routeId: relayInstanceRouteId(record.relayId, record.id.slice(0, 8)),
        },
      ]
    })
  }
)

export const readInfraRelayOptions = Effect.fn("Infra.directory.relays")(
  function* (user: AuthenticatedUser, kind: "app" | "database") {
    const { relays, grants } = yield* Effect.all(
      {
        relays: listPersistedRelaysEffect(),
        grants: isPlatformAdmin(user)
          ? Effect.succeed([])
          : listUserGrantsEffect(user.id),
      },
      { concurrency: 2 }
    )
    return {
      relays: relays.flatMap((relay) => {
        if (!relay.enabled) return []
        const permissions = effectiveScopePermissions(grants, {
          relayId: relay.id,
          resourceType: "relay",
          resourceId: relay.id,
        })
        const canCreate =
          isPlatformAdmin(user) || permissions.has(`${kind}.create`)
        const canRead =
          isPlatformAdmin(user) ||
          permissions.has(`${kind}.read`) ||
          (kind === "database" &&
            grants.some(
              (grant) =>
                grant.relayId === relay.id &&
                grant.resourceType === "database" &&
                grantHasPermission(grant, "database.read")
            ))
        return canRead || canCreate
          ? [{ id: relay.id, name: relay.name, canCreate }]
          : []
      }),
    }
  }
)
