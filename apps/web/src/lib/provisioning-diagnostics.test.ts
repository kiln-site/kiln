import { describe, expect, it } from "vite-plus/test"

import { provisioningFailureDiagnostics } from "@/lib/provisioning-diagnostics"

describe("provisioning failure diagnostics", () => {
  it("formats the full diagnostics copied from failed server pages", () => {
    expect(
      provisioningFailureDiagnostics({
        attempt: 2,
        error: "Docker image pull failed",
        failedPhase: "pulling_image",
        instanceId: "server-one",
        instanceName: "Paper Server",
        relayId: "relay-one",
      })
    ).toBe(
      [
        "Server: Paper Server (server-one)",
        "Relay: relay-one",
        "Failed phase: Download",
        "Attempt: 2",
        "Reason: Docker image pull failed",
      ].join("\n")
    )
  })
})
