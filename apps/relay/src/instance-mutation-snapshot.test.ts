import { describe, expect, it } from "vite-plus/test"
import { relayInstanceSchema } from "@workspace/contracts"

import { retainProvisioningInstances } from "./instance-mutation-snapshot.js"

const instance = relayInstanceSchema.parse({
  connectAddress: "minecraft.test:25565",
  containerId: "container-one",
  desiredState: "running",
  directory: "a".repeat(40),
  game: "Minecraft",
  id: "a".repeat(40),
  implementation: "Paper",
  javaVersion: "21",
  name: "Test server",
  observedState: "running",
  service: "kiln-test-server",
  shortId: "aaaaaaaa",
  lifecycle: [
    { state: "started", time: "2026-08-08T12:00:00.000Z" },
    { state: "ready", time: "2026-08-08T12:00:15.000Z" },
  ],
  status: "Running",
  version: "1.21.8",
})

describe("instance mutation snapshots", () => {
  it("retains a missing instance as provisioning while it is replaced", () => {
    const instances = retainProvisioningInstances([], [instance])

    expect(instances).toEqual([
      expect.objectContaining({
        containerId: null,
        id: instance.id,
        name: instance.name,
        lifecycle: [],
        observedState: "provisioning",
        resources: null,
      }),
    ])
  })

  it("prefers the live replacement once it appears", () => {
    const replacement = { ...instance, containerId: "container-two" }
    const instances = retainProvisioningInstances([replacement], [instance])

    expect(instances).toEqual([replacement])
  })
})
