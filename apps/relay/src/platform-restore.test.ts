import { readdir, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"

import type { BackupCreateTaskInput } from "@workspace/contracts"

import { DockerEngine } from "./docker-engine.js"
import {
  loadOrCreateRelayIdentity,
  readRelayIdentityMaterial,
} from "./effect/identity.js"
import {
  platformRecoveryCode,
  reconcilePlatform,
  startPlatform,
} from "./platform.js"
import { createEncryptedPlatformBackup } from "./platform-backups.js"
import { collectPlatformRecovery } from "./platform-recovery.js"
import { restorePlatform } from "./platform-restore.js"
import { platformDirectory, readPlatformState } from "./platform-state.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness, TEST_NAMESPACE } from "./test/relay.js"

const url = "https://kiln.example.test"
const names = {
  database: `${TEST_NAMESPACE}-kiln-hearth-mysql`,
  hearth: `${TEST_NAMESPACE}-kiln-hearth`,
}

function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect)
}

// A machine of its own, whose Relay starts with KILN_RELAY_MODE=platform.
async function machine() {
  fakeDocker.reset()
  const harness = await relayHarness({
    KILN_RELAY_CONTAINER: hostname(),
    KILN_RELAY_MODE: "platform",
  })
  fakeDocker.addContainer({
    image: "ghcr.io/kiln-site/relay:latest-nightly",
    name: hostname(),
    running: true,
  })
  const { config, state } = harness
  const engine = new DockerEngine(config.dockerSocket)
  const printed: Array<string> = []
  // As telemetry does, whatever the Relay is started to do.
  await run(loadOrCreateRelayIdentity(config))
  return {
    backup: async (file: string) => {
      const installed = await run(readPlatformState(config.dataDirectory))
      const path = join(config.dataDirectory, file)
      await createEncryptedPlatformBackup(
        config,
        {
          backupId: "d".repeat(40),
          maxBytes: null,
          target: { id: installed!.installationId, kind: "platform" },
        } as unknown as BackupCreateTaskInput,
        path,
        { completed: 0, total: 0 },
        new AbortController().signal,
        await run(collectPlatformRecovery(config, state))
      )
      return path
    },
    config,
    // What its database was given last.
    imported: () => fakeDocker.container(names.database)?.executedSql.at(-1),
    hearthRuns: () =>
      fakeDocker.container(names.hearth)?.state.running ?? false,
    pass: () => run(reconcilePlatform({ attachRelay: true, config, engine })),
    record: () => run(readPlatformState(config.dataDirectory)),
    printed,
    restore: (
      source: string,
      code: string,
      environment: NodeJS.ProcessEnv = {}
    ) =>
      run(
        restorePlatform({
          config,
          engine,
          environment,
          print: (text) => printed.push(text),
          recoveryCode: async () => code,
          source,
          state,
        })
      ),
    start: (environment: NodeJS.ProcessEnv = {}) =>
      run(
        startPlatform(config, engine, {
          environment: { KILN_URL: url, ...environment },
          pairedClients: 0,
          saveInputs: true,
        })
      ),
    state,
  }
}

const hearthClient = {
  actions: [],
  createdAt: 1_790_000_000_000,
  id: "hearth-client",
  invitationId: "bootstrap",
  name: "Hearth",
  origins: [url],
  publicKey: "hearth-public-key",
  role: "full_access" as const,
  sourceCidrs: [],
}

// A Kiln that's running, its backup, and what opens it.
async function runningKiln(environment: NodeJS.ProcessEnv = {}) {
  const kiln = await machine()
  await kiln.start(environment)
  await kiln.pass()
  const identity = await run(loadOrCreateRelayIdentity(kiln.config))
  await run(kiln.state.restoreClients([hearthClient]))
  fakeDocker.container(names.database)!.sqlDump = "CREATE TABLE kept (id int);"
  const backup = await kiln.backup("kiln.kiln")
  const { code } = await run(platformRecoveryCode(kiln.config))
  return { backup, code, identity, kiln, record: (await kiln.record())! }
}

describe("restoring Kiln", () => {
  it("brings it back on a new machine as the same Kiln on the same Relay", async () => {
    const lost = await runningKiln()
    const fresh = await machine()

    await fresh.restore(lost.backup, lost.code)

    expect(fresh.imported()).toContain("CREATE TABLE kept (id int);")
    expect(await fresh.record()).toMatchObject({
      installationId: lost.record.installationId,
      ownerInvitationIds: lost.record.ownerInvitationIds,
      phase: "ready",
      secrets: lost.record.secrets,
    })
    expect(await run(readRelayIdentityMaterial(fresh.config))).toMatchObject({
      id: lost.identity.id,
      privateKeyPem: lost.identity.privateKeyPem,
    })
    expect(await run(fresh.state.listClients())).toMatchObject([
      { id: hearthClient.id, publicKey: hearthClient.publicKey },
    ])

    await fresh.start()
    await fresh.pass()
    expect(fresh.hearthRuns()).toBe(true)
  })

  it("finishes when it's run again after the import fails partway", async () => {
    const lost = await runningKiln()
    const fresh = await machine()
    fakeDocker.programFailures.set("mysql", "Lost connection to MySQL server")
    await expect(fresh.restore(lost.backup, lost.code)).rejects.toThrow(
      "run this again"
    )
    await fresh.start()
    await fresh.pass()
    expect(fresh.hearthRuns()).toBe(false)
    // As one killed while importing leaves, secrets included.
    const restores = join(fresh.config.dataDirectory, "restores")
    await writeFile(join(restores, ".platform-left.dmp.gz"), "secrets")

    // It had stopped after the dump dropped the database.
    fakeDocker.programFailures.delete("mysql")
    fakeDocker.programFailures.set(
      "mysqldump",
      "Got error: 1049: Unknown database 'kiln' when selecting the database"
    )
    await fresh.restore(lost.backup, lost.code)

    expect(fresh.imported()).toContain("CREATE TABLE kept (id int);")
    expect(await readdir(restores)).toEqual([])
    await fresh.pass()
    expect(fresh.hearthRuns()).toBe(true)
  })

  it("writes nothing for a wrong code, and then takes the right one", async () => {
    const lost = await runningKiln()
    const fresh = await machine()

    await expect(fresh.restore(lost.backup, "kiln-rk-wrong")).rejects.toThrow(
      "doesn't open with this recovery code"
    )
    expect(await fresh.record()).toBeNull()

    await fresh.restore(lost.backup, lost.code)
    expect(await fresh.record()).toMatchObject({ phase: "ready" })
  })

  it("asks where a Kiln that listened on one address listens here", async () => {
    const lost = await runningKiln({ KILN_PLATFORM_HEARTH_BIND: "127.0.0.1" })
    const fresh = await machine()

    await expect(fresh.restore(lost.backup, lost.code)).rejects.toThrow(
      "listened only on 127.0.0.1"
    )
    expect(await fresh.record()).toBeNull()

    await fresh.restore(lost.backup, lost.code, {
      KILN_PLATFORM_HEARTH_BIND: "127.0.0.1",
    })
    expect(await fresh.record()).toMatchObject({
      hearth: { bindAddress: "127.0.0.1" },
      phase: "ready",
    })
  })

  it("leaves another Relay, or another Kiln, on the machine as it is", async () => {
    const lost = await runningKiln()
    const relay = await machine()
    const identity = await run(loadOrCreateRelayIdentity(relay.config))
    await run(
      relay.state.restoreClients([{ ...hearthClient, id: "other-hearth" }])
    )

    await expect(relay.restore(lost.backup, lost.code)).rejects.toThrow(
      "already has another Relay"
    )
    expect(await run(readRelayIdentityMaterial(relay.config))).toMatchObject({
      id: identity.id,
    })

    const other = await runningKiln()
    await expect(other.kiln.restore(lost.backup, lost.code)).rejects.toThrow(
      "doesn't open with this Kiln's key"
    )
    expect(other.kiln.hearthRuns()).toBe(true)
  })

  it("saves what's there before replacing it, which undoes the restore", async () => {
    const { backup, code, kiln } = await runningKiln()
    const database = fakeDocker.container(names.database)!
    database.sqlDump = "CREATE TABLE made_since (id int);"

    await kiln.restore(backup, code)
    expect(kiln.imported()).toContain("CREATE TABLE kept (id int);")

    const directory = platformDirectory(kiln.config.dataDirectory)
    const [saved] = (await readdir(directory)).filter((file) =>
      file.startsWith("before-restore-")
    )
    await kiln.restore(join(directory, saved!), code)
    expect(kiln.imported()).toContain("CREATE TABLE made_since (id int);")
    await kiln.pass()
    expect(kiln.hearthRuns()).toBe(true)
  })

  it("offers to undo to what was running, never to what a failed try left", async () => {
    const { backup, code, kiln } = await runningKiln()
    fakeDocker.programFailures.set("mysql", "Lost connection to MySQL server")
    await expect(kiln.restore(backup, code)).rejects.toThrow("run this again")
    fakeDocker.programFailures.delete("mysql")

    await kiln.restore(backup, code)

    expect(
      kiln.printed.filter((line) => line.startsWith("Saved"))
    ).toHaveLength(2)
    expect(kiln.printed.join("\n")).not.toContain("To undo")
    await kiln.restore(backup, code)
    expect(kiln.printed.join("\n")).toContain("To undo")
  })

  it("drops the schedules on the Relay, which Hearth sends again from what it has", async () => {
    const { backup, code, kiln } = await runningKiln()
    await run(
      kiln.state.schedules.apply(
        {
          actions: [
            {
              action: "stop",
              id: "a4c1e6b9-2f7d-4c0a-8e35-7b9d2c6f1e44",
              type: "power",
            },
          ],
          continueOnFailure: false,
          cron: "0 3 * * *",
          enabled: true,
          id: "14bb1e12-fab9-45f3-8f85-ae22d2f074e5",
          name: "Made since the backup",
          revision: 1,
          targets: [
            {
              id: "1".repeat(12),
              kind: "app",
              name: "Shop",
              relayId: "a".repeat(12),
            },
          ],
        },
        Date.now() + 60_000
      )
    )

    await kiln.restore(backup, code)

    expect((await run(kiln.state.schedules.overview())).deployments).toEqual([])
  })

  it("restores nothing when what's there can't be saved first", async () => {
    const { backup, code, kiln } = await runningKiln()
    const database = fakeDocker.container(names.database)!
    fakeDocker.programFailures.set(
      "mysqldump",
      "Table './kiln/kiln_user' is marked as crashed"
    )
    const before = database.executedSql.length

    await expect(kiln.restore(backup, code)).rejects.toThrow(
      "so nothing was restored"
    )
    expect(database.executedSql.length).toBe(before)
  })
})
