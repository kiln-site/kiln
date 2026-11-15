
import {
  brickRecipeSchema,
  MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
  relayCreateInstanceSchema,
  relayUpdateInstanceStartupSchema,
} from "@workspace/contracts"
import { Effect } from "effect"
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { controlRequestLocks } from "./operation-plans.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness } from "./test/relay.js"

const newServerId = "a".repeat(12)
const deletedServerId = "b".repeat(12)
const image = "example.test/paper:latest"

const recipe = brickRecipeSchema.parse({
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
    image,
    runtime: "Paper",
    memory: "512M",
    pids: 128,
    volumes: ["/server"],
    ports: [{ name: "game", port: 25_565 }],
  },
  "game-server": { game: "Minecraft" },
})

describe("game server provisioning", () => {
  it("keeps a game server's ports from another create while its startup change downloads", async () => {
    // Just its two ports, so another create can only take one of them.
    const harness = await relayHarness({
      KILN_RELAY_GAME_PORT_RANGE: "30000-30001",
    })
    // Without the minecraft type, every port it names is published.
    const { type: _type, ...direct } = recipe
    const twoPorts = brickRecipeSchema.parse({
      ...direct,
      deploy: {
        ...recipe.deploy,
        ports: [
          { name: "game", port: 25_565 },
          { name: "rcon", port: 25_575 },
        ],
      },
    })
    const admitted = <A>(
      operation: "instance.create" | "instance.startup.write",
      instanceId: string,
      work: () => Promise<A>
    ) =>
      Effect.runPromise(
        harness.lanes.run(
          {
            label: operation,
            locks: controlRequestLocks(
              operation,
              { instanceId },
              (reference) => reference,
              () => []
            )!,
          },
          Effect.promise(work)
        )
      )
    const create = (id: string, name: string, definition = twoPorts) =>
      admitted("instance.create", id, () =>
        harness.lifecycle.createInstanceWithId(
          id,
          relayCreateInstanceSchema.parse({
            diskLimitBytes: MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
            name,
            recipe: "https://bricks.test/paper.yml",
            recipeDefinition: definition,
            start: false,
            variables: {},
          })
        )
      )
    const ports = (instance: {
      ports: ReadonlyArray<{ externalPort: number }>
    }) => instance.ports.map((port) => port.externalPort).sort((a, b) => a - b)
    expect(ports(await create(newServerId, "Lobby"))).toEqual([30_000, 30_001])

    // Its startup change moves it to an image that isn't here yet.
    const nextImage = "example.test/paper:next"
    const pull = fakeDocker.hold({ command: "pull", target: nextImage })
    const changed = admitted("instance.startup.write", newServerId, () =>
      harness.lifecycle.reconfigureInstance(
        newServerId,
        relayUpdateInstanceStartupSchema.parse({
          recipeDefinition: {
            ...twoPorts,
            deploy: { ...twoPorts.deploy, image: nextImage },
          },
          start: false,
          variables: {},
        })
      )
    )
    await pull.reached

    // Another create finds no free port rather than taking one of its.
    await expect(create(deletedServerId, "Survival", recipe)).rejects.toThrow()
    pull.release()
    expect(ports(await changed)).toEqual([30_000, 30_001])
  })

  // A Brick that installs its newest release learns which that is from a
  // lookup, and the answers that follow it can be ones it doesn't offer.
  it("deploys a game server again as it is, from an image pulled anew", async () => {
    const harness = await relayHarness()
    const greeting = brickRecipeSchema.parse({
      ...recipe,
      inputs: [{ key: "motd", label: "MOTD", type: "text", default: "Hello" }],
      deploy: { ...recipe.deploy, env: { MOTD: "{{ motd }}" } },
    })
    await harness.lifecycle.createInstanceWithId(
      newServerId,
      relayCreateInstanceSchema.parse({
        diskLimitBytes: MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
        name: "Lobby",
        recipe: "https://bricks.test/paper.yml",
        recipeDefinition: greeting,
        start: true,
        variables: { motd: "Welcome" },
      })
    )
    const container = () =>
      fakeDocker.container(harness.resources.instanceContainer(newServerId))
    const before = container()
    expect(before?.env.MOTD).toBe("Welcome")
    const created = await harness.docker.findInstance(newServerId)
    fakeDocker.pulls.clear()

    const deployed = await harness.lifecycle.redeployInstance(newServerId)

    // A new container, from the image as its registry has it now.
    const after = container()
    expect(after).not.toBe(before)
    expect([...fakeDocker.pulls.keys()]).toEqual([image])
    // Nothing about it changed: what it was answered, limited to, and
    // whether it runs.
    expect(after?.env.MOTD).toBe("Welcome")
    expect(after?.memoryBytes).toBe(before?.memoryBytes)
    expect(after?.state.running).toBe(true)
    expect(deployed.variables).toEqual({ motd: "Welcome" })
    expect(deployed.brickSnapshotSha256).toBe(created?.brickSnapshotSha256)
    expect(deployed.limits.diskBytes).toBe(MINIMUM_INSTANCE_DISK_LIMIT_BYTES)
  })

  it("refuses a startup change it can't apply while the server still runs", async () => {
    const harness = await relayHarness()
    vi.stubGlobal("fetch", async () =>
      Response.json(["3.5.0", "4.3.2-SNAPSHOT"])
    )
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const proxy = brickRecipeSchema.parse({
      ...recipe,
      inputs: [
        { key: "version", label: "Version", type: "text", default: "3.5.0" },
        {
          key: "java_version",
          label: "Java",
          type: "select",
          options: ["21"],
          default: "21",
          suggest: [{ when: "version", from: "4", value: "25" }],
        },
      ],
      minecraft: { latestVersion: "velocity" },
    })
    await harness.lifecycle.createInstanceWithId(
      newServerId,
      relayCreateInstanceSchema.parse({
        diskLimitBytes: MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
        name: "Proxy",
        recipe: "https://bricks.test/velocity.yml",
        recipeDefinition: proxy,
        start: true,
        variables: { version: "3.5.0" },
      })
    )
    const container = () =>
      fakeDocker.container(harness.resources.instanceContainer(newServerId))
    const before = container()
    expect(before?.state.running).toBe(true)

    // With no version sent it looks the newest up, which needs a Java this
    // Brick doesn't offer.
    await expect(
      harness.lifecycle.reconfigureInstance(
        newServerId,
        relayUpdateInstanceStartupSchema.parse({
          recipeDefinition: proxy,
          start: true,
          variables: {},
        })
      )
    ).rejects.toMatchObject({ code: "unsupported_suggestion" })
    expect(container()).toBe(before)
    expect(container()?.state.running).toBe(true)
  })
})
