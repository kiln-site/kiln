import { createServerFn } from "@tanstack/react-start"
import { getRequest, setResponseHeader } from "@tanstack/react-start/server"
import { InstanceInventoryRequestSchema } from "@workspace/contracts"
import { Effect, Schema } from "effect"

import { runAppEffect } from "@/effect/runtime"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  InstanceInventorySourceLive,
  readInstanceInventory,
} from "@/server/instance-inventory.server"

export const getInstanceInventory = createServerFn({ method: "POST" })
  .validator(
    Schema.decodeUnknownSync(
      Schema.Array(InstanceInventoryRequestSchema).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(128)
      )
    )
  )
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    setResponseHeader("Cache-Control", "no-store")
    return runAppEffect(
      "Instances.inventory",
      readInstanceInventory(user, data).pipe(
        Effect.provide(InstanceInventorySourceLive)
      ),
      { signal: getRequest().signal }
    )
  })
