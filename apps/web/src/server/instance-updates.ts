import { createServerFn } from "@tanstack/react-start"
import {
  imageDigestSchema,
  instanceIdSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { z } from "zod"

import type { InstanceUpdateKind } from "@/effect/instance-updates"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { runOperationPromise } from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  askInstanceImageUpdateHandler,
  deployInstanceUpdateHandler,
  instanceUpdatesHandler,
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

// Each kind as lanes and access name it, and as copy does.
const kinds = {
  app: { noun: "App", resource: "app" },
  database: { noun: "database", resource: "database" },
  server: { noun: "game server", resource: "instance" },
} as const satisfies Record<
  InstanceUpdateKind,
  { noun: string; resource: "app" | "database" | "instance" }
>

// Each holds the instance shared: its updates are its own settings and what
// a check found. Deploying an update asks for a deployment, which takes its
// own turn. Whoever may deploy it decides when it deploys, so every one of
// these takes that one permission, for every kind.
const updateOperation = <Input extends UpdatedInstanceInput, A>(
  name: string,
  doing: (noun: string) => string,
  run: (user: AuthenticatedUser, input: Input) => Promise<A>
) => {
  const operations = Object.fromEntries(
    Object.entries(kinds).map(([kind, { noun, resource }]) => [
      kind,
      resourceOperation({
        kind: resource,
        id: (input: Input) => input.instanceId,
        name: `${resource}.updates.${name}`,
        doing: doing(noun),
        permission: () => "instance.deploy",
        lock: "shared",
        run,
      }),
    ])
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
const deployUpdate = updateOperation(
  "deploy",
  (noun) => `Updating this ${noun}`,
  deployInstanceUpdateHandler
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

export const deployInstanceUpdate = createServerFn({ method: "POST" })
  .validator(instanceInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(deployUpdate(data), data, {
      user: await requireEligibleResourceUser(),
    })
  )
