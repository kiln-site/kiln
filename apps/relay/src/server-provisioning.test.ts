import { readFile } from "node:fs/promises"
import { join } from "node:path"

import {
  brickRecipeSchema,
  MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
  relayCreateInstanceSchema,
  relayUpdateInstanceStartupSchema,
  type RelayNetworking,
} from "@workspace/contracts"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { type RelayProvisioningJob, RelayStateStore } from "./effect/state.js"
import { controlRequestLocks } from "./operation-plans.js"
import {
  type ProvisioningAdapter,
  ProvisioningManager,
} from "./provisioning.js"
import { ServerDeploymentLogs } from "./server-deployment-logs.js"
import { serverProvisioning } from "./server-provisioning.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness, type RelayHarness } from "./test/relay.js"

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

// Runs a control request's work as the control socket admits it.
function control(
  harness: RelayHarness,
  operation: "instance.delete" | "relay.networking.write",
  payload: Record<string, unknown>,
  work: () => Promise<unknown>
) {
  return Effect.runPromise(
    harness.lanes.run(
      {
        label: operation,
        locks: controlRequestLocks(
          operation,
          payload,
          (reference) => reference,
          () => []
        )!,
      },
      Effect.promise(work)
    )
  )
}

// Never queued here.
function unused<Kind extends "app" | "database">(
  kind: Kind
): ProvisioningAdapter<Kind> {
  return {
    kind,
    label: `${kind}.provision`,
    locks: () => [],
    provision: () => Promise.reject(new Error("not used")),
    withState: (placeholder) => placeholder,
  }
}

// The worker as index.ts runs it, for game servers. It reports the new
// server's job once it's done, or failed, and stops when the test finishes.
async function serverWorker(harness: RelayHarness) {
  const finished = Deferred.makeUnsafe<RelayProvisioningJob | null>()
  const manager = await Effect.runPromise(
    ProvisioningManager.make({
      adapters: {
        app: unused("app"),
        database: unused("database"),
        server: serverProvisioning({
          deploymentLogs: new ServerDeploymentLogs(
            harness.config.dataDirectory
          ),
          lifecycle: harness.lifecycle,
          refreshSnapshot: async () => {
            const job = await Effect.runPromise(
              harness.state.getProvisioningJob(newServerId)
            )
            if (job === null || job.status === "failed") {
              Deferred.doneUnsafe(finished, Exit.succeed(job))
            }
          },
          state: harness.state,
        }),
      },
      capacity: { busy: () => false, slots: 2 },
      lanes: harness.lanes,
    }).pipe(Effect.provideService(RelayStateStore, harness.state))
  )
  const worker = Effect.runFork(manager.run())
  onTestFinished(() => Effect.runPromise(Fiber.interrupt(worker)))
  return { finished: Deferred.await(finished), manager }
}

describe("game server provisioning", () => {
  it("leaves CoreDNS with the current game servers and settings when a deletion and a networking change land mid-create", async () => {
    const harness = await relayHarness()
    const corefile = join(
      harness.config.dataDirectory,
      "infrastructure",
      "coredns",
      "Corefile"
    )
    const before: RelayNetworking = {
      address: "10.0.0.1",
      dnsPort: 53,
      domain: "kiln.test",
      enabled: true,
    }
    const after: RelayNetworking = {
      ...before,
      address: "10.0.0.2",
      dnsPort: 5353,
    }
    // A game server with a private hostname, which CoreDNS answers for.
    await harness.seedServer({
      id: deletedServerId,
      labels: {
        "kiln.instance.hostname": "deleted.kiln.test",
        "kiln.instance.tailscale-enabled": "true",
        "kiln.instance.tailscale-subdomain": "deleted",
      },
    })
    await control(harness, "relay.networking.write", before, () =>
      harness.lifecycle.configureNetworking(before)
    )
    expect(await readFile(corefile, "utf8")).toContain("deleted")

    // A new game server's create stops at its image download, after it read
    // the networking settings and the game servers.
    const pull = fakeDocker.hold({ command: "pull", target: image })
    const worker = await serverWorker(harness)
    const input = relayCreateInstanceSchema.parse({
      diskLimitBytes: MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
      name: "New",
      recipe: "https://bricks.test/paper.yml",
      recipeDefinition: recipe,
      start: false,
      variables: {},
    })
    await Effect.runPromise(
      worker.manager.prepare({
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        input,
        instanceId: newServerId,
        kind: "server",
        placeholder: await harness.lifecycle.prepareInstance(
          newServerId,
          input
        ),
      })
    )
    await Effect.runPromise(worker.manager.claim("server", newServerId))
    await pull.reached

    // Meanwhile the other game server is deleted and the networking changes.
    const deleted = control(
      harness,
      "instance.delete",
      { instanceId: deletedServerId },
      () => harness.lifecycle.deleteInstance(deletedServerId, true)
    )
    const changed = control(harness, "relay.networking.write", after, () =>
      harness.lifecycle.configureNetworking(after)
    )
    const both = Promise.all([deleted, changed])
    // Whatever may run beside the create finishes now; what may not waits
    // its turn behind it.
    await Promise.race([
      both,
      vi.waitFor(() => expect(harness.lanes.pending.waiting).toBe(2)),
    ])
    pull.release()
    expect(await Effect.runPromise(worker.finished)).toBeNull()
    await both

    const written = await readFile(corefile, "utf8")
    expect(written).toContain(`${after.domain}:${after.dnsPort} {`)
    expect(written).not.toContain("deleted")
    const coreDns = fakeDocker.container(harness.resources.coreDnsContainer)!
    expect(coreDns.state.running).toBe(true)
    expect(coreDns.env.KILN_NODE_ADDRESS).toBe(after.address)
    expect(Object.keys(coreDns.portBindings)).toEqual(
      expect.arrayContaining([`${after.dnsPort}/udp`, `${after.dnsPort}/tcp`])
    )
    expect(
      fakeDocker.container(harness.resources.instanceContainer(deletedServerId))
    ).toBeUndefined()
    expect(
      fakeDocker.container(harness.resources.instanceContainer(newServerId))
    ).toBeDefined()
  })

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
