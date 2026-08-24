import type { RelayInstanceProvisioning } from "@workspace/contracts"

const PHASE_LABELS: Record<
  NonNullable<RelayInstanceProvisioning["failedPhase"]>,
  string
> = {
  preparing: "Prepare",
  pulling_image: "Download",
  creating_container: "Build",
  finalizing: "Finalize",
}

export function provisioningFailureDiagnostics(input: {
  attempt: number
  error: string | null
  failedPhase: RelayInstanceProvisioning["failedPhase"]
  instanceId: string
  instanceName: string
  relayId: string
}): string {
  return [
    `Server: ${input.instanceName} (${input.instanceId})`,
    `Relay: ${input.relayId}`,
    `Failed phase: ${PHASE_LABELS[input.failedPhase ?? "preparing"]}`,
    `Attempt: ${Math.max(1, input.attempt)}`,
    `Reason: ${input.error ?? "The Relay did not provide an error message."}`,
  ].join("\n")
}
