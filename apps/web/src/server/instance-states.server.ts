import type {
  InstanceReference,
  InstanceStateResult,
} from "@workspace/contracts"
import { Effect } from "effect"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { readInstanceInventory } from "@/server/instance-inventory.server"

// Keep the existing endpoint compatible while all reads use the shared planner.
export const readInstanceStates = Effect.fn("Instances.readStates.batch")(
  function* (
    user: AuthenticatedUser,
    references: ReadonlyArray<InstanceReference>
  ) {
    const results = yield* readInstanceInventory(
      user,
      references.map((reference) => ({ reference, view: "status" as const }))
    )
    return results.map((result): InstanceStateResult =>
      "value" in result
        ? {
            reference: result.request.reference,
            observation: result.value.observation,
          }
        : {
            reference: result.request.reference,
            error:
              result.error === "unavailable"
                ? "Resource unavailable"
                : "Could not check status",
          }
    )
  }
)
