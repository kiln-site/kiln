import { createServerFn } from "@tanstack/react-start"
import {
  instanceIdSchema,
  instancePowerPermission,
  relayControlDeadlineMs,
  relayPowerActionSchema,
  tunnelIdSchema,
  tunnelSchema,
  type RelayPowerAction,
} from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import { promiseEffect, recoverPromise } from "@/effect/promise"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { asGatewayDeployment } from "@/lib/server-deployments.server"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { tunnelKey } from "@/lib/tunnel-lanes"
import { exclusive, partKey } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import {
  getGatewayDeploymentsHandler,
  getTunnelDeploymentsHandler,
} from "@/server/app-deployments.server"
import { requireEligibleResourceUser } from "@/server/auth"
import { databaseRpc, requiredRelay } from "@/server/managed-database-access"
import {
  requireGatewayPermission,
  requireTunnelGateways,
  type GatewayRecord,
} from "@/server/tunnel-access.server"

// What every kind of instance has, for a tunnel: power over its gateways'
// containers, deploying them again, and their deployments, each for one
// gateway or for every gateway of the tunnel at once. Its terminal and its
// logs go through the paths every kind shares, one gateway at a time, each
// authorized as a gateway is (`requireGatewayPermission`). On its Relay a
// gateway is still called a tunnel, which is what these requests name.

/** A gateway: power, deploying it again, and anything else that changes it. */
const gatewayKey = (id: string) => `gateway:${id}`

/** Every gateway of a tunnel at once. */
const tunnelGatewaysKey = (id: string) => partKey(tunnelKey(id), "gateways")

const gatewayPowerSchema = z.strictObject({
  action: relayPowerActionSchema,
  gatewayId: instanceIdSchema,
})
const tunnelPowerSchema = z.strictObject({
  action: relayPowerActionSchema,
  tunnelId: tunnelIdSchema,
})
const gatewayInputSchema = z.strictObject({ gatewayId: instanceIdSchema })
const tunnelInputSchema = z.strictObject({ tunnelId: tunnelIdSchema })
const beforeSchema = z
  .strictObject({ id: z.uuid(), startedAt: z.iso.datetime() })
  .optional()

/** What a change to every gateway did on each, in the tunnel's order. */
export interface GatewayOutcome {
  error: string | null
  gatewayId: string
  relayId: string
}

const gatewayPower = operation<z.infer<typeof gatewayPowerSchema>>()({
  name: "gateways.power",
  doing: "Changing this gateway's power",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.tap((person) =>
        promiseEffect(() =>
          requireGatewayPermission(
            person,
            input.gatewayId,
            instancePowerPermission(input.action)
          )
        )
      )
    ),
  locks: ({ input }) => [exclusive(gatewayKey(input.gatewayId))],
  run: ({ context: user, input }) =>
    promiseEffect(async () => {
      const gateway = await requireGatewayPermission(
        user,
        input.gatewayId,
        instancePowerPermission(input.action)
      )
      const result = await powerGateway(user, gateway, input.action)
      publishTunnelChange()
      return result
    }),
  audit: ({ input }) => ({ id: input.gatewayId, kind: "gateway" }),
})

/** Starts, stops, restarts or kills one gateway's containers. */
export const performGatewayAction = createServerFn({ method: "POST" })
  .validator(gatewayPowerSchema)
  .handler(async ({ data }) =>
    runOperationPromise(gatewayPower, data, {
      user: await requireEligibleResourceUser(),
    })
  )

const tunnelPower = operation<z.infer<typeof tunnelPowerSchema>>()({
  name: "tunnels.power",
  doing: "Changing this tunnel's power",
  authorize: ({ user }) => signedIn(user),
  locks: ({ input }) => [exclusive(tunnelGatewaysKey(input.tunnelId))],
  run: ({ context: user, input }) =>
    promiseEffect(async () => {
      const gateways = await requireTunnelGateways(
        user,
        input.tunnelId,
        instancePowerPermission(input.action)
      )
      const outcomes = await eachGateway(gateways, (gateway) =>
        powerGateway(user, gateway, input.action)
      )
      publishTunnelChange()
      return outcomes
    }),
  audit: ({ input }) => ({ id: input.tunnelId, kind: "tunnel" }),
})

/**
 * Starts, stops, restarts or kills every gateway of a tunnel the viewer may.
 * One failing doesn't stop the rest; each says how it went.
 */
export const performTunnelAction = createServerFn({ method: "POST" })
  .validator(tunnelPowerSchema)
  .handler(async ({ data }) =>
    runOperationPromise(tunnelPower, data, {
      user: await requireEligibleResourceUser(),
    })
  )

const redeployGatewayOperation = operation<
  z.infer<typeof gatewayInputSchema>
>()({
  name: "gateways.deploy",
  doing: "Deploying this gateway again",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.tap((person) =>
        promiseEffect(() =>
          requireGatewayPermission(person, input.gatewayId, "instance.deploy")
        )
      )
    ),
  locks: ({ input }) => [exclusive(gatewayKey(input.gatewayId))],
  run: ({ context: user, input }) =>
    promiseEffect(async () => {
      const gateway = await requireGatewayPermission(
        user,
        input.gatewayId,
        "instance.deploy"
      )
      const result = await redeployOne(user, gateway)
      publishTunnelChange()
      return result
    }),
  audit: ({ input }) => ({ id: input.gatewayId, kind: "gateway" }),
})

/** Deploys a gateway again: both its images pulled anew. */
export const redeployGateway = createServerFn({ method: "POST" })
  .validator(gatewayInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(redeployGatewayOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

const redeployTunnelOperation = operation<z.infer<typeof tunnelInputSchema>>()({
  name: "tunnels.deploy",
  doing: "Deploying this tunnel's gateways again",
  authorize: ({ user }) => signedIn(user),
  locks: ({ input }) => [exclusive(tunnelGatewaysKey(input.tunnelId))],
  run: ({ context: user, input }) =>
    promiseEffect(async () => {
      const gateways = await requireTunnelGateways(
        user,
        input.tunnelId,
        "instance.deploy"
      )
      const outcomes = await eachGateway(gateways, (gateway) =>
        redeployOne(user, gateway)
      )
      publishTunnelChange()
      return outcomes
    }),
  audit: ({ input }) => ({ id: input.tunnelId, kind: "tunnel" }),
})

/**
 * Deploys every gateway of a tunnel the viewer may again, one after another,
 * so its names keep answering through the rest. Each says how it went.
 */
export const redeployTunnel = createServerFn({ method: "POST" })
  .validator(tunnelInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(redeployTunnelOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

/** One gateway's deployments, for whoever may read its logs. */
export const getGatewayDeployments = createServerFn({ method: "GET" })
  .validator(gatewayInputSchema.extend({ before: beforeSchema }))
  .handler(({ data }) => getGatewayDeploymentsHandler(data))

/** Every deployment of a tunnel's gateways the viewer may read the logs of. */
export const getTunnelDeployments = createServerFn({ method: "GET" })
  .validator(tunnelInputSchema.extend({ before: beforeSchema }))
  .handler(({ data }) => getTunnelDeploymentsHandler(data))

async function powerGateway(
  user: AuthenticatedUser,
  gateway: GatewayRecord,
  action: RelayPowerAction
) {
  const relay = await requiredRelay(gateway.relayId)
  return tunnelSchema.parse(
    await databaseRpc(
      relay,
      "instance.action",
      { action, id: gateway.id, kind: "tunnel" },
      relayControlDeadlineMs("instance.action"),
      user.id
    )
  )
}

async function redeployOne(user: AuthenticatedUser, gateway: GatewayRecord) {
  const relay = await requiredRelay(gateway.relayId)
  return tunnelSchema.parse(
    await asGatewayDeployment(
      { gatewayId: gateway.id, relayId: relay.id, userId: user.id },
      (deploymentId) =>
        databaseRpc(
          relay,
          "instance.deploy",
          { deploymentId, id: gateway.id, kind: "tunnel" },
          relayControlDeadlineMs("instance.deploy"),
          user.id
        )
    )
  )
}

// One gateway after another; a failure is reported and the rest go on.
async function eachGateway(
  gateways: ReadonlyArray<GatewayRecord>,
  run: (gateway: GatewayRecord) => Promise<unknown>
): Promise<Array<GatewayOutcome>> {
  const outcomes: Array<GatewayOutcome> = []
  for (const gateway of gateways) {
    const error = await recoverPromise(
      async () => {
        await run(gateway)
        return null
      },
      (cause) => (cause instanceof Error ? cause.message : String(cause))
    )
    outcomes.push({ error, gatewayId: gateway.id, relayId: gateway.relayId })
  }
  return outcomes
}

// Tunnels show on the Tunnels page, which reads them all at once.
function publishTunnelChange(): void {
  publishRealtimeChange({
    audience: { kind: "platform-admins" },
    topics: ["tailscale"],
    type: "hearth.invalidate",
  })
}
