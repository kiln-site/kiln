import { createServerFn } from "@tanstack/react-start"
import {
  instanceIdSchema,
  instancePowerPermission,
  relayControlDeadlineMs,
  relayPowerActionSchema,
  tunnelSchema,
} from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import { promiseEffect } from "@/effect/promise"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { asTunnelDeployment } from "@/lib/server-deployments.server"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { exclusive } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { getTunnelDeploymentsHandler } from "@/server/app-deployments.server"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  databaseRpc,
  requiredRelay,
} from "@/server/managed-database-access"
import { requireTunnelPermission } from "@/server/tunnel-access.server"

// What every kind of instance has, for a tunnel: power over both its
// containers, deploying it again, and its deployments. Its terminal and its
// logs go through the paths every kind shares, each authorized as a tunnel
// is (`requireTunnelPermission`).

/** A tunnel: power, deploying it again, and anything else that changes it. */
const tunnelKey = (id: string) => `tunnel:${id}`

const powerInputSchema = z.strictObject({
  action: relayPowerActionSchema,
  tunnelId: instanceIdSchema,
})

const tunnelInputSchema = z.strictObject({ tunnelId: instanceIdSchema })

const tunnelPower = operation<z.infer<typeof powerInputSchema>>()({
  name: "tunnels.power",
  doing: "Changing this tunnel's power",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.tap((person) =>
        promiseEffect(() =>
          requireTunnelPermission(
            person,
            input.tunnelId,
            instancePowerPermission(input.action)
          )
        )
      )
    ),
  locks: ({ input }) => [exclusive(tunnelKey(input.tunnelId))],
  run: ({ context: user, input }) =>
    promiseEffect(() => tunnelPowerHandler(user, input)),
  audit: ({ input }) => ({ id: input.tunnelId, kind: "tunnel" }),
})

async function tunnelPowerHandler(
  user: AuthenticatedUser,
  input: z.infer<typeof powerInputSchema>
) {
  const tunnel = await requireTunnelPermission(
    user,
    input.tunnelId,
    instancePowerPermission(input.action)
  )
  const relay = await requiredRelay(tunnel.relayId)
  const result = tunnelSchema.parse(
    await databaseRpc(
      relay,
      "instance.action",
      { action: input.action, id: tunnel.id, kind: "tunnel" },
      relayControlDeadlineMs("instance.action"),
      user.id
    )
  )
  publishTunnelChange()
  return result
}

export const performTunnelAction = createServerFn({ method: "POST" })
  .validator(powerInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(tunnelPower, data, {
      user: await requireEligibleResourceUser(),
    })
  )

const redeployTunnelOperation = operation<
  z.infer<typeof tunnelInputSchema>
>()({
  name: "tunnels.deploy",
  doing: "Deploying this tunnel again",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.tap((person) =>
        promiseEffect(() =>
          requireTunnelPermission(person, input.tunnelId, "instance.deploy")
        )
      )
    ),
  locks: ({ input }) => [exclusive(tunnelKey(input.tunnelId))],
  run: ({ context: user, input }) =>
    promiseEffect(() => redeployTunnelHandler(user, input)),
  audit: ({ input }) => ({ id: input.tunnelId, kind: "tunnel" }),
})

async function redeployTunnelHandler(
  user: AuthenticatedUser,
  input: z.infer<typeof tunnelInputSchema>
) {
  const tunnel = await requireTunnelPermission(
    user,
    input.tunnelId,
    "instance.deploy"
  )
  const relay = await requiredRelay(tunnel.relayId)
  const result = tunnelSchema.parse(
    await asTunnelDeployment(
      { relayId: relay.id, tunnelId: tunnel.id, userId: user.id },
      (deploymentId) =>
        databaseRpc(
          relay,
          "instance.deploy",
          { deploymentId, id: tunnel.id, kind: "tunnel" },
          relayControlDeadlineMs("instance.deploy"),
          user.id
        )
    )
  )
  publishTunnelChange()
  return result
}

/** Deploys a tunnel again: both its images pulled anew. */
export const redeployTunnel = createServerFn({ method: "POST" })
  .validator(tunnelInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(redeployTunnelOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

/** A tunnel's deployments, for whoever may read its logs. */
export const getTunnelDeployments = createServerFn({ method: "GET" })
  .validator(
    tunnelInputSchema.extend({
      before: z
        .strictObject({ id: z.uuid(), startedAt: z.iso.datetime() })
        .optional(),
    })
  )
  .handler(({ data }) => getTunnelDeploymentsHandler(data))

// Tunnels show on the Tailscale page, which reads them all at once.
function publishTunnelChange(): void {
  publishRealtimeChange({
    audience: { kind: "platform-admins" },
    topics: ["tailscale"],
    type: "hearth.invalidate",
  })
}
