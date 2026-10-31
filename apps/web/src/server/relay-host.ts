import { createServerFn } from "@tanstack/react-start"
import {
  relayHostAccessSchema,
  relayHostTerminalClaimSchema,
  relayHostTerminalWriteSchema,
  relayIdSchema,
  relayInstanceResourcesSchema,
  relayResourceHistoryMaxSamples,
  relayResourcesV1Feature,
  relayRestartV1Feature,
} from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import { promiseEffect } from "@/effect/promise"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import type { PersistedRelay } from "@/lib/relay-registry"
import { exclusive, partKey, relayKey } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import { databaseRpc, requiredRelay } from "@/server/managed-database-access"
import { authorizedRelay } from "@/server/relay-access"

const targetSchema = z.object({ relayId: relayIdSchema })
const restartHostSchema = targetSchema.extend({
  password: z.string().max(128),
})

// The person an operation runs for, who may `permission` on the Relay.
const relayFor = (
  user: AuthenticatedUser | null,
  relayId: string,
  permission: AccessPermission
) =>
  signedIn(user).pipe(
    Effect.flatMap((person) =>
      promiseEffect(async () => {
        await requireRelayPermission({ permission, relayId, user: person })
        return { relay: await requiredRelay(relayId), user: person }
      })
    )
  )

const relayAudit = (relayId: string) => ({
  id: relayId,
  kind: "relay",
  relayId,
})

// Restarting the Relay or its host, and updating it, replace or stop its
// process, so they take the same part of it.
const relayProcess = (relayId: string) =>
  exclusive(partKey(relayKey(relayId), "process"))

export const getRelayHostAccess = createServerFn({ method: "GET" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    const { relay } = await authorizedRelay(data.relayId, "relay.read")
    return relayHostAccessSchema.parse(
      await databaseRpc(relay, "relay.host.read", {}, 15_000)
    )
  })

const mountHostFiles = operation<z.infer<typeof targetSchema>>()({
  name: "relay.hostFiles.mount",
  doing: "Opening this Relay's host files",
  authorize: ({ input, user }) =>
    relayFor(user, input.relayId, "relay.files.mount"),
  locks: ({ input }) => [
    exclusive(partKey(relayKey(input.relayId), "host-files")),
  ],
  run: ({ context: { relay, user } }) =>
    promiseEffect(() =>
      databaseRpc(relay, "relay.host.files.mount", {}, 60_000, user.id)
    ).pipe(Effect.as({ started: true })),
  audit: ({ input }) => relayAudit(input.relayId),
})

export const mountRelayHostFiles = createServerFn({ method: "POST" })
  .validator(targetSchema)
  .handler(async ({ data }) =>
    runOperationPromise(mountHostFiles, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const writeRelayTerminal = createServerFn({ method: "POST" })
  .validator(relayHostTerminalWriteSchema.extend(targetSchema.shape))
  .handler(async ({ data: { relayId, ...input } }) => {
    const { relay, user } = await authorizedRelay(relayId, "relay.terminal")
    await databaseRpc(relay, "relay.terminal.write", input, 15_000, user.id)
    return { accepted: true }
  })

export const claimRelayTerminal = createServerFn({ method: "POST" })
  .validator(relayHostTerminalClaimSchema.extend(targetSchema.shape))
  .handler(async ({ data: { relayId, ...input } }) => {
    const { relay, user } = await authorizedRelay(relayId, "relay.terminal")
    return z
      .object({ seq: z.number().int().nonnegative() })
      .parse(
        await databaseRpc(relay, "relay.terminal.claim", input, 15_000, user.id)
      )
  })

export const restartRelayTerminal = createServerFn({ method: "POST" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedRelay(
      data.relayId,
      "relay.terminal"
    )
    await databaseRpc(relay, "relay.terminal.restart", {}, 30_000, user.id)
    return { restarted: true }
  })

// Requires `relay.update`, as updating already restarts the Relay. Game
// servers, apps, and databases keep running.
const restartRelayProcess = operation<z.infer<typeof targetSchema>>()({
  name: "relay.restart",
  doing: "Restarting this Relay",
  authorize: ({ input, user }) => relayFor(user, input.relayId, "relay.update"),
  locks: ({ input }) => [relayProcess(input.relayId)],
  run: ({ context: { relay, user } }) =>
    promiseEffect(async () => {
      await requireRelayRestart(relay)
      await databaseRpc(relay, "relay.restart", {}, 30_000, user.id)
      return { restarting: true }
    }),
  audit: ({ input }) => relayAudit(input.relayId),
})

export const restartRelay = createServerFn({ method: "POST" })
  .validator(targetSchema)
  .handler(async ({ data }) =>
    runOperationPromise(restartRelayProcess, data, {
      user: await requireEligibleResourceUser(),
    })
  )

// Requires `relay.terminal`, as a root shell on the host could reboot it
// anyway, and the account password, as it takes down everything on the host.
const rebootRelayHost = operation<z.infer<typeof restartHostSchema>>()({
  name: "relay.host.restart",
  doing: "Restarting this Relay",
  authorize: ({ input, user }) =>
    relayFor(user, input.relayId, "relay.terminal").pipe(
      Effect.tap(({ user: person }) =>
        promiseEffect(async () => {
          const { requireAccountPassword } = await import("@/lib/auth-password")
          await requireAccountPassword(person, input.password)
        })
      )
    ),
  locks: ({ input }) => [relayProcess(input.relayId)],
  run: ({ context: { relay, user } }) =>
    promiseEffect(async () => {
      await requireRelayRestart(relay)
      await databaseRpc(relay, "relay.host.restart", {}, 120_000, user.id)
      return { restarting: true }
    }),
  audit: ({ input }) => relayAudit(input.relayId),
})

export const restartRelayHost = createServerFn({ method: "POST" })
  .validator(restartHostSchema)
  .handler(async ({ data }) =>
    runOperationPromise(rebootRelayHost, data, {
      user: await requireEligibleResourceUser(),
    })
  )

async function requireRelayRestart(relay: PersistedRelay): Promise<void> {
  const { isRelayUpdating, relayConnectionFeatures } =
    await import("@/lib/relay-connection")
  if (!relayConnectionFeatures(relay.id).has(relayRestartV1Feature)) {
    throw new Error("Update this Relay to restart it from Hearth.")
  }
  // A restart could interrupt the update replacing the Relay.
  if (isRelayUpdating(relay.id)) {
    throw new Error("Wait for this Relay's update to finish.")
  }
}

// The Relay's latest sample of its own usage, from the node this process's
// control socket last received: no Relay round trip, so the Relay's meters
// can poll it.
export const getRelayResources = createServerFn({ method: "GET" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    await authorizedRelay(data.relayId, "relay.read")
    const { relayConnectionFeatures, relayConnectionNode } =
      await import("@/lib/relay-connection")
    const node = relayConnectionNode(data.relayId)
    return {
      resources: node?.relayResources ?? null,
      startedAt: node?.startedAt ?? null,
      supported: relayConnectionFeatures(data.relayId).has(
        relayResourcesV1Feature
      ),
    }
  })

// Recent samples, to fill the meters' history when they open.
export const getRelayResourceHistory = createServerFn({ method: "GET" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    const { relay } = await authorizedRelay(data.relayId, "relay.read")
    const { relayConnectionFeatures } = await import("@/lib/relay-connection")
    if (!relayConnectionFeatures(relay.id).has(relayResourcesV1Feature)) {
      return []
    }
    return relayResourceHistorySchema.parse(
      await databaseRpc(relay, "relay.resources.read", {}, 15_000)
    ).history
  })

const relayResourceHistorySchema = z.object({
  history: z
    .array(relayInstanceResourcesSchema)
    .max(relayResourceHistoryMaxSamples),
})
