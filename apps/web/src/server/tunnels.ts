// The tunnels' server functions; what they run is in `tunnels.server.ts`.

import { reserveInstanceId } from "@/effect/instance-ids"
import { runAppEffect } from "@/effect/runtime"
import { verifyTailscaleOAuthCredentialEffect } from "@/effect/tailscale-api"
import { loadTunnelNameEffect } from "@/effect/tunnel-names"
import { type TailscaleOAuthCredential } from "@/effect/tunnels"
import { isPlatformAdmin, listUserGrants } from "@/lib/access-control"
import { type AccessPermission } from "@/lib/permissions"
import { effectiveScopePermissions } from "@/lib/resource-permissions"
import { runOperationPromise } from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import { tunnelBricks } from "@/server/tunnel-bricks.server"
import { createServerFn } from "@tanstack/react-start"
import {
  type TunnelOverview,
  addTunnelAliasOperation,
  configureTailscaleIntegrationOperation,
  configureTailscaleIntegrationSchema,
  connectTunnelOperation,
  createTunnelOperation,
  createTunnelSchema,
  gatewayPermissions,
  inspectTailscaleControlPlane,
  loadTunnelCredential,
  loadTunnels,
  previewTailscaleIntegrationSchema,
  primaryTunnelNameSchema,
  removeTunnelAliasOperation,
  removeTunnelAliasSchema,
  removeTunnelOperation,
  removeTunnelSchema,
  requireCompleteGatewayList,
  requireTailscaleAdministrator,
  saveTunnelOperation,
  saveTunnelSchema,
  setPrimaryTunnelNameOperation,
  syncTailscaleIntegrationOperation,
  syncTailscaleIntegrationSchema,
  tunnelAliasSchema,
  tunnelConnectionSchema,
} from "@/server/tunnels.server"

export type {
  GatewayOverview,
  TunnelMemberName,
  TunnelOverview,
  TunnelsResult,
} from "@/server/tunnels.server"

/**
 * The tunnels the viewer sees, and what they may do with each. A platform
 * administrator sees and changes them all, and the owner of one sees and
 * changes it. Anyone else sees a tunnel through a grant reaching a Relay one
 * of its gateways is on, with that gateway and what it connects there, as
 * `requireGatewayPermission` allows.
 */
export const getTunnels = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireEligibleResourceUser()
    const result = await loadTunnels()
    if (isPlatformAdmin(user)) return result
    const grants = await listUserGrants(user.id)
    const relayPermissions = (relayId: string) => {
      const held = effectiveScopePermissions(grants, {
        relayId,
        resourceId: relayId,
        resourceType: "relay",
      })
      return held.has("instance.read")
        ? gatewayPermissions.filter((permission) => held.has(permission))
        : null
    }
    const tunnels = result.tunnels.flatMap((tunnel): Array<TunnelOverview> => {
      if (tunnel.ownerId === user.id) {
        return [{ ...tunnel, access: { ...tunnel.access, manage: true } }]
      }
      const permissions: Record<string, ReadonlyArray<AccessPermission>> = {}
      for (const gateway of tunnel.gateways) {
        const held = relayPermissions(gateway.relayId)
        if (held) permissions[gateway.id] = held
      }
      const gateways = tunnel.gateways.filter(
        ({ id }) => permissions[id] !== undefined
      )
      if (gateways.length === 0) return []
      const relays = new Set(gateways.map(({ relayId }) => relayId))
      const bindings = tunnel.bindings.filter(({ relayId }) =>
        relays.has(relayId)
      )
      const members = new Set(bindings.map(({ memberId }) => memberId))
      return [
        {
          ...tunnel,
          access: { gateways: permissions, manage: false },
          bindings,
          gateways,
          // Its Tailscale login is for those who change the tunnel.
          integration: null,
          names: tunnel.names.filter(({ memberId }) => members.has(memberId)),
        },
      ]
    })
    // Only the Relays of the tunnels the viewer sees.
    const relays = new Set(
      tunnels.flatMap(({ gateways }) => gateways.map(({ relayId }) => relayId))
    )
    return {
      tunnels,
      unavailableRelays: result.unavailableRelays.filter(({ id }) =>
        relays.has(id)
      ),
    }
  }
)

// The Bricks a gateway can be made from, for whoever is asked which.
export const getTunnelBricks = createServerFn({ method: "GET" }).handler(
  async () => {
    await requireEligibleResourceUser()
    return tunnelBricks()
  }
)

export const createTunnel = createServerFn({ method: "POST" })
  .validator(createTunnelSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    return runOperationPromise(
      createTunnelOperation,
      { ...data, id: await reserveInstanceId("tunnel") },
      { user }
    )
  })

export const configureTailscaleIntegration = createServerFn({ method: "POST" })
  .validator(configureTailscaleIntegrationSchema)
  .handler(async ({ data }) =>
    runOperationPromise(configureTailscaleIntegrationOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const previewTailscaleIntegration = createServerFn({ method: "POST" })
  .validator(previewTailscaleIntegrationSchema)
  .handler(async ({ data }) => {
    await requireTailscaleAdministrator()
    const result = await loadTunnels()
    requireCompleteGatewayList(result.unavailableRelays)
    const stack = result.tunnels.find(({ id }) => id === data.id)
    if (!stack) throw new Error("Tunnel not found")
    const verified = await runAppEffect(
      "tailscale.oauth.verify",
      verifyTailscaleOAuthCredentialEffect(data.clientId, data.clientSecret, [
        data.tag,
      ])
    )
    const credential = {
      ...verified,
      clientSecret: data.clientSecret,
    } satisfies TailscaleOAuthCredential
    return {
      credential: verified,
      inspection: await inspectTailscaleControlPlane(
        credential,
        { ...stack, domains: data.domains },
        stack.domains
      ),
    }
  })

export const getTailscaleIntegrationStatus = createServerFn({ method: "GET" })
  .validator(syncTailscaleIntegrationSchema)
  .handler(async ({ data }) => {
    await requireTailscaleAdministrator()
    const [credential, result] = await Promise.all([
      loadTunnelCredential(data.id),
      loadTunnels(),
    ])
    requireCompleteGatewayList(result.unavailableRelays)
    const stack = result.tunnels.find(({ id }) => id === data.id)
    if (!stack) throw new Error("Tunnel not found")
    return {
      inspection: await inspectTailscaleControlPlane(credential, stack),
      result,
    }
  })

export const syncTailscaleIntegration = createServerFn({ method: "POST" })
  .validator(syncTailscaleIntegrationSchema)
  .handler(async ({ data }) =>
    runOperationPromise(syncTailscaleIntegrationOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const saveTunnel = createServerFn({ method: "POST" })
  .validator(saveTunnelSchema)
  .handler(async ({ data }) =>
    runOperationPromise(saveTunnelOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

/**
 * Connects a game server, an App's service or a database to a tunnel, or
 * disconnects it. It connects through the tunnel's gateway on its Relay,
 * made as it connects if the tunnel has none there, which waits on
 * Tailscale; the gateway goes when the last thing on its Relay leaves. It
 * takes changing the member's network and managing the tunnel.
 */
export const connectToTunnel = createServerFn({ method: "POST" })
  .validator(tunnelConnectionSchema)
  .handler(async ({ data }) =>
    runOperationPromise(connectTunnelOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

/** Gives a connected member another name in its tunnel. */
export const addTunnelAlias = createServerFn({ method: "POST" })
  .validator(tunnelAliasSchema)
  .handler(async ({ data }) =>
    runOperationPromise(addTunnelAliasOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

/** Takes away one of a member's aliases. Its generated name stays. */
export const removeTunnelAlias = createServerFn({ method: "POST" })
  .validator(removeTunnelAliasSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const name = await runAppEffect(
      "tunnelNames.load",
      loadTunnelNameEffect(data.id)
    )
    if (!name) throw new Error("That name is gone")
    return runOperationPromise(
      removeTunnelAliasOperation,
      { ...data, tunnelId: name.tunnelId },
      { user }
    )
  })

/**
 * Makes one of a game server's or an App's names in a tunnel its primary
 * address, in place of its join address or domain. A database has none.
 */
export const setPrimaryTunnelName = createServerFn({ method: "POST" })
  .validator(primaryTunnelNameSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const name = await runAppEffect(
      "tunnelNames.load",
      loadTunnelNameEffect(data.id)
    )
    if (!name) throw new Error("That name is gone")
    return runOperationPromise(
      setPrimaryTunnelNameOperation,
      { ...data, tunnelId: name.tunnelId },
      { user }
    )
  })

export const removeTunnel = createServerFn({ method: "POST" })
  .validator(removeTunnelSchema)
  .handler(async ({ data }) =>
    runOperationPromise(removeTunnelOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )
