import { Effect } from "effect"

import type { RelayStateStore } from "./effect/state.js"
import type { LifecycleDriver } from "./lifecycle.js"
import { instanceReplaceLocks } from "./operation-plans.js"
import { type ProvisioningAdapter, provisioningStatus } from "./provisioning.js"

/** How a game server provisions: its container, from its Brick. */
export function serverProvisioning(options: {
  lifecycle: LifecycleDriver
  state: RelayStateStore["Service"]
}): ProvisioningAdapter<"server"> {
  return {
    kind: "server",
    label: "instance.provision",
    locks: instanceReplaceLocks,
    withState: (placeholder, state) => ({
      ...placeholder,
      observedState: state.phase === "failed" ? "failed" : "provisioning",
      provisioning: state,
      status: provisioningStatus(state.phase, "server"),
    }),
    provision: async (job, onPhase) => {
      const instance = await options.lifecycle.createInstanceWithId(
        job.instanceId,
        job.input,
        onPhase
      )
      await Effect.runPromise(
        options.state.setInstanceName(
          job.instanceId,
          job.input.name ?? instance.name
        )
      )
    },
  }
}
