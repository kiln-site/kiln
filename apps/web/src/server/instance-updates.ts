import { createServerFn } from "@tanstack/react-start"
import {
  imageDigestSchema,
  instanceIdSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { z } from "zod"

import type { InstanceUpdateKind } from "@/effect/instance-updates"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { updatedKind } from "@/lib/instance-update-kinds.server"
import { runOperationPromise } from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  askInstanceImageUpdateHandler,
  deployInstanceUpdateHandler,
  installInstanceBrickHandler,
  instanceUpdatesHandler,
  skipInstanceBrickUpdateHandler,
  recordInstanceImageCheckHandler,
  saveInstanceUpdatePolicyHandler,
  skipInstanceUpdateHandler,
  type UpdatedInstanceInput,
} from "@/server/instance-updates.server"
import { resourceOperation } from "@/server/resource-operation.server"

const instanceInputSchema = z.strictObject({
  instanceId: instanceIdSchema,
  kind: z.enum(["app", "database", "server"]),
  relayId: relayIdSchema,
})

const policyInputSchema = instanceInputSchema.extend({
  // Up to 90 days.
  delayHours: z.number().int().min(0).max(2_160),
  mode: z.enum(["off", "notify", "auto"]),
})

const skipInputSchema = instanceInputSchema.extend({
  digest: imageDigestSchema,
})

const skipBrickInputSchema = instanceInputSchema.extend({
  revision: z.number().int().min(1),
})

// Each kind as lanes and access name it, and as copy does.
const kinds = {
  app: { noun: "App", resource: "app" },
  database: { noun: "database", resource: "database" },
  server: { noun: "game server", resource: "instance" },
} as const satisfies Record<
  InstanceUpdateKind,
  { noun: string; resource: "app" | "database" | "instance" }
>

// Whoever may deploy an instance decides when it deploys, so every one of
// these takes that one permission, for every kind. Its settings, and what
// a check found, hold the instance shared. Taking an update holds it as its
// kind takes one (`UpdatedKind.updateLock`): shared for an App, whose
// deployment queue does the deploying, and whole for a database or a game
// server, whose container is replaced in the operation itself, as a
// redeploy's is.
const updateOperation = <Input extends UpdatedInstanceInput, A>(
  name: string,
  doing: (noun: string) => string,
  run: (user: AuthenticatedUser, input: Input) => Promise<A>,
  holds: "settings" | "update" = "settings"
) => {
  const operations = Object.fromEntries(
    Object.entries(kinds).map(([kind, { noun, resource }]) => {
      const adapter = updatedKind(kind as InstanceUpdateKind)
      return [
        kind,
        resourceOperation({
          kind: resource,
          id: (input: Input) => input.instanceId,
          name: `${resource}.updates.${name}`,
          doing: doing(noun),
          permission: () => "instance.deploy",
          lock: holds === "update" ? adapter.updateLock : "shared",
          ...(holds === "update" &&
            adapter.updateAlsoLocks && {
              alsoLocks: (input: Input) =>
                adapter.updateAlsoLocks!(input.relayId, input.instanceId),
            }),
          run,
        }),
      ]
    })
  ) as Record<InstanceUpdateKind, ReturnType<typeof resourceOperation<Input, A>>>
  return (input: Input) => operations[input.kind]
}

const savePolicy = updateOperation(
  "policy",
  (noun) => `Changing this ${noun}'s updates`,
  (user, input: z.infer<typeof policyInputSchema>) =>
    saveInstanceUpdatePolicyHandler(user, input)
)
// Records a check asked for just before, so the instance is held only while
// the answer is recorded, not while registries answer.
const recordCheck = updateOperation(
  "check",
  (noun) => `Checking this ${noun}'s image`,
  recordInstanceImageCheckHandler
)
const skipUpdate = updateOperation(
  "skip",
  (noun) => `Changing this ${noun}'s updates`,
  (user, input: z.infer<typeof skipInputSchema>) =>
    skipInstanceUpdateHandler(user, input)
)
const skipBrick = updateOperation(
  "brick.skip",
  (noun) => `Changing this ${noun}'s updates`,
  (user, input: z.infer<typeof skipBrickInputSchema>) =>
    skipInstanceBrickUpdateHandler(user, input)
)
const installBrick = updateOperation(
  "brick.install",
  (noun) => `Updating this ${noun}'s Brick`,
  installInstanceBrickHandler,
  "update"
)
const deployUpdate = updateOperation(
  "deploy",
  (noun) => `Updating this ${noun}`,
  deployInstanceUpdateHandler,
  "update"
)

/** What an instance's Updates row shows, for whoever can read it. */
export const getInstanceUpdates = createServerFn({ method: "GET" })
  .validator(instanceInputSchema)
  .handler(async ({ data }) =>
    instanceUpdatesHandler(await requireEligibleResourceUser(), data)
  )

export const saveInstanceUpdatePolicy = createServerFn({ method: "POST" })
  .validator(policyInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(savePolicy(data), data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const checkInstanceUpdate = createServerFn({ method: "POST" })
  .validator(instanceInputSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const asked = await askInstanceImageUpdateHandler(user, data)
    const input = { ...data, asked }
    return runOperationPromise(recordCheck(input), input, { user })
  })

export const skipInstanceUpdate = createServerFn({ method: "POST" })
  .validator(skipInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(skipUpdate(data), data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const skipInstanceBrickUpdate = createServerFn({ method: "POST" })
  .validator(skipBrickInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(skipBrick(data), data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const installInstanceBrick = createServerFn({ method: "POST" })
  .validator(instanceInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(installBrick(data), data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const deployInstanceUpdate = createServerFn({ method: "POST" })
  .validator(instanceInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(deployUpdate(data), data, {
      user: await requireEligibleResourceUser(),
    })
  )
