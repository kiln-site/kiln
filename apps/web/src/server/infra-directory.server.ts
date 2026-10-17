import { Effect } from "effect"

import { isPlatformAdmin, listUserGrantsEffect } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { grantHasPermission } from "@/lib/permissions"
import { effectiveScopePermissions } from "@/lib/resource-permissions"
import { listPersistedRelaysEffect } from "@/lib/relay-registry"

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
