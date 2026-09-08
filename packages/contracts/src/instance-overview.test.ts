import { describe, expect, it } from "vite-plus/test"
import { projectRelayInstanceOverview, relayInstanceSchema } from "./index"

const instance = relayInstanceSchema.parse({
  connectAddress: "server.test",
  containerId: null,
  desiredState: "running",
  directory: "a".repeat(40),
  game: "Minecraft",
  id: "a".repeat(40),
  implementation: "Paper",
  javaVersion: "21",
  name: "Server",
  observedState: "running",
  service: "server",
  shortId: "aaaaaaaa",
  status: "running",
  version: "1.21.11",
  variables: { password: "startup-secret", public_setting: "also-config" },
  brickSource:
    "https://user:password@example.com/recipe.yaml?token=secret#secret",
})

describe("public instance projection", () => {
  it("removes configuration and embedded source secrets without mutating cached instances", () => {
    const projected = projectRelayInstanceOverview(instance)
    expect(projected).not.toHaveProperty("variables")
    expect(projected.brickSource).toBe("https://example.com/recipe.yaml")
    expect(projected.resources).toBe(instance.resources)
    expect(projected.lifecycle).toBe(instance.lifecycle)
    expect(instance.variables?.password).toBe("startup-secret")
    expect(relayInstanceSchema.safeParse(projected).success).toBe(true)
  })
  it("omits malformed source values instead of exposing them", () => {
    expect(
      projectRelayInstanceOverview({ ...instance, brickSource: "secret token" })
    ).not.toHaveProperty("brickSource")
  })
})
