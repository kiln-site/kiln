import { createServerFn } from "@tanstack/react-start"
import { relayIdSchema } from "@workspace/contracts"
import { z } from "zod"

import { runAppEffect } from "@/effect/runtime"
import { requireEligibleResourceUser } from "@/server/auth"

const rootIdSchema = z.string().min(1).max(128)
const relativePathSchema = z
  .string()
  .max(2_048)
  .refine(
    (path) =>
      !path.includes("\0") &&
      !path.startsWith("/") &&
      !path.split(/[\\/]/u).includes(".."),
    "Invalid relative file path"
  )

const transferRequestSchema = z.object({
  source: z.object({
    relayId: relayIdSchema,
    rootId: rootIdSchema,
    paths: z.array(relativePathSchema.min(1)).max(5_000),
  }),
  destination: z.object({
    relayId: relayIdSchema,
    rootId: rootIdSchema,
    path: relativePathSchema,
  }),
})

const transferHandleSchema = z.object({
  transferId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u),
  source: z.object({ relayId: relayIdSchema, rootId: rootIdSchema }),
  destination: z.object({ relayId: relayIdSchema, rootId: rootIdSchema }),
})

/** What would keep copying these files to another Relay from starting. */
export const preflightRelayTransfer = createServerFn({ method: "POST" })
  .validator(transferRequestSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const { preflightRelayTransferEffect } =
      await import("@/server/relay-transfers.server")
    return runAppEffect(
      "relayTransfers.preflight",
      preflightRelayTransferEffect(user, data)
    )
  })

/** Starts copying files to another Relay; returns the copy's handle. */
export const startRelayTransfer = createServerFn({ method: "POST" })
  .validator(transferRequestSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const { startRelayTransferEffect } =
      await import("@/server/relay-transfers.server")
    return runAppEffect(
      "relayTransfers.start",
      startRelayTransferEffect(user, data)
    )
  })

/** How a copy between Relays is going. */
export const getRelayTransfer = createServerFn({ method: "POST" })
  .validator(transferHandleSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const { relayTransferStatusEffect } =
      await import("@/server/relay-transfers.server")
    return runAppEffect(
      "relayTransfers.status",
      relayTransferStatusEffect(user, data)
    )
  })

/** Stops a copy between Relays and deletes what it left on either. */
export const cancelRelayTransfer = createServerFn({ method: "POST" })
  .validator(transferHandleSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const { cancelRelayTransferEffect } =
      await import("@/server/relay-transfers.server")
    await runAppEffect(
      "relayTransfers.cancel",
      cancelRelayTransferEffect(user, data)
    )
    return { cancelled: true }
  })
