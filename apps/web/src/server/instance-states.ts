import { createServerFn } from "@tanstack/react-start"
import { getRequest, setResponseHeader } from "@tanstack/react-start/server"
import { InstanceReferenceSchema } from "@workspace/contracts"
import { Effect, Schema } from "effect"

import { runAppEffect } from "@/effect/runtime"
import { readInstanceStates } from "@/server/instance-states.server"
import { InstanceInventorySourceLive } from "@/server/instance-inventory.server"
import { requireEligibleResourceUser } from "@/server/auth"

export const getInstanceStates = createServerFn({ method: "POST" })
  .validator(
    Schema.decodeUnknownSync(
      Schema.Array(InstanceReferenceSchema).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(128)
      )
    )
  )
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    setResponseHeader("Cache-Control", "no-store")
    return runAppEffect(
      "Instances.readStates",
      readInstanceStates(user, data).pipe(
        Effect.provide(InstanceInventorySourceLive)
      ),
      {
        signal: getRequest().signal,
      }
    )
  })
