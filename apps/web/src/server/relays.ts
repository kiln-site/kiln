import { createServerFn } from "@tanstack/react-start"
import { Effect } from "effect"
import {
  relayConnectionSettingsSchema,
  relayIdSchema as relayFingerprintSchema,
  relayJoinIdPattern,
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

import { promiseEffect } from "@/effect/promise"
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
import type { AuthenticatedUser } from "@/lib/auth-session"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { exclusive, partKey, relayKey } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import { removeRelayThenCleanup } from "@/server/relay-removal"

export type ManagedRelay = PersistedRelay & RelayOwnerFields

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
  installation: z.enum(["keep", "use"]),
  pairingUri: z.string().trim().min(64).max(32_768),
})
const updateRelaySchema = relayIdSchema
  .extend(relayConnectionSettingsSchema.shape)
  .extend({ controlDial: z.enum(["hearth", "relay"]).optional() })
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

// The person an operation runs for, who may add Relays.
const relayCreator = (user: AuthenticatedUser | null) =>
  signedIn(user).pipe(
    Effect.filterOrFail(
      (person) => isPlatformAdmin(person) || isRelayCreator(person),
      () => new Error("Relay creator or platform administrator access required")
    )
  )

// The person an operation runs for and their authority on the Relay,
// resolved once so later checks stay local to the set.
const relayAdministration = (
  user: AuthenticatedUser | null,
  relayId: string,
  permission: AccessPermission = "relay.configure"
) =>
  signedIn(user).pipe(
    Effect.flatMap((person) =>
      promiseEffect(async () => {
        const authorization = await resolveScopeAuthorization({
          scope: relayScope(relayId),
          user: person,
        })
        authorization.require(permission)
        return { authorization, user: person }
      })
    )
  )

// One part of a Relay, for an operation's locks: its `settings` (name,
// pausing, connection), `proxy`, `tailscale`, or `connections`.
const relayPart = (relayId: string, part: string) =>
  partKey(relayKey(relayId), part)

const relayAudit = (relayId: string) => ({
  id: relayId,
  kind: "relay",
  relayId,
})

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

// Pairs a Relay, or repairs one Hearth has, which replaces its credentials.
const pairRelay = operation<z.infer<typeof createRelaySchema>>()({
  name: "relay.pair",
  doing: "Pairing this Relay",
  authorize: ({ input, user }) =>
    Effect.gen(function* () {
      const person = yield* relayCreator(user)
      const preview = yield* promiseEffect(async () => {
        const { previewPairingUri } = await import("@/lib/relay-registry")
        return previewPairingUri(input.pairingUri)
      })
      if (preview.mode === "repair") {
        yield* relayAdministration(person, preview.relayFingerprint)
      }
      return { relayId: preview.relayFingerprint, user: person }
    }),
  locks: ({ context }) => [exclusive(relayKey(context.relayId))],
  run: ({ context: { user }, input }) =>
    promiseEffect(async () => {
      const { pairPersistedRelay } = await import("@/lib/relay-registry")
      const { installationWarning, relay } = await pairPersistedRelay(
        input.pairingUri,
        {
          canManageAnyRelay: isPlatformAdmin(user),
          userId: user.id,
        },
        input.installation
      )
      return {
        installationWarning,
        relay: (await attachRelayOwners([relay], isPlatformAdmin(user)))[0]!,
      }
    }),
  audit: ({ context }) => relayAudit(context.relayId),
})

export const addRelay = createServerFn({ method: "POST" })
  .validator(createRelaySchema)
  .handler(async ({ data }) =>
    runOperationPromise(pairRelay, data, {
      user: await requireEligibleResourceUser(),
    })
  )

function attachRelayOwners(
  relays: Array<PersistedRelay>,
  includeOwnerDetails: boolean
): Promise<Array<ManagedRelay>> {
  return runAppEffect(
    "relays.owners.attach",
    attachRelayOwnersEffect(relays, includeOwnerDetails)
  )
}

const changeRelayConnection = operation<z.infer<typeof updateRelaySchema>>()({
  name: "relay.connection.update",
  doing: "Changing this Relay's settings",
  authorize: ({ input, user }) => relayAdministration(user, input.id),
  locks: ({ input }) => [exclusive(relayPart(input.id, "settings"))],
  run: ({ input }) =>
    promiseEffect(async () => {
      const { updatePersistedRelay } = await import("@/lib/relay-registry")
      return updatePersistedRelay(input)
    }),
  audit: ({ input }) => relayAudit(input.id),
})

export const updateRelay = createServerFn({ method: "POST" })
  .validator(updateRelaySchema)
  .handler(async ({ data }) =>
    runOperationPromise(changeRelayConnection, data, {
      user: await requireEligibleResourceUser(),
    })
  )

// Which side opened the Relay's control connection, while it's connected,
// and whether the Relay can open it itself.
export const getRelayConnection = createServerFn({ method: "GET" })
  .validator(relayIdSchema)
  .handler(async ({ data }) => {
    await requireRelayAdministrator(data.id, "relay.read")
    const [
      { relayConnectionDials, relayConnectionOpener },
      { relayPassthroughUsage },
    ] = await Promise.all([
      import("@/lib/relay-connection"),
      import("@/lib/relay-passthrough-limits.server"),
    ])
    return {
      openedBy: relayConnectionOpener(data.id),
      relayDials: relayConnectionDials(data.id),
      // What Hearth carried for it, for transfers browsers can't send it
      // directly, since Hearth started.
      throughHearth: relayPassthroughUsage(data.id),
    }
  })

export const checkRelay = createServerFn({ method: "POST" })
  .validator(relayIdSchema)
  .handler(async ({ data }) => {
    await requireRelayAdministrator(data.id, "relay.read")
    const { checkPersistedRelay } = await import("@/lib/relay-registry")
    return checkPersistedRelay(data.id)
  })

const changeRelayEnabled = operation<z.infer<typeof relayEnabledSchema>>()({
  name: "relay.enabled",
  doing: "Changing this Relay's settings",
  authorize: ({ input, user }) =>
    relayAdministration(user, input.id, "relay.pause"),
  locks: ({ input }) => [exclusive(relayPart(input.id, "settings"))],
  run: ({ input }) =>
    promiseEffect(async () => {
      const { setPersistedRelayEnabled } = await import("@/lib/relay-registry")
      return setPersistedRelayEnabled(input.id, input.enabled)
    }),
  audit: ({ input }) => relayAudit(input.id),
})

export const setRelayEnabled = createServerFn({ method: "POST" })
  .validator(relayEnabledSchema)
  .handler(async ({ data }) =>
    runOperationPromise(changeRelayEnabled, data, {
      user: await requireEligibleResourceUser(),
    })
  )

// Deletes the Relay holding it whole, so nothing else changes it
// meanwhile. Its domains and backups are let go of once it's gone.
const deleteRelay = operation<z.infer<typeof removeRelaySchema>>()({
  name: "relay.remove",
  doing: "Removing this Relay",
  authorize: ({ input, user }) =>
    relayAdministration(user, input.id, "relay.delete"),
  locks: ({ input }) => [exclusive(relayKey(input.id))],
  run: ({ input }) =>
    promiseEffect(async () => {
      const { deletePersistedRelay } = await import("@/lib/relay-registry")
      await deletePersistedRelay(input.id)
    }),
  audit: ({ input }) => relayAudit(input.id),
})

export const removeRelay = createServerFn({ method: "POST" })
  .validator(removeRelaySchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    return removeRelayThenCleanup(
      {
        forgetBackups: data.forgetBackups,
        relayId: data.id,
        removeVanityDomains: data.removeVanityDomains,
      },
      {
        deleteRelay: () => runOperationPromise(deleteRelay, data, { user }),
        forgetBackups: async () => {
          const { forgetRelayBackupsEffect } = await import("@/effect/backups")
          return runAppEffect(
            "backups.forgetRelay",
            forgetRelayBackupsEffect(data.id)
          )
        },
        // Each name goes under its resource's DNS lock.
        removeManagedDomains: async () => {
          const [
            { removeRelayManagedDomainsEffect },
            { removeRelayWebHostnamesEffect },
          ] = await Promise.all([
            import("@/server/domains.server"),
            import("@/server/web-hostnames.server"),
          ])
          // One after the other: each lets go of the Relay's names the
          // other no longer uses.
          const domains = await runAppEffect(
            "domains.relay.removeAssignments",
            removeRelayManagedDomainsEffect(data.id, data.removeVanityDomains)
          )
          const hostnames = await runAppEffect(
            "webHostnames.removeRelay",
            removeRelayWebHostnamesEffect(data.id, data.removeVanityDomains)
          )
          return domains + hostnames
        },
      }
    )
  })

const relayJoinIdSchema = z.object({
  joinId: z.string().regex(relayJoinIdPattern),
})
const confirmRelayJoinSchema = relayJoinIdSchema.extend({
  envelopeDigest: z.string().regex(/^[\da-f]{64}$/u),
  installation: z.enum(["keep", "use"]),
  name: z.string().trim().max(120).nullable(),
})

const relayJoins = () =>
  promiseEffect(() => import("@/server/relay-join.server"))

// A join is its person's alone until a Relay answers it, so opening or
// refreshing one changes nothing anyone else holds.
const openJoin = operation<
  z.infer<ReturnType<typeof relayJoinIdSchema.partial>>
>()({
  name: "relay.join.open",
  doing: "Preparing to add a Relay",
  authorize: ({ user }) => relayCreator(user),
  locks: () => [],
  run: ({ context: user, input }) =>
    relayJoins().pipe(
      Effect.flatMap(({ openRelayJoinEffect }) =>
        openRelayJoinEffect(user.id, input.joinId)
      )
    ),
})

/** The person's join for the Add Relay dialog's install command. */
export const openRelayJoin = createServerFn({ method: "POST" })
  .validator(relayJoinIdSchema.partial())
  .handler(async ({ data }) =>
    runOperationPromise(openJoin, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const getRelayJoin = createServerFn({ method: "GET" })
  .validator(relayJoinIdSchema)
  .handler(async ({ data }) => {
    const user = await requireRelayCreationAccess()
    const { relayJoinViewEffect } = await import("@/server/relay-join.server")
    return runAppEffect(
      "relay.join.get",
      relayJoinViewEffect(user.id, data.joinId)
    )
  })

const refreshJoin = operation<z.infer<typeof relayJoinIdSchema>>()({
  name: "relay.join.refresh",
  doing: "Preparing to add a Relay",
  authorize: ({ user }) => relayCreator(user),
  locks: () => [],
  run: ({ context: user, input }) =>
    relayJoins().pipe(
      Effect.flatMap(({ refreshRelayJoinEffect }) =>
        refreshRelayJoinEffect(user.id, input.joinId)
      )
    ),
})

export const refreshRelayJoin = createServerFn({ method: "POST" })
  .validator(relayJoinIdSchema)
  .handler(async ({ data }) =>
    runOperationPromise(refreshJoin, data, {
      user: await requireEligibleResourceUser(),
    })
  )

// Adds the Relay that answered the join, or replaces the credentials of one
// Hearth already has.
const confirmJoin = operation<z.infer<typeof confirmRelayJoinSchema>>()({
  name: "relay.join.confirm",
  doing: "Pairing this Relay",
  authorize: ({ input, user }) =>
    Effect.gen(function* () {
      const person = yield* relayCreator(user)
      const { relayJoinViewEffect } = yield* relayJoins()
      const join = yield* relayJoinViewEffect(person.id, input.joinId)
      const existing = join.announcement?.existingRelay
      if (existing) yield* relayAdministration(person, existing.id)
      return {
        relayId: join.announcement?.relayFingerprint ?? null,
        user: person,
      }
    }),
  locks: ({ context }) =>
    context.relayId ? [exclusive(relayKey(context.relayId))] : [],
  run: ({ context: { user }, input }) =>
    relayJoins().pipe(
      Effect.flatMap(({ confirmRelayJoinEffect }) =>
        confirmRelayJoinEffect({
          canManageAnyRelay: isPlatformAdmin(user),
          envelopeDigest: input.envelopeDigest,
          installation: input.installation,
          joinId: input.joinId,
          name: input.name,
          userId: user.id,
        })
      )
    ),
  audit: ({ context }) =>
    context.relayId ? relayAudit(context.relayId) : null,
})

export const confirmRelayJoin = createServerFn({ method: "POST" })
  .validator(confirmRelayJoinSchema)
  .handler(async ({ data }) =>
    runOperationPromise(confirmJoin, data, {
      user: await requireEligibleResourceUser(),
    })
  )

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

const inviteRelayClient = operation<z.infer<typeof pairingRoleSchema>>()({
  name: "relay.invitation.create",
  doing: "Changing this Relay's connections",
  authorize: ({ input, user }) =>
    relayAdministration(user, input.relayId, "relay.connections.manage"),
  locks: ({ input }) => [exclusive(relayPart(input.relayId, "connections"))],
  run: ({ context: { authorization, user }, input }) =>
    promiseEffect(async () => {
      const { createRelayPairingInvitation } =
        await import("@/lib/relay-registry")
      requireMachineClientDelegation(authorization, input.role)
      return createRelayPairingInvitation(input, user.id)
    }),
  audit: ({ input }) => relayAudit(input.relayId),
})

export const createRelayInvitation = createServerFn({ method: "POST" })
  .validator(pairingRoleSchema)
  .handler(async ({ data }) =>
    runOperationPromise(inviteRelayClient, data, {
      user: await requireEligibleResourceUser(),
    })
  )

const revokeInvitation = operation<z.infer<typeof relayInvitationSchema>>()({
  name: "relay.invitation.revoke",
  doing: "Changing this Relay's connections",
  authorize: ({ input, user }) =>
    relayAdministration(user, input.relayId, "relay.connections.manage"),
  locks: ({ input }) => [exclusive(relayPart(input.relayId, "connections"))],
  run: ({ context: { user }, input }) =>
    promiseEffect(async () => {
      const { revokeRelayPairingInvitation } =
        await import("@/lib/relay-registry")
      return { revoked: await revokeRelayPairingInvitation(input, user.id) }
    }),
  audit: ({ input }) => relayAudit(input.relayId),
})

export const revokeRelayInvitation = createServerFn({ method: "POST" })
  .validator(relayInvitationSchema)
  .handler(async ({ data }) =>
    runOperationPromise(revokeInvitation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

const changeClientPolicy = operation<z.infer<typeof updateRelayClientSchema>>()(
  {
    name: "relay.client.update",
    doing: "Changing this Relay's connections",
    authorize: ({ input, user }) =>
      relayAdministration(user, input.relayId, "relay.connections.manage"),
    locks: ({ input }) => [exclusive(relayPart(input.relayId, "connections"))],
    run: ({ context: { authorization, user }, input }) =>
      promiseEffect(async () => {
        const { updateRelayClientPolicy, getRelayAdministration } =
          await import("@/lib/relay-registry")
        const actions =
          input.actions ??
          (input.role === "custom"
            ? ((await getRelayAdministration(input.relayId)).clients.find(
                (client) => client.id === input.clientId
              )?.actions ?? [])
            : [])
        requireMachineClientDelegation(authorization, input.role, actions)
        return updateRelayClientPolicy({ ...input, actions }, user.id)
      }),
    audit: ({ input }) => relayAudit(input.relayId),
  }
)

export const updateRelayClient = createServerFn({ method: "POST" })
  .validator(updateRelayClientSchema)
  .handler(async ({ data }) =>
    runOperationPromise(changeClientPolicy, data, {
      user: await requireEligibleResourceUser(),
    })
  )

const revokeClient = operation<z.infer<typeof relayClientSchema>>()({
  name: "relay.client.revoke",
  doing: "Changing this Relay's connections",
  authorize: ({ input, user }) =>
    relayAdministration(user, input.relayId, "relay.connections.manage"),
  locks: ({ input }) => [exclusive(relayPart(input.relayId, "connections"))],
  run: ({ context: { user }, input }) =>
    promiseEffect(async () => {
      const { revokeRelayClient } = await import("@/lib/relay-registry")
      return { revoked: await revokeRelayClient(input, user.id) }
    }),
  audit: ({ input }) => relayAudit(input.relayId),
})

export const revokeHearthClient = createServerFn({ method: "POST" })
  .validator(relayClientSchema)
  .handler(async ({ data }) =>
    runOperationPromise(revokeClient, data, {
      user: await requireEligibleResourceUser(),
    })
  )

const changeRelayName = operation<z.infer<typeof renameRelaySchema>>()({
  name: "relay.rename",
  doing: "Changing this Relay's settings",
  authorize: ({ input, user }) => relayAdministration(user, input.relayId),
  locks: ({ input }) => [exclusive(relayPart(input.relayId, "settings"))],
  run: ({ context: { user }, input }) =>
    promiseEffect(async () => {
      const { renamePersistedRelay } = await import("@/lib/relay-registry")
      return renamePersistedRelay(input, user.id)
    }),
  audit: ({ input }) => relayAudit(input.relayId),
})

export const renameRelay = createServerFn({ method: "POST" })
  .validator(renameRelaySchema)
  .handler(async ({ data }) =>
    runOperationPromise(changeRelayName, data, {
      user: await requireEligibleResourceUser(),
    })
  )

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
    const { relayWebRoutesHandler } =
      await import("@/server/relay-web-routes.server")
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

const saveRelayProxy = operation<z.infer<typeof relayProxyInputSchema>>()({
  name: "relay.proxy.save",
  doing: "Changing this Relay's proxy",
  authorize: ({ input, user }) => relayAdministration(user, input.relayId),
  locks: ({ input }) => [exclusive(relayPart(input.relayId, "proxy"))],
  run: ({ context: { user }, input }) =>
    promiseEffect(async () => {
      const [relay, { relayRpc }] = await Promise.all([
        enabledRelay(input.relayId),
        import("@/lib/relay-connection"),
      ])
      const settings = relayProxySettingsSchema.parse({
        acmeEmail: input.acmeEmail,
        mode: input.mode,
        traefikImage: input.traefikImage,
      })
      return relayProxyResponseSchema.parse(
        await relayRpc(relay, "relay.proxy.write", settings, 240_000, user.id)
      )
    }),
  audit: ({ input }) => relayAudit(input.relayId),
  publish: ({ input }) => publishRelayProxyChange(input.relayId),
})

export const updateRelayProxy = createServerFn({ method: "POST" })
  .validator(relayProxyInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(saveRelayProxy, data, {
      user: await requireEligibleResourceUser(),
    })
  )

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

const saveRelayTailscale = operation<
  z.infer<typeof relayTailscaleInputSchema>
>()({
  name: "relay.tailscale.save",
  doing: "Changing this Relay's Tailscale",
  authorize: ({ input, user }) => relayAdministration(user, input.relayId),
  locks: ({ input }) => [exclusive(relayPart(input.relayId, "tailscale"))],
  run: ({ context: { user }, input }) =>
    promiseEffect(async () => {
      const [relay, { relayRpc }] = await Promise.all([
        enabledRelay(input.relayId),
        import("@/lib/relay-connection"),
      ])
      const settings = relayTailscaleSettingsSchema.parse({
        dnsPort: input.dnsPort,
        domain: input.domain,
        hostname: input.hostname,
      })
      return relayTailscaleOverviewSchema.parse(
        await relayRpc(
          relay,
          "relay.tailscale.write",
          settings,
          90_000,
          user.id
        )
      )
    }),
  audit: ({ input }) => relayAudit(input.relayId),
  publish: ({ input }) => publishRelayTailscaleChange(input.relayId),
})

export const updateRelayTailscale = createServerFn({ method: "POST" })
  .validator(relayTailscaleInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(saveRelayTailscale, data, {
      user: await requireEligibleResourceUser(),
    })
  )

const installTailscale = operation<
  z.infer<typeof relayTailscaleInstallInputSchema>
>()({
  name: "relay.tailscale.install",
  doing: "Changing this Relay's Tailscale",
  authorize: ({ input, user }) => relayAdministration(user, input.relayId),
  locks: ({ input }) => [exclusive(relayPart(input.relayId, "tailscale"))],
  run: ({ context: { user }, input }) =>
    promiseEffect(async () => {
      const [relay, { relayRpc }] = await Promise.all([
        enabledRelay(input.relayId),
        import("@/lib/relay-connection"),
      ])
      const install = relayTailscaleInstallSchema.parse({
        authKey: input.authKey,
      })
      return relayTailscaleOverviewSchema.parse(
        await relayRpc(
          relay,
          "relay.tailscale.install",
          install,
          240_000,
          user.id
        )
      )
    }),
  audit: ({ input }) => relayAudit(input.relayId),
  publish: ({ input }) => publishRelayTailscaleChange(input.relayId),
})

export const installRelayTailscale = createServerFn({ method: "POST" })
  .validator(relayTailscaleInstallInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(installTailscale, data, {
      user: await requireEligibleResourceUser(),
    })
  )

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
