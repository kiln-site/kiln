import type { AppDriver } from "./apps.js"
import { appCreateLocks } from "./operation-plans.js"
import { type ProvisioningAdapter, provisioningStatus } from "./provisioning.js"

/** How an app provisions: its network and data directory. */
export function appProvisioning(apps: AppDriver): ProvisioningAdapter<"app"> {
  return {
    kind: "app",
    label: "app.provision",
    locks: (job) => appCreateLocks(job.instanceId, job.input.databaseIds ?? []),
    withState: (placeholder, state) => ({
      ...placeholder,
      observedState: state.phase === "failed" ? "failed" : "provisioning",
      provisioning: state,
      status: provisioningStatus(state.phase, "app"),
    }),
    provision: async (job, onPhase) => {
      await apps.create(job.input, onPhase)
    },
  }
}
