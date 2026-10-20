import type { DatabaseDriver } from "./databases.js"
import { databaseLocks } from "./operation-plans.js"
import { type ProvisioningAdapter, provisioningStatus } from "./provisioning.js"

/** How a database provisions: its volume, network, and container. */
export function databaseProvisioning(
  databases: DatabaseDriver
): ProvisioningAdapter<"database"> {
  return {
    kind: "database",
    label: "database.provision",
    locks: databaseLocks,
    withState: (placeholder, state) => ({
      ...placeholder,
      observedState: state.phase === "failed" ? "failed" : "provisioning",
      provisioning: state,
      status: provisioningStatus(state.phase, "database"),
    }),
    provision: async (job, onPhase) => {
      await databases.create(job.input, onPhase)
    },
  }
}
