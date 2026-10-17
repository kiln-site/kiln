import { Effect } from "effect"

import { isPlatformAdmin, listUserGrantsEffect } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
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
