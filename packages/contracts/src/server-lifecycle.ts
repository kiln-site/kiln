import { z } from "zod"

export const relayServerLifecycleStateSchema = z.enum([
  "started",
  "ready",
  "stopping",
  "stopped",
  "failed",
])

export const relayServerLifecycleEventSchema = z
  .object({
    state: relayServerLifecycleStateSchema,
    time: z.string().datetime(),
  })
  .strict()

export type RelayServerLifecycleState = z.infer<
  typeof relayServerLifecycleStateSchema
>

export type RelayServerLifecycleEvent = z.infer<
  typeof relayServerLifecycleEventSchema
>

export function relayServerLifecycleEventTime(
  lifecycle: ReadonlyArray<RelayServerLifecycleEvent> | null | undefined,
  state: RelayServerLifecycleState
): string | null {
  return lifecycle?.find((event) => event.state === state)?.time ?? null
}
