import type { RelayInstance } from "@workspace/contracts"

export function retainProvisioningInstances(
  instances: Array<RelayInstance>,
  retainedInstances: Iterable<RelayInstance>
): Array<RelayInstance> {
  const visibleIds = new Set(instances.map((instance) => instance.id))
  const provisioning = Array.from(retainedInstances)
    .filter((instance) => !visibleIds.has(instance.id))
    .map(provisioningInstance)

  return provisioning.length === 0 ? instances : [...instances, ...provisioning]
}

function provisioningInstance(instance: RelayInstance): RelayInstance {
  return {
    ...instance,
    containerId: null,
    lifecycle: [],
    observedState: "provisioning",
    stateReason: null,
    recovery: null,
    resources: null,
    status: "Reprovisioning",
  }
}
