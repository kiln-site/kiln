import { createHmac } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"
import { describe, expect, it, onTestFinished } from "vite-plus/test"

import { loadConfig } from "./config.js"
import { DockerEngine } from "./docker-engine.js"
import { loadInstallationId } from "./installation.js"
import {
  addOwnerInvitation,
  externalPlatformPresent,
  isPlatformOwner,
  platformManagedContainer,
  platformTargetContainer,
  identifyHearth,
  platformUpdateRefusal,
  restartPlatformService,
  withPlatformRestoreHold,
  platformStatus,
  reconcilePlatform,
  runPlatformCli,
  startPlatform,
} from "./platform.js"
import { readPlatformState, withPlatformLock } from "./platform-state.js"
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

// A record of Kiln's updater replacing Hearth, as it writes them.
function writeUpdateRecord(directory: string, id: string, status: string) {
  return writeFile(
    join(directory, `${id}.json`),
    JSON.stringify({
      component: "hearth",
      error: null,
      finishedAt: status === "running" ? null : new Date().toISOString(),
      id,
      previousImage: "ghcr.io/kiln-site/hearth:latest",
      requestedImage: "ghcr.io/kiln-site/hearth:latest",
      startedAt: new Date().toISOString(),
      status,
      targetContainer: names.hearth,
      version: "0.1.0",
    })
  )
}

function env(name: string) {
  const container = fakeDocker.container(name)
  if (!container) throw new Error(`${name} doesn't exist`)
  return container.env
}

describe("platform mode", () => {
  it("installs Hearth, its database, and its cache, paired to the Relay with the secrets it saved", async () => {
    const relay = await platformRelay()
    const { state } = await relay.start()
    const result = await relay.pass()

    expect(result).toMatchObject({ blocked: false, issue: null })
    const saved = await run(readPlatformState(relay.config.dataDirectory))
    expect(saved).toMatchObject({
      installationId: state?.installationId,
      phase: "ready",
    })
    for (const name of [names.database, names.cache, names.hearth]) {
      const container = fakeDocker.container(name)
      expect(container?.state.running).toBe(true)
      expect(container?.restartPolicy).toBe("unless-stopped")
      expect(container?.labels).toMatchObject({
        "io.kiln.installation": state?.installationId,
        "kiln.relay.owner": TEST_NAMESPACE,
      })
      expect([...(container?.networks.keys() ?? [])]).toEqual([names.network])
    }
    // Platform backups find the database by its Compose labels.
    expect(fakeDocker.container(names.database)?.labels).toMatchObject({
      "io.kiln.resource": "hearth-database",
    })
    expect(fakeDocker.container(names.hearth)?.labels).toMatchObject({
      "io.kiln.resource": "hearth",
    })
    expect(fakeDocker.container(names.database)?.mounts).toEqual([
      expect.objectContaining({
        destination: "/var/lib/mysql",
        source: names.volume,
        type: "volume",
      }),
    ])
    // Hearth reaches the database, the cache, and the Relay on Kiln's
    // network, with the credentials the Relay generated once.
    expect(env(names.hearth)).toMatchObject({
      BETTER_AUTH_SECRETS: saved?.secrets.authSecrets,
      CACHE_HOST: names.cache,
      DB_HOST: names.database,
      DB_PASSWORD: env(names.database).MYSQL_PASSWORD,
      KILN_INSTALLATION_ID: state?.installationId,
      KILN_RELAY_BOOTSTRAP_TOKEN: relay.config.bootstrapToken,
      KILN_RELAY_HOST: relay.config.advertisedHost,
      KILN_SETUP_TOKEN: saved?.secrets.setupToken,
      KILN_URL: url,
    })
    expect(fakeDocker.container(names.hearth)?.image).toBe(
      "ghcr.io/kiln-site/hearth:latest-nightly"
    )
    expect(fakeDocker.container(names.hearth)?.portBindings).toEqual({
      "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "3000" }],
    })
    expect(
      fakeDocker.container(hostname())?.networks.get(names.network)?.aliases
    ).toContain(relay.config.advertisedHost)
    // The Relay keeps the installation's identity and backup key.
    expect(relay.config).toMatchObject({
      installationId: state?.installationId,
      installationIdConfigured: true,
      platformBackupKey: saved?.secrets.platformBackupKey,
    })
  })

  it("picks up an interrupted install with the secrets it saved first", async () => {
    const relay = await platformRelay()
    const first = await relay.start()
    fakeDocker.failNext(
      { command: "create", target: names.hearth },
      "connection reset"
    )
    expect((await relay.pass()).issue).toContain("connection reset")
    expect(fakeDocker.container(names.hearth)).toBeUndefined()
    const databaseId = fakeDocker.container(names.database)?.id

    // The Relay restarts and carries on.
    const second = await relay.start()
    expect(second.state).toMatchObject({
      installationId: first.state?.installationId,
      secrets: first.state?.secrets,
    })
    expect((await relay.pass()).issue).toBeNull()
    expect(fakeDocker.container(names.database)?.id).toBe(databaseId)
    expect(env(names.hearth).DB_PASSWORD).toBe(
      first.state?.secrets.databasePassword
    )
  })

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

  it("installs only on a new Relay", async () => {
    const relay = await platformRelay()

    const paired = await relay.start({ pairedClients: 1 })

    expect(paired.state).toBeNull()
    expect(paired.refused).toContain("already belongs to an installation")
    expect(await run(readPlatformState(relay.config.dataDirectory))).toBeNull()

    // A Relay that adopted a Hearth's installation ID is just as taken.
    relay.config.installationId = "existing-installation"
    expect((await relay.start()).refused).toContain(
      "already belongs to an installation"
    )
  })

  it("leaves Hearth alone while Kiln's updater is replacing it", async () => {
    const relay = await platformRelay()
    await relay.start()
    await relay.pass()
    // Mid-update the old container has been renamed aside and the new one
    // isn't created yet.
    const updates = join(relay.config.dataDirectory, "updates")
    await mkdir(updates, { recursive: true })
    await writeFile(join(updates, `${names.hearth}.lock`), "operation\n")
    const hearth = fakeDocker.container(names.hearth)
    if (hearth) hearth.name = `${names.hearth}-kiln-update-backup`

    await relay.pass()

    expect(fakeDocker.container(names.hearth)).toBeUndefined()
  })

  it("recreates Hearth after an update that finished left its lock behind", async () => {
    const relay = await platformRelay()
    await relay.start()
    await relay.pass()
    const updates = join(relay.config.dataDirectory, "updates")
    await mkdir(updates, { recursive: true })
    await writeFile(join(updates, `${names.hearth}.lock`), "finished\n")
    await writeUpdateRecord(updates, "finished", "succeeded")
    fakeDocker.removeContainer(names.hearth)

    await relay.pass()

    expect(fakeDocker.container(names.hearth)?.state.running).toBe(true)
  })

  it("doesn't recreate Hearth for new settings while an update runs", async () => {
    const relay = await platformRelay()
    await relay.start()
    await relay.pass()
    const hearth = fakeDocker.container(names.hearth)?.id
    const updates = join(relay.config.dataDirectory, "updates")
    await mkdir(updates, { recursive: true })
    await writeFile(join(updates, `${names.hearth}.lock`), "running\n")
    await writeUpdateRecord(updates, "running", "running")

    await relay.start({
      environment: { RESEND_FROM_EMAIL: "kiln@example.test" },
    })
    await relay.pass()

    expect(fakeDocker.container(names.hearth)?.id).toBe(hearth)
    // A repair leaves no lock of its own behind for the updater to trip on.
    expect(await readFile(join(updates, `${names.hearth}.lock`), "utf8")).toBe(
      "running\n"
    )
    expect(
      await readFile(join(updates, `${names.cache}.lock`), "utf8").catch(
        () => null
      )
    ).toBeNull()
  })

  it("keeps the backup key its recovery kit holds", async () => {
    const relay = await platformRelay()
    const { state } = await relay.start()
    relay.config.platformBackupKey = "k".repeat(48)

    await relay.start()

    expect(relay.config.platformBackupKey).toBe(
      state?.secrets.platformBackupKey
    )
  })

  it("lets one process at a time change the installation", async () => {
    const relay = await platformRelay()
    await relay.start()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const holder = run(
      withPlatformLock(
        relay.config.dataDirectory,
        Effect.promise(() => held)
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    await expect(
      run(
        withPlatformLock(relay.config.dataDirectory, Effect.void, {
          waitMs: 300,
        })
      )
    ).rejects.toThrow("Another Relay process")

    release()
    await holder
    await run(withPlatformLock(relay.config.dataDirectory, Effect.void))
  })

  it("holds maintenance through updates, restarts, and restores", async () => {
    const relay = await platformRelay()
    await relay.start()
    await relay.pass()
    const updates = join(relay.config.dataDirectory, "updates")
    await mkdir(updates, { recursive: true })
    const lock = join(updates, `${names.hearth}.lock`)

    // An update holds Hearth: stop-hearth says it couldn't stop it yet.
    await writeFile(lock, "running\n")
    await writeUpdateRecord(updates, "running", "running")
    await expect(relay.cli("stop-hearth")).rejects.toThrow("being updated")
    await expect(
      run(withPlatformRestoreHold(relay.config, Effect.succeed("restored")))
    ).rejects.toThrow("being updated")

    // Once it finishes, Hearth stops and stays stopped.
    await writeUpdateRecord(updates, "running", "succeeded")
    await relay.cli("stop-hearth")
    expect(fakeDocker.container(names.hearth)?.state.running).toBe(false)
    await expect(
      run(restartPlatformService(relay.context, "hearth"))
    ).rejects.toThrow("maintenance")
    expect(
      await run(platformUpdateRefusal(relay.config.dataDirectory, names.hearth))
    ).toContain("maintenance")
    expect(fakeDocker.container(names.hearth)?.state.running).toBe(false)

    // A restore runs holding Hearth's update lock, which it gives back.
    const restored = await run(
      withPlatformRestoreHold(
        relay.config,
        Effect.promise(() => readFile(lock, "utf8"))
      )
    )
    expect(restored).toMatch(/^platform-/u)
    expect(await readFile(lock, "utf8").catch(() => null)).toBeNull()

    await relay.cli("start-hearth")
    expect(fakeDocker.container(names.hearth)?.state.running).toBe(true)
    await expect(
      run(withPlatformRestoreHold(relay.config, Effect.void))
    ).rejects.toThrow("stop-hearth")
  })

  it("doesn't touch another installation's container", async () => {
    const relay = await platformRelay()
    const other = fakeDocker.addContainer({
      image: "ghcr.io/kiln-site/hearth:latest",
      labels: { "io.kiln.installation": "someone-else" },
      name: names.hearth,
      running: false,
    })
    await relay.start()

    const result = await relay.pass()

    expect(result).toMatchObject({ blocked: true })
    expect(result.issue).toContain("doesn't belong to this installation")
    expect(fakeDocker.container(names.hearth)).toMatchObject({
      id: other.id,
      state: expect.objectContaining({ running: false }),
    })
  })

  it("won't start its database on another installation's volume", async () => {
    const relay = await platformRelay()
    fakeDocker.addVolume({
      labels: { "io.kiln.installation": "someone-else" },
      name: names.volume,
    })
    await relay.start()

    expect((await relay.pass()).issue).toContain(
      "doesn't belong to this installation"
    )
    expect(fakeDocker.container(names.database)).toBeUndefined()
  })

  it("recreates Hearth when its settings change and keeps the database running", async () => {
    const relay = await platformRelay()
    await relay.start()
    await relay.pass()
    const database = fakeDocker.container(names.database)?.id
    const hearth = fakeDocker.container(names.hearth)?.id

    await relay.start({
      environment: {
        KILN_URL: "https://panel.example.test",
        RESEND_FROM_EMAIL: "kiln@example.test",
      },
    })
    await relay.pass()

    expect(fakeDocker.container(names.hearth)?.id).not.toBe(hearth)
    expect(env(names.hearth)).toMatchObject({
      KILN_URL: "https://panel.example.test",
      RESEND_FROM_EMAIL: "kiln@example.test",
    })
    expect(fakeDocker.container(names.database)?.id).toBe(database)
    // Starting with the same settings changes nothing.
    const recreated = fakeDocker.container(names.hearth)?.id
    await relay.pass()
    expect(fakeDocker.container(names.hearth)?.id).toBe(recreated)
  })

  it("restarts what stopped and recreates what's missing", async () => {
    const relay = await platformRelay()
    await relay.start()
    await relay.pass()
    fakeDocker.exit(names.cache, { exitCode: 137 })
    fakeDocker.removeContainer(names.hearth)

    await relay.pass()

    expect(fakeDocker.container(names.cache)?.state.running).toBe(true)
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

  it("opens shells only in the containers Kiln runs", async () => {
    const relay = await platformRelay()
    await relay.start()
    await relay.pass()
    const coolify = fakeDocker.addContainer({
      image: "traefik:v3.7",
      name: "coolify-proxy",
      running: true,
    })
    const managed = (target: "database" | "proxy") =>
      run(platformManagedContainer(relay.context, target))

    // Coolify's proxy is read, not entered.
    await expect(
      run(platformTargetContainer(relay.context, "proxy"))
    ).resolves.toMatchObject({ Id: coolify.id })
    await expect(managed("proxy")).resolves.toBeNull()
    await expect(managed("database")).resolves.toMatchObject({
      Name: `/${names.database}`,
    })

    const own = fakeDocker.addContainer({
      image: "traefik:v3.7.13",
      labels: { "kiln.relay.infrastructure": "traefik" },
      name: relay.harness.resources.traefikContainer,
      running: true,
    })
    await expect(managed("proxy")).resolves.toMatchObject({ Id: own.id })
  })

  it("opens no shells in Kiln's services from a Relay that only reports them", async () => {
    const harness = await relayHarness({ KILN_INSTALLATION_ID: "compose" })
    fakeDocker.addContainer({
      image: "mysql:8.4",
      labels: {
        "io.kiln.installation": "compose",
        "io.kiln.resource": "hearth-database",
      },
      name: "compose-mysql",
      running: true,
    })
    const context = {
      config: harness.config,
      engine: new DockerEngine(harness.config.dockerSocket),
    }

    await expect(
      run(platformTargetContainer(context, "database"))
    ).resolves.toMatchObject({ Name: "/compose-mysql" })
    await expect(
      run(platformManagedContainer(context, "database"))
    ).resolves.toBeNull()
  })

  it("restores an installation's secrets on a new Relay from its recovery kit", async () => {
    const relay = await platformRelay()
    const { state } = await relay.start()
    await relay.pass()
    const kit = await relay.cli("export-kit")
    const directory = await mkdtemp(join(tmpdir(), "kiln-kit-"))
    onTestFinished(() => rm(directory, { force: true, recursive: true }))
    const kitPath = join(directory, "kiln-recovery.json")
    await writeFile(kitPath, kit)

    // A new host: none of the old containers or volumes exist.
    for (const name of [names.hearth, names.cache, names.database]) {
      fakeDocker.removeContainer(name)
    }
    fakeDocker.volumes.delete(names.volume)
    const config = loadConfig({
      KILN_RELAY_DATA_DIR: join(directory, "relay"),
      KILN_RELAY_HOST: "relay.test",
      KILN_RELAY_MODE: "platform",
      KILN_RELAY_RESOURCE_NAMESPACE: TEST_NAMESPACE,
      NODE_ENV: "test",
    })
    config.dockerSocket = relay.config.dockerSocket
    const context = { config, engine: relay.context.engine }
    const cli = (...args: Array<string>) =>
      run(runPlatformCli(["platform", ...args], context, () => undefined))

    await cli("import-kit", kitPath)
    await expect(cli("import-kit", kitPath)).rejects.toThrow(
      "already has an installation"
    )
    await cli("repair")

    const restored = await run(readPlatformState(config.dataDirectory))
    expect(restored).toMatchObject({
      installationId: state?.installationId,
      phase: "maintenance",
      secrets: state?.secrets,
    })
    expect(env(names.database).MYSQL_PASSWORD).toBe(
      state?.secrets.databasePassword
    )
    // Hearth waits for the platform backup to be restored first.
    expect(fakeDocker.container(names.hearth)?.state.running ?? false).toBe(
      false
    )
    expect(JSON.parse(await readFile(kitPath, "utf8"))).toMatchObject({
      kind: "kiln-platform-recovery-kit",
    })
  })

  it("repairs from a recovery container without moving Hearth off the Relay", async () => {
    const relay = await platformRelay()
    await relay.start()
    await relay.pass()
    const hearth = fakeDocker.container(names.hearth)?.id
    fakeDocker.removeContainer(names.cache)
    // A recovery container shares the Relay's volume, but not its
    // environment or its container.
    const config = loadConfig({
      KILN_RELAY_DATA_DIR: relay.config.dataDirectory,
      KILN_RELAY_RESOURCE_NAMESPACE: TEST_NAMESPACE,
      NODE_ENV: "test",
    })
    config.dockerSocket = relay.config.dockerSocket

    await run(
      runPlatformCli(
        ["platform", "repair"],
        { config, engine: relay.context.engine },
        () => undefined
      )
    )

    expect(fakeDocker.container(names.cache)?.state.running).toBe(true)
    expect(fakeDocker.container(names.hearth)?.id).toBe(hearth)
    expect(env(names.hearth).KILN_RELAY_HOST).toBe(relay.config.advertisedHost)
  })

  it("joins no container to Kiln's network when it can't tell which is its own", async () => {
    const relay = await platformRelay()
    await relay.start()
    // Not named, and not this test's container: discovery finds nothing it
    // can prove is the Relay.
    relay.config.selfContainer = null
    fakeDocker.addContainer({
      hostname: hostname(),
      image: "example/other:latest",
      name: "someone-elses",
      running: true,
    })

    const result = await relay.pass()

    expect(result.issue).toContain("KILN_RELAY_CONTAINER")
    expect(fakeDocker.container("someone-elses")?.networks.size).toBe(0)
    expect(fakeDocker.container(hostname())?.networks.has(names.network)).toBe(
      false
    )
  })

  it("won't start its database on a volume another deployment created meanwhile", async () => {
    const relay = await platformRelay()
    await relay.start()
    // The volume appears between the Relay's check and its create, and
    // Docker answers the create with it.
    const held = fakeDocker.hold({
      command: "volume create",
      target: names.volume,
    })
    const pass = relay.pass()
    await held.reached
    fakeDocker.addVolume({
      labels: { "io.kiln.installation": "someone-else" },
      name: names.volume,
    })
    held.release()

    const result = await pass

    expect(result.issue).toContain("doesn't belong to this installation")
    expect(fakeDocker.container(names.database)).toBeUndefined()
  })

  it("requires a hostname for the Relay and a URL for Hearth", async () => {
    expect(() =>
      loadConfig({
        KILN_RELAY_HOST: "203.0.113.10",
        KILN_RELAY_MODE: "platform",
        NODE_ENV: "test",
      })
    ).toThrow("KILN_RELAY_HOST must be a hostname")

    const relay = await platformRelay()
    await expect(
      run(
        startPlatform(relay.config, relay.context.engine, {
          environment: {},
          pairedClients: 0,
          saveInputs: true,
        })
      )
    ).rejects.toThrow("KILN_URL")
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

  it("reports Hearth, and the database and cache it uses, once Hearth proves its container", async () => {
    const kiln = await coolify()
    expect((await kiln.status()).services).toEqual([])

    await expect(
      kiln.identify({ containerId: kiln.hearth.id, key: secret })
    ).resolves.toBe(true)

    const status = await kiln.status()
    expect(status).toMatchObject({
      hearthUrl: "https://kiln.example.test",
      management: "external",
    })
    expect(
      status.services.map(({ actions, container, managedBy, role }) => ({
        actions,
        container,
        managedBy,
        role,
      }))
    ).toEqual([
      {
        actions: [],
        container: "y7m44jcsfszy-074805",
        managedBy: "coolify",
        role: "hearth",
      },
      {
        actions: [],
        container: "ir20rpu9xgaz",
        managedBy: "coolify",
        role: "database",
      },
      {
        actions: [],
        container: "c675ux4n93qd",
        managedBy: "coolify",
        role: "cache",
      },
    ])
    await expect(
      run(externalPlatformPresent(kiln.context.engine, kiln.harness.config))
    ).resolves.toBe(true)
    await expect(
      run(platformManagedContainer(kiln.context, "database"))
    ).resolves.toBeNull()

    // A restarted Relay remembers it, and follows Coolify recreating the
    // database under the same name.
    kiln.harness.config.provenHearth = null
    await run(loadInstallationId(kiln.harness.config, kiln.harness.state))
    fakeDocker.removeContainer("ir20rpu9xgaz")
    const recreated = fakeDocker.addContainer({
      image: "mysql:8.4",
      mounts: [databaseVolume],
      name: "ir20rpu9xgaz",
      networks: ["coolify"],
      running: true,
    })
    await expect(
      run(platformTargetContainer(kiln.context, "database"))
    ).resolves.toMatchObject({ Id: recreated.id })

    // Another container that takes over the address Hearth uses.
    fakeDocker.removeContainer("ir20rpu9xgaz")
    fakeDocker.addContainer({
      image: "mysql:8.4",
      name: "elsewhere",
      running: true,
    })
    const takeover = fakeDocker.addContainer({
      image: "mysql:8.4",
      name: "ir20rpu9xgaz",
      networks: ["coolify"],
      running: true,
    })
    await expect(
      run(platformTargetContainer(kiln.context, "database"))
    ).resolves.toMatchObject({ Id: takeover.id })
  })

  it("finds Kiln's services after Coolify removes Hearth's container, and Hearth once Coolify recreates it", async () => {
    const kiln = await coolify()
    await kiln.identify({ containerId: kiln.hearth.id, key: secret })

    // Coolify stops Hearth by removing its container. The cache kept no
    // data, so nothing shows it's the same one.
    fakeDocker.removeContainer("y7m44jcsfszy-074805")
    await expect(
      run(platformTargetContainer(kiln.context, "hearth"))
    ).resolves.toBeNull()
    await expect(
      run(platformTargetContainer(kiln.context, "database"))
    ).resolves.toMatchObject({ Id: kiln.database.id })
    await expect(
      run(platformTargetContainer(kiln.context, "cache"))
    ).resolves.toBeNull()

    // Another container under the database's name, without its data.
    fakeDocker.removeContainer("ir20rpu9xgaz")
    fakeDocker.addContainer({
      mounts: [{ ...databaseVolume, source: "another-app-data" }],
      name: "ir20rpu9xgaz",
      running: true,
    })
    await expect(
      run(platformTargetContainer(kiln.context, "database"))
    ).resolves.toBeNull()

    // Started again under a new ID, before it connects to prove it.
    const restarted = fakeDocker.addContainer({
      env: {
        BETTER_AUTH_SECRETS: secret,
        CACHE_HOST: "cache",
        DB_HOST: "ir20rpu9xgaz",
      },
      name: "y7m44jcsfszy-091500",
      networks: ["coolify"],
      running: true,
    })
    // Another Hearth on the host, with its own secret.
    fakeDocker.addContainer({
      env: { BETTER_AUTH_SECRETS: "1:another-secret" },
      name: "another-hearth",
      running: true,
    })
    await expect(
      run(platformTargetContainer(kiln.context, "hearth"))
    ).resolves.toMatchObject({ Id: restarted.id })
  })

  it("saves the newest of overlapping claims, and none from a Hearth that stopped while it was checked", async () => {
    const kiln = await coolify()
    // A redeploy moves the database while the old Hearth's check stalls.
    let held = fakeDocker.hold({
      command: "ps",
      target: JSON.stringify({ network: ["coolify"] }),
    })
    const old = kiln.identify({ containerId: kiln.hearth.id, key: secret })
    await held.reached
    fakeDocker.addContainer({
      mounts: [{ ...databaseVolume, source: "mysql-data-moved" }],
      name: "moved-database",
      networks: ["coolify"],
      running: true,
    })
    const replacement = fakeDocker.addContainer({
      env: { BETTER_AUTH_SECRETS: secret, DB_HOST: "moved-database" },
      name: "y7m44jcsfszy-091500",
      networks: ["coolify"],
      running: true,
    })
    const newer = kiln.identify({ containerId: replacement.id, key: secret })
    held.release()

    await expect(old).resolves.toBe(false)
    await expect(newer).resolves.toBe(true)
    expect(kiln.harness.config.provenHearth).toMatchObject({
      containerId: replacement.id,
      database: { name: "moved-database" },
    })

    // The old Hearth reconnects, then stops before its check finishes.
    held = fakeDocker.hold({
      command: "inspect",
      target: "y7m44jcsfszy-074805",
    })
    const stopping = kiln.identify({ containerId: kiln.hearth.id, key: secret })
    await held.reached
    kiln.hearth.state.running = false
    held.release()

    await expect(stopping).resolves.toBe(false)
    expect(kiln.harness.config.provenHearth).toMatchObject({
      containerId: replacement.id,
    })
  })

  it("prefers a running Hearth with the proven one's secret over the stopped proven container", async () => {
    const kiln = await coolify()
    await kiln.identify({ containerId: kiln.hearth.id, key: secret })
    kiln.hearth.state.running = false
    const replacement = fakeDocker.addContainer({
      env: { BETTER_AUTH_SECRETS: secret, DB_HOST: "ir20rpu9xgaz" },
      name: "y7m44jcsfszy-091500",
      networks: ["coolify"],
      running: true,
    })

    await expect(
      run(platformTargetContainer(kiln.context, "hearth"))
    ).resolves.toMatchObject({ Id: replacement.id })
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
