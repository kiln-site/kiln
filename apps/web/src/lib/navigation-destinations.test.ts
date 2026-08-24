import { describe, expect, it } from "vite-plus/test"
import { builtinTailscaleBrickId } from "@workspace/contracts"

import {
  destinationsForServer,
  sectionDestinationLabel,
  serverDestinationHref,
  serverDestinations,
} from "@/lib/navigation-destinations"

describe("navigation destinations", () => {
  it("uses the complete server workspace list for regular servers", () => {
    expect(
      destinationsForServer({ brickId: "paper" }).map(({ id }) => id)
    ).toEqual(serverDestinations.map(({ id }) => id))
  })

  it("uses only supported workspace destinations for network stacks", () => {
    expect(
      destinationsForServer({ brickId: builtinTailscaleBrickId }).map(
        ({ id }) => id
      )
    ).toEqual(["console", "files", "network"])
  })

  it("builds encoded server destination URLs", () => {
    const files = serverDestinations.find(({ id }) => id === "files")
    const console = serverDestinations.find(({ id }) => id === "console")

    expect(files).toBeDefined()
    expect(console).toBeDefined()
    expect(serverDestinationHref(files!, "relay one/server")).toBe(
      "/server/relay%20one%2Fserver/files/"
    )
    expect(serverDestinationHref(console!, "relay one/server")).toBe(
      "/server/relay%20one%2Fserver/console"
    )
  })

  it("resolves section titles from the shared destinations", () => {
    expect(sectionDestinationLabel("infra", "/infra/tailscale/network")).toBe(
      "Tailscale"
    )
    expect(sectionDestinationLabel("settings", "/settings/files")).toBe("Files")
    expect(sectionDestinationLabel("automations", "/activity")).toBeNull()
  })
})
