import {
  brickRecipeSchema,
  MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
  relayCreateInstanceSchema,
} from "@workspace/contracts"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { relayHarness } from "./test/relay.js"
import { fakeDocker } from "./test/docker.js"

const older = "a".repeat(12)
const direct = "b".repeat(12)
const created = "c".repeat(12)

describe("what an instance is", () => {
  // A container says its Brick's kind and type in its labels. One made
  // before it did says its type only by how its network was set up.
  it("is read from a container made before it carried its type", async () => {
    const harness = await relayHarness()
    await harness.seedServer({
      id: older,
      labels: { "kiln.brick.network-mode": "minecraft-backend" },
    })
    await harness.seedServer({
      id: direct,
      labels: { "kiln.brick.network-mode": "direct" },
    })
    const instances = await harness.docker.inspectInstances()
    const read = (id: string) => {
      const instance = instances.find((candidate) => candidate.id === id)
      return [instance?.brickKind, instance?.brickType]
    }
    expect(read(older)).toEqual(["game-server", "minecraft"])
    expect(read(direct)).toEqual(["game-server", undefined])
  })

  // Kiln used to offer console completion by a Brick's ID. A container made
  // then says nothing of it, so it is still asked that way.
  it("keeps console completion for a server made before its Brick said so", async () => {
    const harness = await relayHarness()
    await harness.seedServer({
      id: older,
      labels: { "kiln.brick.id": "paper" },
    })
    await harness.seedServer({
      id: direct,
      labels: { "kiln.brick.id": "fabric" },
    })
    // A Brick that says it doesn't is believed, whatever its ID.
    await harness.seedServer({
      id: created,
      labels: {
        "kiln.brick.id": "paper",
        "kiln.brick.console-completion": "false",
      },
    })
    const instances = await harness.docker.inspectInstances()
    const completes = (id: string) =>
      instances.find((candidate) => candidate.id === id)?.brickConsoleCompletion
    expect(completes(older)).toBe(true)
    expect(completes(direct)).toBe(false)
    expect(completes(created)).toBe(false)
  })

  it("is written on a new container, and read back from it", async () => {
    const harness = await relayHarness()
    const instance = await harness.lifecycle.createInstanceWithId(
      created,
      relayCreateInstanceSchema.parse({
        diskLimitBytes: MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
        name: "Lobby",
        recipe: "https://bricks.test/paper.yml",
        recipeDefinition: brickRecipeSchema.parse({
          format: "kiln.brick/v2",
          kind: "game-server",
          type: "minecraft",
          metadata: {
            author: "Kiln",
            id: "paper",
            name: "Paper",
            summary: "Paper test recipe",
          },
          deploy: {
            type: "image",
            image: "example.test/paper:latest",
            volumes: ["/server"],
            ports: [{ name: "game", port: 25_565 }],
          },
          minecraft: { completion: true },
        }),
        start: false,
        variables: {},
      })
    )
    expect([
      instance.brickKind,
      instance.brickType,
      instance.brickConsoleCompletion,
    ]).toEqual(["game-server", "minecraft", true])
    const labels = fakeDocker.container(
      harness.resources.instanceContainer(created)
    )?.labels
    expect(labels).toMatchObject({
      "kiln.brick.kind": "game-server",
      "kiln.brick.type": "minecraft",
      "kiln.brick.console-completion": "true",
      // Still written, for what reads a container's labels as they were.
      "kiln.brick.network-mode": "minecraft-backend",
    })
  })
})
