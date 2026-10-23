import { createServerFn } from "@tanstack/react-start"
import { Effect } from "effect"
import {
  relayConnectionSettingsSchema,
  relayIdSchema as relayFingerprintSchema,
  relayNameSchema,
  relayHostAccessSchema,
  relayProxyDiagnosticsSchema,
  relayProxyModeSchema,
  relayProxySettingsSchema,
  relayTailscaleInstallSchema,
  relayTailscaleOverviewSchema,
  relayTailscaleSettingsSchema,
} from "@workspace/contracts"
import { z } from "zod"

import { resolveMinecraftProfileEffect } from "@/effect/minecraft-profile"
import { listInvitedRelaysEffect } from "@/server/invited-relays.server"
import {
  attachRelayOwnersEffect,
  type RelayOwnerFields,
} from "@/effect/relay-owners"
import {
  isPlatformAdmin,
  isRelayCreator,
  listUserGrants,
} from "@/lib/access-control"
import {
  relayScope,
  resolveScopeAuthorization,
  type ScopeAuthorization,
} from "@/lib/scope-authorization.server"
import {
  permissionsForRelayClientPolicy,
  type AccessPermission,
} from "@workspace/contracts"
import { grantHasPermission } from "@/lib/permissions"
import { runAppEffect } from "@/effect/runtime"
import {
  isMinecraftUsername,
  minecraftUsernameKey,
} from "@/lib/minecraft-profile"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { requireEligibleResourceUser } from "@/server/auth"
import { removeRelayThenCleanup } from "@/server/relay-removal"

export type ManagedRelay = PersistedRelay & RelayOwnerFields

export interface RelayOwnerMinecraftProfile {
  displayName: string
  profileId: string
}

const relayIdSchema = z.object({
  id: relayFingerprintSchema,
})
const relayEnabledSchema = relayIdSchema.extend({ enabled: z.boolean() })
const removeRelaySchema = relayIdSchema.extend({
  forgetBackups: z.boolean().default(true),
  removeVanityDomains: z.boolean().default(true),
})
const relayProxyInputSchema = relayProxySettingsSchema.extend({
  relayId: relayFingerprintSchema,
})
const relayProxyResponseSchema = z.object({
  diagnostics: relayProxyDiagnosticsSchema,
  settings: relayProxySettingsSchema,
})
const relayTailscaleInputSchema = relayTailscaleSettingsSchema.extend({
  relayId: relayFingerprintSchema,
})
const relayTailscaleInstallInputSchema = relayTailscaleInstallSchema.extend({
  relayId: relayFingerprintSchema,
})
const relayRoleSchema = z.enum(["custom", "full_access", "read_only"])
const createRelaySchema = z.object({
  pairingUri: z.string().trim().min(64).max(32_768),
})
const updateRelaySchema = relayIdSchema.extend(
  relayConnectionSettingsSchema.shape
)
const renameRelaySchema = z.object({
  name: relayNameSchema,
  relayId: relayFingerprintSchema,
})
const pairingRoleSchema = z.object({
  relayId: relayFingerprintSchema,
  role: z.enum(["full_access", "read_only"]),
})
const relayInvitationSchema = z.object({
  invitationId: z.uuid(),
  relayId: relayFingerprintSchema,
})
const relayClientSchema = z.object({
  clientId: z.string().min(1).max(128),
  relayId: relayFingerprintSchema,
})
const updateRelayClientSchema = relayClientSchema.extend({
  actions: z.array(z.string().min(1).max(120)).max(128).optional(),
  name: z.string().trim().min(1).max(120),
  role: relayRoleSchema,
  sourceCidrs: z.array(z.string().trim().min(1).max(128)).max(16),
})
const previewPairingSchema = z.object({
  pairingUri: z.string().trim().min(64).max(32_768),
})

async function requireRelayCreationAccess() {
  const user = await requireEligibleResourceUser()
  if (!isPlatformAdmin(user) && !isRelayCreator(user)) {
    throw new Error("Relay creator or platform administrator access required")
  }
  return user
}

/** Resolve Relay-wide authority once so later checks stay local to the set. */
async function authorizeRelayAdministration(
  relayId: string,
  permission: AccessPermission = "relay.configure"
) {
  const user = await requireEligibleResourceUser()
  const authorization = await resolveScopeAuthorization({
    scope: relayScope(relayId),
    user,
  })
  authorization.require(permission)
  return { authorization, user }
}

async function requireRelayAdministrator(
  relayId: string,
  permission: AccessPermission = "relay.configure"
) {
  return (await authorizeRelayAdministration(relayId, permission)).user
}

async function enabledRelay(relayId: string): Promise<PersistedRelay> {
  const { activeRelay } = await import("@/lib/relay-registry")
  return activeRelay(relayId)
}

async function managedRelays(
  user: Awaited<ReturnType<typeof requireEligibleResourceUser>>,
  relayId?: string
): Promise<Array<PersistedRelay>> {
  const { listPersistedRelays } = await import("@/lib/relay-registry")
  const relays = await listPersistedRelays()
  if (isPlatformAdmin(user)) {
    return relayId ? relays.filter((relay) => relay.id === relayId) : relays
  }
  const grants = await listUserGrants(user.id, relayId)
  return relays.filter(
    (relay) =>
      (!relayId || relay.id === relayId) &&
      grants.some(
        (grant) =>
          grant.relayId === relay.id &&
          grant.resourceType === "relay" &&
          grantHasPermission(grant, "relay.read")
      )
  )
}

export const getRelays = createServerFn({ method: "GET" }).handler(async () => {
  const user = await requireEligibleResourceUser()
  return attachRelayOwners(await managedRelays(user), isPlatformAdmin(user))
})

export const getRelayOwnerMinecraftProfiles = createServerFn({
  method: "GET",
}).handler(async () => {
  const user = await requireEligibleResourceUser()
  // Only stored display names reach Mojang, never email-derived fallbacks.
  // Pending Relay invitations show their owner too.
  const [relays, invitedRelays] = await Promise.all([
    managedRelays(user).then((managed) => attachRelayOwners(managed, false)),
    runAppEffect(
      "resourceInvitations.invitedRelays",
      listInvitedRelaysEffect(user.id, false)
    ),
  ])
  const displayNames = [
    ...new Map(
      [...relays, ...invitedRelays].flatMap((relay) =>
        relay.ownerName && isMinecraftUsername(relay.ownerName)
          ? [[minecraftUsernameKey(relay.ownerName), relay.ownerName] as const]
          : []
      )
    ).values(),
  ]
  const profiles = await runAppEffect(
    "minecraft.relayOwnerProfiles.resolve",
    Effect.forEach(
      displayNames,
      (displayName) =>
        resolveMinecraftProfileEffect(displayName).pipe(
          Effect.map((profile) =>
            profile
              ? ({
                  displayName,
                  profileId: profile.id,
                } satisfies RelayOwnerMinecraftProfile)
              : null
          ),
          Effect.catch(() => Effect.succeed(null))
        ),
      { concurrency: 4 }
    )
  )
  return profiles.filter(
    (profile): profile is RelayOwnerMinecraftProfile => profile !== null
  )
})

export const addRelay = createServerFn({ method: "POST" })
  .validator(createRelaySchema)
  .handler(async ({ data }) => {
    const user = await requireRelayCreationAccess()
    const { pairPersistedRelay, previewPairingUri } =
      await import("@/lib/relay-registry")
    const preview = await previewPairingUri(data.pairingUri)
    if (preview.mode === "repair") {
      await requireRelayAdministrator(preview.relayFingerprint)
    }
    const relay = await pairPersistedRelay(data.pairingUri, {
      canManageAnyRelay: isPlatformAdmin(user),
      userId: user.id,
    })
    return (await attachRelayOwners([relay], isPlatformAdmin(user)))[0]!
  })

function attachRelayOwners(
  relays: Array<PersistedRelay>,
  includeOwnerDetails: boolean
): Promise<Array<ManagedRelay>> {
  return runAppEffect(
    "relays.owners.attach",
    attachRelayOwnersEffect(relays, includeOwnerDetails)
  )
}

export const updateRelay = createServerFn({ method: "POST" })
  .validator(updateRelaySchema)
  .handler(async ({ data }) => {
    await requireRelayAdministrator(data.id)
    const { updatePersistedRelay } = await import("@/lib/relay-registry")
    return updatePersistedRelay(data)
  })

export const checkRelay = createServerFn({ method: "POST" })
  .validator(relayIdSchema)
  .handler(async ({ data }) => {
    await requireRelayAdministrator(data.id, "relay.read")
    const { checkPersistedRelay } = await import("@/lib/relay-registry")
    return checkPersistedRelay(data.id)
  })

export const setRelayEnabled = createServerFn({ method: "POST" })
  .validator(relayEnabledSchema)
  .handler(async ({ data }) => {
    await requireRelayAdministrator(data.id, "relay.pause")
    const { setPersistedRelayEnabled } = await import("@/lib/relay-registry")
    return setPersistedRelayEnabled(data.id, data.enabled)
  })

export const removeRelay = createServerFn({ method: "POST" })
  .validator(removeRelaySchema)
  .handler(async ({ data }) => {
    await requireRelayAdministrator(data.id, "relay.delete")
    const { deletePersistedRelay } = await import("@/lib/relay-registry")
    return removeRelayThenCleanup(
      {
        forgetBackups: data.forgetBackups,
        relayId: data.id,
        removeVanityDomains: data.removeVanityDomains,
      },
      {
        deleteRelay: () => deletePersistedRelay(data.id),
        forgetBackups: async () => {
          const { forgetRelayBackupsEffect } = await import("@/effect/backups")
          return runAppEffect(
            "backups.forgetRelay",
            forgetRelayBackupsEffect(data.id)
          )
        },
        removeManagedDomains: async () => {
          const { removeRelayManagedDomainsEffect } =
            await import("@/server/domains.server")
          return runAppEffect(
            "domains.relay.removeAssignments",
            removeRelayManagedDomainsEffect(data.id, data.removeVanityDomains)
          )
        },
      }
    )
  })

export const previewRelayPairing = createServerFn({ method: "POST" })
  .validator(previewPairingSchema)
  .handler(async ({ data }) => {
    const { previewPairingUri } = await import("@/lib/relay-registry")
    await requireRelayCreationAccess()
    const preview = await previewPairingUri(data.pairingUri)
    if (preview.mode === "repair") {
      await requireRelayAdministrator(preview.relayFingerprint)
    }
    return preview
  })

export const getRelayAdministration = createServerFn({ method: "GET" })
  .validator(relayIdSchema)
  .handler(async ({ data }) => {
    const { authorization } = await authorizeRelayAdministration(
      data.id,
      "relay.connections.read"
    )
    const registry = await import("@/lib/relay-registry")
    const administration = await registry.getRelayAdministration(data.id)
    return {
      ...administration,
      audits: authorization.allows("relay.audit.read")
        ? administration.audits
        : [],
    }
  })

export const createRelayInvitation = createServerFn({ method: "POST" })
  .validator(pairingRoleSchema)
  .handler(async ({ data }) => {
    const { authorization, user } = await authorizeRelayAdministration(
      data.relayId,
      "relay.connections.manage"
    )
    const { createRelayPairingInvitation } =
      await import("@/lib/relay-registry")
    requireMachineClientDelegation(authorization, data.role)
    return createRelayPairingInvitation(data, user.id)
  })

export const revokeRelayInvitation = createServerFn({ method: "POST" })
  .validator(relayInvitationSchema)
  .handler(async ({ data }) => {
    const user = await requireRelayAdministrator(
      data.relayId,
      "relay.connections.manage"
    )
    const { revokeRelayPairingInvitation } =
      await import("@/lib/relay-registry")
    return { revoked: await revokeRelayPairingInvitation(data, user.id) }
  })

export const updateRelayClient = createServerFn({ method: "POST" })
  .validator(updateRelayClientSchema)
  .handler(async ({ data }) => {
    const { authorization, user } = await authorizeRelayAdministration(
      data.relayId,
      "relay.connections.manage"
    )
    const { updateRelayClientPolicy, getRelayAdministration } =
      await import("@/lib/relay-registry")
    const actions =
      data.actions ??
      (data.role === "custom"
        ? ((await getRelayAdministration(data.relayId)).clients.find(
            (client) => client.id === data.clientId
          )?.actions ?? [])
        : [])
    requireMachineClientDelegation(authorization, data.role, actions)
    return updateRelayClientPolicy({ ...data, actions }, user.id)
  })

export const revokeHearthClient = createServerFn({ method: "POST" })
  .validator(relayClientSchema)
  .handler(async ({ data }) => {
    const user = await requireRelayAdministrator(
      data.relayId,
      "relay.connections.manage"
    )
    const { revokeRelayClient } = await import("@/lib/relay-registry")
    return { revoked: await revokeRelayClient(data, user.id) }
  })

export const renameRelay = createServerFn({ method: "POST" })
  .validator(renameRelaySchema)
  .handler(async ({ data }) => {
    const user = await requireRelayAdministrator(data.relayId)
    const { renamePersistedRelay } = await import("@/lib/relay-registry")
    return renamePersistedRelay(data, user.id)
  })

export const getRelayProxy = createServerFn({ method: "GET" })
  .validator(relayIdSchema)
  .handler(async ({ data }) => {
    await requireRelayAdministrator(data.id, "relay.read")
    const [relay, { relayRpc }] = await Promise.all([
      enabledRelay(data.id),
      import("@/lib/relay-connection"),
    ])
    return relayProxyResponseSchema.parse(
      await relayRpc(relay, "relay.proxy.read", {}, 15_000)
    )
  })

// Every web route the Relay's proxy serves that the user may see, for the
// infrastructure map. Null from Relays that predate it.
export const getRelayWebRoutes = createServerFn({ method: "GET" })
  .validator(relayIdSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const { relayWebRoutesHandler } = await import(
      "@/server/relay-web-routes.server"
    )
    return relayWebRoutesHandler(user, data.id)
  })

// Files the Info page opens in the Relay's host files: its database, and the
// bundled Traefik's config in that mode. Paths are relative to the host's
// root, as the Files tab's are. Each is pinned there the first time. Null
// from older Relays. Both reads need only relay.read on the Relay, so a
// connection that can browse host files can always find these.
export const getRelayHostFiles = createServerFn({ method: "GET" })
  .validator(relayIdSchema)
  .handler(async ({ data }) => {
    await requireRelayAdministrator(data.id, "relay.files.read")
    const [relay, { relayRpc }] = await Promise.all([
      enabledRelay(data.id),
      import("@/lib/relay-connection"),
    ])
    const [{ dataDirectory }, proxy] = await Promise.all([
      relayRpc(relay, "relay.host.read", {}, 15_000).then((value) =>
        relayHostAccessSchema.parse(value)
      ),
      relayRpc(
        relay,
        "relay.proxy.read",
        { includeDiagnostics: false },
        15_000
      ).then((value) => relayProxyModeReadSchema.parse(value)),
    ])
    if (!dataDirectory) return { database: null, traefikConfig: null }
    const root = dataDirectory.replace(/^\/+/u, "")
    const mode = proxy.mode ?? proxy.settings?.mode
    const files = {
      database: `${root}/network/relay.sqlite`,
      traefikConfig:
        mode === "traefik"
          ? `${root}/infrastructure/traefik/traefik.yaml`
          : null,
    }
    const { pinFilesByDefault } = await import("@/lib/file-activity")
    const pinned = await pinFilesByDefault(
      relay.id,
      relay.id,
      [files.database, files.traefikConfig].filter((path) => path !== null)
    )
    if (pinned) {
      publishRealtimeChange({
        audience: { kind: "relays", relayIds: [relay.id] },
        scope: { instanceId: relay.id, relayId: relay.id },
        topics: ["file-activity"],
        type: "hearth.invalidate",
      })
    }
    return files
  })

// Relays answer with just the mode when asked without diagnostics; ones that
// predate that option send the full settings.
const relayProxyModeReadSchema = z.object({
  mode: relayProxyModeSchema.optional(),
  settings: z.object({ mode: relayProxyModeSchema }).optional(),
})

export const updateRelayProxy = createServerFn({ method: "POST" })
  .validator(relayProxyInputSchema)
  .handler(async ({ data }) => {
    const user = await requireRelayAdministrator(data.relayId)
    const [relay, { relayRpc }] = await Promise.all([
      enabledRelay(data.relayId),
      import("@/lib/relay-connection"),
    ])
    const settings = relayProxySettingsSchema.parse({
      acmeEmail: data.acmeEmail,
      mode: data.mode,
      traefikImage: data.traefikImage,
    })
    const proxy = relayProxyResponseSchema.parse(
      await relayRpc(relay, "relay.proxy.write", settings, 240_000, user.id)
    )
    publishRelayProxyChange(relay.id)
    return proxy
  })

export const getRelayTailscale = createServerFn({ method: "GET" })
  .validator(relayIdSchema)
  .handler(async ({ data }) => {
    await requireRelayAdministrator(data.id, "relay.configure")
    const [relay, { relayRpc }] = await Promise.all([
      enabledRelay(data.id),
      import("@/lib/relay-connection"),
    ])
    return relayTailscaleOverviewSchema.parse(
      await relayRpc(relay, "relay.tailscale.read", {}, 15_000)
    )
  })

export const updateRelayTailscale = createServerFn({ method: "POST" })
  .validator(relayTailscaleInputSchema)
  .handler(async ({ data }) => {
    const user = await requireRelayAdministrator(data.relayId)
    const [relay, { relayRpc }] = await Promise.all([
      enabledRelay(data.relayId),
      import("@/lib/relay-connection"),
    ])
    const settings = relayTailscaleSettingsSchema.parse({
      dnsPort: data.dnsPort,
      domain: data.domain,
      hostname: data.hostname,
    })
    const tailscale = relayTailscaleOverviewSchema.parse(
      await relayRpc(relay, "relay.tailscale.write", settings, 90_000, user.id)
    )
    publishRelayTailscaleChange(relay.id)
    return tailscale
  })

export const installRelayTailscale = createServerFn({ method: "POST" })
  .validator(relayTailscaleInstallInputSchema)
  .handler(async ({ data }) => {
    const user = await requireRelayAdministrator(data.relayId)
    const [relay, { relayRpc }] = await Promise.all([
      enabledRelay(data.relayId),
      import("@/lib/relay-connection"),
    ])
    const input = relayTailscaleInstallSchema.parse({ authKey: data.authKey })
    const tailscale = relayTailscaleOverviewSchema.parse(
      await relayRpc(relay, "relay.tailscale.install", input, 240_000, user.id)
    )
    publishRelayTailscaleChange(relay.id)
    return tailscale
  })

function publishRelayProxyChange(relayId: string): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: { relayId },
    topics: ["relay-proxy"],
    type: "hearth.invalidate",
  })
}

function publishRelayTailscaleChange(relayId: string): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: { relayId },
    topics: ["tailscale"],
    type: "hearth.invalidate",
  })
}

/** A machine client can operate directly against every child, so delegation uses Relay-wide authority. */
function requireMachineClientDelegation(
  authorization: ScopeAuthorization,
  role: "custom" | "full_access" | "read_only",
  actions: readonly string[] = []
): void {
  const required = permissionsForRelayClientPolicy(role, actions)
  if ([...required].some((permission) => !authorization.allows(permission)))
    throw new Error("The client policy exceeds your permissions on this Relay")
}
