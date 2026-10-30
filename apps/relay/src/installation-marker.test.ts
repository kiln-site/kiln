import { describe, expect, it } from "vite-plus/test"

import { installationMarkerName } from "./installation-marker.js"

describe("installation marker names", () => {
  // The name comes from a Brick and becomes a path inside the server's folder.
  it.each([
    "",
    ".",
    "..",
    "../.kiln-ready",
    "nested/.kiln-ready",
    "paper.jar",
    "server.properties",
  ])("rejects %j", (value) => {
    expect(installationMarkerName(value)).toBeNull()
  })
})
