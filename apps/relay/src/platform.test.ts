import { createHmac } from "node:crypto"
import { hostname } from "node:os"

import { Effect, Fiber, ManagedRuntime, Metric } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test"

import { DockerEngine } from "./docker-engine.js"
import { sampleNodeMetrics } from "./node-metrics.js"
import {
  addOwnerInvitation,
  isPlatformOwner,
  platformTargetContainer,
  identifyHearth,
  platformStatus,
  reconcilePlatform,
  runPlatformCli,
  startPlatform,
} from "./platform.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness, TEST_NAMESPACE } from "./test/relay.js"

const url = "https://kiln.example.test"
const names = {
  cache: `${TEST_NAMESPACE}-kiln-hearth-cache`,
  database: `${TEST_NAMESPACE}-kiln-hearth-mysql`,
  hearth: `${TEST_NAMESPACE}-kiln-hearth`,
  network: `${TEST_NAMESPACE}-kiln-platform`,
  volume: `${TEST_NAMESPACE}-kiln-hearth-mysql`,
}

function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect)
}

// A Relay started with KILN_RELAY_MODE=platform, in its own container.
async function platformRelay(environment: Record<string, string> = {}) {
  // Tests don't run in the Relay's container, so they name it.
  const harness = await relayHarness({
    KILN_RELAY_CONTAINER: hostname(),
    KILN_RELAY_MODE: "platform",
  })
  fakeDocker.addContainer({
    image: "ghcr.io/kiln-site/relay:latest-nightly",
    name: hostname(),
    running: true,
  })
  const engine = new DockerEngine(harness.config.dockerSocket)
  const context = { attachRelay: true, config: harness.config, engine }
  return {
    config: harness.config,
    context,
    harness,
    /** Starts the Relay, as `index.ts` does before it pairs. */
    start: (
      input: {
        environment?: Record<string, string>
        pairedClients?: number
      } = {}
    ) =>
      run(
        startPlatform(harness.config, engine, {
          environment: { KILN_URL: url, ...environment, ...input.environment },
          pairedClients: input.pairedClients ?? 0,
          saveInputs: true,
        })
      ),
    pass: () => run(reconcilePlatform(context)),
    cli: async (...args: Array<string>) => {
      const printed: Array<string> = []
      await run(
        runPlatformCli(["platform", ...args], context, (text) =>
          printed.push(text)
        )
      )
      return printed.join("\n")
    },
  }
}

describe("platform mode", () => {
  it("never starts an empty database in place of one whose volume was lost", async () => {
    const relay = await platformRelay()
    const { state } = await relay.start()
    await relay.pass()
    fakeDocker.removeContainer(names.database)
    fakeDocker.volumes.delete(names.volume)

    const result = await relay.pass()

    expect(result.blocked).toBe(true)
    expect(result.issue).toContain("volume")
    expect(fakeDocker.volumes.has(names.volume)).toBe(false)
    expect(fakeDocker.container(names.database)).toBeUndefined()
    const status = await run(
      platformStatus(
        { ...relay.context, blocked: result.blocked, issue: result.issue },
        null
      )
    )
    expect(status.phase).toBe("blocked")

    // An operator confirms: the database starts empty and Hearth waits,
    // stopped, for a platform backup to be restored into it.
    await expect(relay.cli("recover", "--confirm", "wrong")).rejects.toThrow(
      "--confirm"
    )
    await relay.cli("recover", "--confirm", state?.installationId ?? "")
    expect(fakeDocker.volumes.has(names.volume)).toBe(true)
    expect(fakeDocker.container(names.database)?.state.running).toBe(true)
    expect(fakeDocker.container(names.hearth)?.state.running).toBe(false)
    await relay.pass()
    expect(fakeDocker.container(names.hearth)?.state.running).toBe(false)

    await relay.cli("start-hearth")
    expect(fakeDocker.container(names.hearth)?.state.running).toBe(true)
  })

  it("lets only the Hearth it installed manage Kiln's services", async () => {
    const relay = await platformRelay()
    const { state } = await relay.start()
    const owner = { invitationId: "bootstrap", role: "full_access" as const }
    const withOwner = await run(
      addOwnerInvitation(relay.config.dataDirectory, "bootstrap")
    )

    expect(isPlatformOwner(state, owner)).toBe(false)
    expect(isPlatformOwner(withOwner, owner)).toBe(true)
    expect(isPlatformOwner(withOwner, { ...owner, role: "read_only" })).toBe(
      false
    )
    expect(
      isPlatformOwner(withOwner, { ...owner, invitationId: "another-pairing" })
    ).toBe(false)
    expect(isPlatformOwner(null, owner)).toBe(false)
  })
})

describe("Kiln deployed without Kiln's labels", () => {
  const secret = "1:hearth-secret"
  const databaseVolume = {
    destination: "/var/lib/mysql",
    source: "mysql-data-ir20rpu9xgaz",
    type: "volume" as const,
  }

  // Hearth, its MySQL, and its Valkey as Coolify deploys them: no Kiln
  // labels, on Coolify's network, the database by container name and the
  // cache by an alias.
  async function coolify() {
    const harness = await relayHarness({ KILN_INSTALLATION_ID: "coolify" })
    const labels = { "coolify.managed": "true" }
    fakeDocker.addNetwork({ name: "coolify" })
    const hearth = fakeDocker.addContainer({
      env: {
        BETTER_AUTH_SECRETS: secret,
        CACHE_HOST: "cache",
        DB_HOST: "ir20rpu9xgaz",
        KILN_URL: "https://kiln.example.test",
      },
      image: "ghcr.io/kiln-site/hearth:latest",
      labels,
      name: "y7m44jcsfszy-074805",
      networks: ["coolify"],
      running: true,
    })
    const database = fakeDocker.addContainer({
      image: "mysql:8.4",
      labels,
      mounts: [databaseVolume],
      name: "ir20rpu9xgaz",
      networks: ["coolify"],
      running: true,
    })
    fakeDocker
      .addContainer({
        image: "valkey/valkey:9.1.2-alpine",
        labels,
        name: "c675ux4n93qd",
        networks: ["coolify"],
        running: true,
      })
      .networks.get("coolify")
      ?.aliases.push("cache")
    // Another app's database on the same network.
    fakeDocker.addContainer({
      image: "postgres:17",
      labels,
      name: "another-database",
      networks: ["coolify"],
      running: true,
    })
    const engine = new DockerEngine(harness.config.dockerSocket)
    const context = {
      blocked: false,
      config: harness.config,
      engine,
      issue: null,
    }
    return {
      context,
      database,
      harness,
      hearth,
      // What a Relay checks when a Hearth connects, then saves.
      identify: (claim: {
        containerId: string
        installationId?: string
        key: string
      }) =>
        run(
          identifyHearth(engine, harness.config, harness.state, {
            containerId: claim.containerId,
            installationId: claim.installationId ?? "coolify",
            proof: createHmac("sha256", claim.key)
              .update("transcript")
              .digest("base64url"),
            transcript: "transcript",
          })
        ),
      status: () => run(platformStatus(context, null)),
    }
  }

  const containersInGroup = (relayId: string, group: string) =>
    run(
      Metric.snapshot.pipe(
        Effect.map((snapshots) => {
          const found = snapshots.find(
            ({ attributes, id }) =>
              id === "relay.container.count" &&
              attributes?.["relay.id"] === relayId &&
              attributes["kiln.container.group"] === group
          )
          return (found?.state as { value?: number } | undefined)?.value
        })
      )
    )

  it("reports a proven Hearth's containers under their own metric groups", async () => {
    const kiln = await coolify()
    await expect(
      kiln.identify({ containerId: kiln.hearth.id, key: secret })
    ).resolves.toBe(true)

    const relayId = "relay-beside-coolify"
    // Virtual time for the samples; Docker's answers take real time.
    const clock = ManagedRuntime.make(TestClock.layer())
    const sampler = clock.runFork(
      sampleNodeMetrics(
        () => relayId,
        kiln.context.engine,
        kiln.harness.config,
        kiln.harness.docker.allocations
      )
    )
    onTestFinished(async () => {
      await run(Fiber.interrupt(sampler))
      await clock.dispose()
    })
    await vi.waitFor(
      async () => {
        await clock.runPromise(TestClock.adjust("15 seconds"))
        await expect(containersInGroup(relayId, "hearth")).resolves.toBe(1)
      },
      // Slowly enough that a search isn't timed out by the jumps themselves.
      { interval: 250, timeout: 4_000 }
    )
    await expect(containersInGroup(relayId, "mysql")).resolves.toBe(1)
    await expect(containersInGroup(relayId, "valkey")).resolves.toBe(1)
    // The other app's database stays where everything else Kiln doesn't run is.
    await expect(containersInGroup(relayId, "database")).resolves.toBe(0)
    await expect(containersInGroup(relayId, "other")).resolves.toBe(1)
  })

  it("keeps sampling while finding Hearth's containers is stuck", async () => {
    const kiln = await coolify()
    await expect(
      kiln.identify({ containerId: kiln.hearth.id, key: secret })
    ).resolves.toBe(true)
    const stuck = fakeDocker.hold({
      command: "inspect",
      target: kiln.hearth.name,
    })

    const relayId = "relay-with-a-stuck-search"
    const sampler = Effect.runFork(
      sampleNodeMetrics(
        () => relayId,
        kiln.context.engine,
        kiln.harness.config,
        kiln.harness.docker.allocations
      )
    )
    onTestFinished(async () => {
      stuck.release()
      await run(Fiber.interrupt(sampler))
    })
    await stuck.reached
    await vi.waitFor(async () => {
      await expect(containersInGroup(relayId, "other")).resolves.toBe(4)
    })
  })

  it("reports nothing for a Hearth that can't prove the container it names", async () => {
    const kiln = await coolify()

    // Without the container's secret, or naming a container without one.
    await expect(
      kiln.identify({ containerId: kiln.hearth.id, key: "1:guessed" })
    ).resolves.toBe(false)
    await expect(
      kiln.identify({ containerId: kiln.database.id, key: secret })
    ).resolves.toBe(false)
    // A proven Hearth of another installation.
    await expect(
      kiln.identify({
        containerId: kiln.hearth.id,
        installationId: "another-installation",
        key: secret,
      })
    ).resolves.toBe(false)

    expect((await kiln.status()).services).toEqual([])
    await expect(
      run(platformTargetContainer(kiln.context, "database"))
    ).resolves.toBeNull()
  })
})
