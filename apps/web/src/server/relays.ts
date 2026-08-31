import { createServerFn } from "@tanstack/react-start"
import type { RowDataPacket } from "mysql2/promise"
import {
  relayConnectionSettingsSchema,
  relayIdSchema as relayFingerprintSchema,
  relayNameSchema,
  relayProxyDiagnosticsSchema,
  relayProxySettingsSchema,
  relayTailscaleInstallSchema,
  relayTailscaleOverviewSchema,
  relayTailscaleSettingsSchema,
} from "@workspace/contracts"
import { z } from "zod"

import { isPlatformAdmin, isRelayCreator } from "@/lib/access-control"
import { runAppEffect } from "@/effect/runtime"
import { databasePool } from "@/lib/database"
import { databaseTable } from "@/lib/database-config"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { requireAuthenticatedUser } from "@/server/auth"
import { removeRelayThenCleanup } from "@/server/relay-removal"

export interface ManagedRelay extends PersistedRelay {
  ownerEmail: string | null
  ownerName: string | null
}

interface RelayOwnerRow extends RowDataPacket {
  email: string
  id: string
  name: string
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
  const user = await requireAuthenticatedUser()
  if (!isPlatformAdmin(user) && !isRelayCreator(user)) {
    throw new Error("Relay creator or platform administrator access required")
  }
  return user
}

async function requireRelayAdministrator(relayId: string) {
  const user = await requireAuthenticatedUser()
  if (isPlatformAdmin(user)) return user
  const relay = (await managedRelays(user, relayId))[0]
  if (!relay) {
    throw new Error("You can only manage Relays you created")
  }
  return user
}

async function managedRelays(
  user: Awaited<ReturnType<typeof requireAuthenticatedUser>>,
  relayId?: string
): Promise<Array<PersistedRelay>> {
  const { listPersistedRelays } = await import("@/lib/relay-registry")
  const relays = await listPersistedRelays()
  if (isPlatformAdmin(user)) {
    return relayId ? relays.filter((relay) => relay.id === relayId) : relays
  }
  if (!isRelayCreator(user)) {
    throw new Error("Relay creator or platform administrator access required")
  }
  return relays.filter(
    (relay) => relay.createdBy === user.id && (!relayId || relay.id === relayId)
  )
}

export const getRelays = createServerFn({ method: "GET" }).handler(async () => {
  const user = await requireRelayCreationAccess()
  return attachRelayOwners(await managedRelays(user))
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
    return (await attachRelayOwners([relay]))[0]!
  })

async function attachRelayOwners(
  relays: Array<PersistedRelay>
): Promise<Array<ManagedRelay>> {
  const ownerIds = [
    ...new Set(
      relays.flatMap((relay) => (relay.createdBy ? [relay.createdBy] : []))
    ),
  ]
  if (ownerIds.length === 0) {
    return relays.map((relay) => ({
      ...relay,
      ownerEmail: null,
      ownerName: null,
    }))
  }
  const placeholders = ownerIds.map(() => "?").join(", ")
  const [owners] = await databasePool.query<Array<RelayOwnerRow>>(
    `SELECT id, name, email FROM ${databaseTable("user")} WHERE id IN (${placeholders})`,
    ownerIds
  )
  const ownersById = new Map(owners.map((owner) => [owner.id, owner]))
  return relays.map((relay) => ({
    ...relay,
    ownerEmail: relay.createdBy
      ? (ownersById.get(relay.createdBy)?.email ?? null)
      : null,
    ownerName: relay.createdBy
      ? (ownersById.get(relay.createdBy)?.name ?? null)
      : null,
  }))
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
    await requireRelayAdministrator(data.id)
    const { checkPersistedRelay } = await import("@/lib/relay-registry")
    return checkPersistedRelay(data.id)
  })

export const setRelayEnabled = createServerFn({ method: "POST" })
  .validator(relayEnabledSchema)
  .handler(async ({ data }) => {
    await requireRelayAdministrator(data.id)
    const { setPersistedRelayEnabled } = await import("@/lib/relay-registry")
    return setPersistedRelayEnabled(data.id, data.enabled)
  })

export const removeRelay = createServerFn({ method: "POST" })
  .validator(removeRelaySchema)
  .handler(async ({ data }) => {
    await requireRelayAdministrator(data.id)
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
    await requireRelayAdministrator(data.id)
    const registry = await import("@/lib/relay-registry")
    return registry.getRelayAdministration(data.id)
  })

export const createRelayInvitation = createServerFn({ method: "POST" })
  .validator(pairingRoleSchema)
  .handler(async ({ data }) => {
    const user = await requireRelayAdministrator(data.relayId)
    const { createRelayPairingInvitation } =
      await import("@/lib/relay-registry")
    return createRelayPairingInvitation(data, user.id)
  })

export const revokeRelayInvitation = createServerFn({ method: "POST" })
  .validator(relayInvitationSchema)
  .handler(async ({ data }) => {
    const user = await requireRelayAdministrator(data.relayId)
    const { revokeRelayPairingInvitation } =
      await import("@/lib/relay-registry")
    return { revoked: await revokeRelayPairingInvitation(data, user.id) }
  })

export const updateRelayClient = createServerFn({ method: "POST" })
  .validator(updateRelayClientSchema)
  .handler(async ({ data }) => {
    const user = await requireRelayAdministrator(data.relayId)
    const { updateRelayClientPolicy } = await import("@/lib/relay-registry")
    return updateRelayClientPolicy(data, user.id)
  })

export const revokeHearthClient = createServerFn({ method: "POST" })
  .validator(relayClientSchema)
  .handler(async ({ data }) => {
    const user = await requireRelayAdministrator(data.relayId)
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
    await requireRelayAdministrator(data.id)
    const [{ listPersistedRelays }, { relayRpc }] = await Promise.all([
      import("@/lib/relay-registry"),
      import("@/lib/relay-connection"),
    ])
    const relay = (await listPersistedRelays()).find(
      (candidate) => candidate.enabled && candidate.id === data.id
    )
    if (!relay) throw new Error("Relay is not configured or is paused")
    return relayProxyResponseSchema.parse(
      await relayRpc(relay, "relay.proxy.read", {}, 15_000)
    )
  })

export const updateRelayProxy = createServerFn({ method: "POST" })
  .validator(relayProxyInputSchema)
  .handler(async ({ data }) => {
    const user = await requireRelayAdministrator(data.relayId)
    const [{ listPersistedRelays }, { relayRpc }] = await Promise.all([
      import("@/lib/relay-registry"),
      import("@/lib/relay-connection"),
    ])
    const relay = (await listPersistedRelays()).find(
      (candidate) => candidate.enabled && candidate.id === data.relayId
    )
    if (!relay) throw new Error("Relay is not configured or is paused")
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
    await requireRelayAdministrator(data.id)
    const [{ listPersistedRelays }, { relayRpc }] = await Promise.all([
      import("@/lib/relay-registry"),
      import("@/lib/relay-connection"),
    ])
    const relay = (await listPersistedRelays()).find(
      (candidate) => candidate.enabled && candidate.id === data.id
    )
    if (!relay) throw new Error("Relay is not configured or is paused")
    return relayTailscaleOverviewSchema.parse(
      await relayRpc(relay, "relay.tailscale.read", {}, 15_000)
    )
  })

export const updateRelayTailscale = createServerFn({ method: "POST" })
  .validator(relayTailscaleInputSchema)
  .handler(async ({ data }) => {
    const user = await requireRelayAdministrator(data.relayId)
    const [{ listPersistedRelays }, { relayRpc }] = await Promise.all([
      import("@/lib/relay-registry"),
      import("@/lib/relay-connection"),
    ])
    const relay = (await listPersistedRelays()).find(
      (candidate) => candidate.enabled && candidate.id === data.relayId
    )
    if (!relay) throw new Error("Relay is not configured or is paused")
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
    const [{ listPersistedRelays }, { relayRpc }] = await Promise.all([
      import("@/lib/relay-registry"),
      import("@/lib/relay-connection"),
    ])
    const relay = (await listPersistedRelays()).find(
      (candidate) => candidate.enabled && candidate.id === data.relayId
    )
    if (!relay) throw new Error("Relay is not configured or is paused")
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
