import type {
  ProvisioningKind,
  RelayInstanceProvisioning,
} from "@workspace/contracts"

const KIND_LABELS: Record<ProvisioningKind, string> = {
  app: "App",
  database: "Database",
  server: "Server",
}

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
  kind?: ProvisioningKind
  relayId: string
}): string {
  return [
    `${KIND_LABELS[input.kind ?? "server"]}: ${input.instanceName} (${input.instanceId})`,
    `Relay: ${input.relayId}`,
    `Failed phase: ${PHASE_LABELS[input.failedPhase ?? "preparing"]}`,
    `Attempt: ${Math.max(1, input.attempt)}`,
    `Reason: ${input.error ?? "The Relay did not provide an error message."}`,
  ].join("\n")
}
