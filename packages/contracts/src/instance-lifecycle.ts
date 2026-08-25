import { z } from "zod"

export const relayInstanceLifecycleStateSchema = z.enum([
  "started",
  "ready",
  "stopping",
  "stopped",
  "failed",
])

export const relayInstanceLifecycleEventSchema = z
  .object({
    state: relayInstanceLifecycleStateSchema,
    time: z.string().datetime(),
  })
  .strict()

export type RelayInstanceLifecycleState = z.infer<
  typeof relayInstanceLifecycleStateSchema
>

export type RelayInstanceLifecycleEvent = z.infer<
  typeof relayInstanceLifecycleEventSchema
>

export function relayInstanceLifecycleEventTime(
  lifecycle: ReadonlyArray<RelayInstanceLifecycleEvent> | null | undefined,
  state: RelayInstanceLifecycleState
): string | null {
  return lifecycle?.find((event) => event.state === state)?.time ?? null
}
