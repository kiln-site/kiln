import { readFile, rm, writeFile } from "node:fs/promises"
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
  runPlatformCli,
  startPlatform,
} from "./platform.js"
import { createEncryptedPlatformBackup } from "./platform-backups.js"
import { collectPlatformRecovery } from "./platform-recovery.js"
import { restorePlatformFromBackup } from "./platform-restore.js"
import { platformDirectory, readPlatformState } from "./platform-state.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness, TEST_NAMESPACE } from "./test/relay.js"

// A lost machine's Kiln comes back from a platform backup and its recovery
// code alone, as the same Relay, so the restored Hearth reconnects to it,
// under a new installation ID that remembers the ones before it.

const url = "https://kiln.example.test"
const names = {
  database: `${TEST_NAMESPACE}-kiln-hearth-mysql`,
  hearth: `${TEST_NAMESPACE}-kiln-hearth`,
}

function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect)
}

// A Relay started with KILN_RELAY_MODE=platform, in its own container, on
// its own machine.
async function platformRelay() {
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
  const engine = new DockerEngine(harness.config.dockerSocket)
  return {
    config: harness.config,
    engine,
    state: harness.state,
    start: () =>
      run(
        startPlatform(harness.config, engine, {
          environment: { KILN_URL: url },
          pairedClients: 0,
          saveInputs: true,
        })
      ),
    pass: () =>
      run(
        reconcilePlatform({ attachRelay: true, config: harness.config, engine })
      ),
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

// A lost machine's backup and code, staged onto a new Relay by `platform
// restore`, ready for its first start.
async function stagedRestore() {
  const lost = await platformRelay()
  const { state: installed } = await lost.start()
  if (!installed) throw new Error("The Relay didn't install Kiln")
  await lost.pass()
  await run(loadOrCreateRelayIdentity(lost.config))
  await run(lost.state.restoreClients([hearthClient]))
  const backup = join(lost.config.dataDirectory, "kiln.kiln")
  await createEncryptedPlatformBackup(
    lost.config,
    {
      backupId: "d".repeat(40),
      maxBytes: null,
      target: { id: installed.installationId, kind: "platform" },
    } as unknown as BackupCreateTaskInput,
    backup,
    { completed: 0, total: 0 },
    new AbortController().signal,
    await run(collectPlatformRecovery(lost.config, lost.state))
  )
  const { code } = await run(platformRecoveryCode(lost.config))

  const fresh = await platformRelay()
  const restore = () =>
    run(
      restorePlatformFromBackup({
        code,
        config: fresh.config,
        engine: fresh.engine,
        source: backup,
        state: fresh.state,
        url: null,
      })
    )
  const cli = (command: string) =>
    run(
      runPlatformCli(
        ["platform", command],
        { attachRelay: true, config: fresh.config, engine: fresh.engine },
        () => {}
      )
    )
  await restore()
  return { cli, fresh, restore }
}

describe("restoring Kiln on a new machine", () => {
  it("brings Kiln back as the same Relay from a backup and its code", async () => {
    // The machine that's lost, with Kiln installed and its Hearth paired.
    const lost = await platformRelay()
    const { state: installed } = await lost.start()
    if (!installed) throw new Error("The Relay didn't install Kiln")
    await lost.pass()
    const identity = await run(loadOrCreateRelayIdentity(lost.config))
    await run(lost.state.restoreClients([hearthClient]))
    const lostDatabase = fakeDocker.container(names.database)
    if (!lostDatabase) throw new Error("Kiln's database didn't start")
    lostDatabase.sqlDump = "CREATE TABLE kept (id int);"
    const backup = join(lost.config.dataDirectory, "kiln.kiln")
    await createEncryptedPlatformBackup(
      lost.config,
      {
        backupId: "f".repeat(40),
        maxBytes: null,
        target: { id: installed.installationId, kind: "platform" },
      } as unknown as BackupCreateTaskInput,
      backup,
      { completed: 0, total: 0 },
      new AbortController().signal,
      await run(collectPlatformRecovery(lost.config, lost.state))
    )
    // What Hearth shows its administrators to save.
    const { code } = await run(platformRecoveryCode(lost.config))

    // A new machine, with only the backup and the code.
    const fresh = await platformRelay()
    const restore = (recoveryCode: string, onto = fresh, source = backup) =>
      run(
        restorePlatformFromBackup({
          code: recoveryCode,
          config: onto.config,
          engine: onto.engine,
          source,
          state: onto.state,
          url: null,
        })
      )
    await expect(restore("kiln-rk-not-the-key")).rejects.toThrow(
      "doesn't open with this recovery code"
    )
    await expect(restore("not a code")).rejects.toThrow("recovery code")
    expect(await run(readPlatformState(fresh.config.dataDirectory))).toBeNull()

    const restored = await restore(code)
    expect(restored).toEqual({
      installationId: expect.any(String),
      previousInstallationId: installed.installationId,
      url,
    })
    expect(restored.installationId).not.toBe(installed.installationId)
    expect(await run(readRelayIdentityMaterial(fresh.config))).toEqual({
      id: identity.id,
      name: identity.name,
      privateKeyPem: identity.privateKeyPem,
      publicKeyPem: identity.publicKeyPem,
    })
    expect(await run(fresh.state.listClients())).toMatchObject([
      { id: hearthClient.id, publicKey: hearthClient.publicKey },
    ])
    expect(
      await run(readPlatformState(fresh.config.dataDirectory))
    ).toMatchObject({
      hearth: { url },
      installationId: restored.installationId,
      phase: "maintenance",
      previousInstallationIds: [installed.installationId],
      secrets: {
        authSecrets: installed.secrets.authSecrets,
        platformBackupKey: installed.secrets.platformBackupKey,
      },
    })
    await expect(restore(code)).rejects.toThrow("already has an installation")

    // Its first start restores the backup, made under the ID before, into a
    // new database, then starts Hearth, telling it Kiln was restored and
    // which IDs it had.
    await fresh.start()
    await fresh.pass()
    expect(
      fakeDocker.container(names.database)?.executedSql.join("\n")
    ).toContain("CREATE TABLE kept (id int);")
    const hearth = fakeDocker.container(names.hearth)
    expect(hearth?.state.running).toBe(true)
    expect(hearth?.env).toMatchObject({
      KILN_INSTALLATION_ID: restored.installationId,
      KILN_PREVIOUS_INSTALLATION_IDS: installed.installationId,
      KILN_RESTORED_AT: expect.any(String),
    })
    expect(
      await run(readPlatformState(fresh.config.dataDirectory))
    ).toMatchObject({ phase: "ready" })
    // The backup it kept to restore is gone once restored.
    await expect(
      readFile(
        join(fresh.config.dataDirectory, "restores", "platform-restore.kiln")
      )
    ).rejects.toThrow()

    // Restored again, from the restored Kiln's own backup, it knows both.
    const restoredDatabase = fakeDocker.container(names.database)
    if (!restoredDatabase) throw new Error("Kiln's database didn't start")
    restoredDatabase.sqlDump = "CREATE TABLE kept (id int);"
    const second = join(fresh.config.dataDirectory, "again.kiln")
    await createEncryptedPlatformBackup(
      fresh.config,
      {
        backupId: "e".repeat(40),
        maxBytes: null,
        target: { id: restored.installationId, kind: "platform" },
      } as unknown as BackupCreateTaskInput,
      second,
      { completed: 0, total: 0 },
      new AbortController().signal,
      await run(collectPlatformRecovery(fresh.config, fresh.state))
    )
    const third = await platformRelay()
    const again = await restore(code, third, second)
    expect(
      await run(readPlatformState(third.config.dataDirectory))
    ).toMatchObject({
      installationId: again.installationId,
      previousInstallationIds: [
        installed.installationId,
        restored.installationId,
      ],
    })
  })

  it("doesn't resume a restore that fails: it starts over", async () => {
    const { cli, fresh, restore } = await stagedRestore()

    // Its first start can't import the backup. It says to start over, and
    // nothing tries it again or lets Hearth start on an empty database.
    await fresh.start()
    fakeDocker.programFailures.set("mysql", "Lost connection to MySQL server")
    const failed = await fresh.pass()
    expect(failed.issue).toContain("Start the restore over")
    fakeDocker.programFailures.delete("mysql")
    expect((await fresh.pass()).issue).toContain("Start the restore over")
    await expect(cli("start-hearth")).rejects.toThrow("Start the restore over")
    await expect(cli("stop-hearth")).rejects.toThrow("Start the restore over")
    expect(fakeDocker.container(names.hearth)?.state.running).not.toBe(true)
    expect(
      await run(readPlatformState(fresh.config.dataDirectory))
    ).toMatchObject({ phase: "maintenance" })

    // Stopped before it wrote Kiln's record, a Relay neither installs Kiln
    // new nor restores over what's there.
    await rm(
      join(platformDirectory(fresh.config.dataDirectory), "installation.json")
    )
    expect(await fresh.start()).toMatchObject({
      refused: expect.stringContaining("didn't finish"),
      state: null,
    })
    await expect(restore()).rejects.toThrow("didn't finish")
  })

  it("doesn't import again after the Relay stopped part way through", async () => {
    const { fresh } = await stagedRestore()
    // The Relay stopped while it was importing the backup.
    const marker = join(
      platformDirectory(fresh.config.dataDirectory),
      "restore.json"
    )
    await writeFile(
      marker,
      JSON.stringify({
        ...JSON.parse(await readFile(marker, "utf8")),
        importing: true,
      })
    )
    await fresh.start()
    const stopped = await fresh.pass()
    expect(stopped.issue).toContain("stopped while it was restoring")
    expect(fakeDocker.container(names.database)?.executedSql).toEqual([])
    expect(fakeDocker.container(names.hearth)?.state.running).not.toBe(true)
  })

  it("finishes, without importing again, once the backup is in", async () => {
    const { cli, fresh } = await stagedRestore()
    // The Relay stopped after it recorded the import, before Kiln was ready.
    const directory = platformDirectory(fresh.config.dataDirectory)
    const marker = JSON.parse(
      await readFile(join(directory, "restore.json"), "utf8")
    )
    await writeFile(
      join(directory, "restore.json"),
      JSON.stringify({ ...marker, importing: true })
    )
    await writeFile(
      join(directory, "restored.json"),
      JSON.stringify({ restoredAt: marker.restoredAt })
    )
    await fresh.start()
    await fresh.pass()
    expect(fakeDocker.container(names.database)?.executedSql).toEqual([])
    expect(fakeDocker.container(names.hearth)?.env.KILN_RESTORED_AT).toBe(
      marker.restoredAt
    )
    expect(
      await run(readPlatformState(fresh.config.dataDirectory))
    ).toMatchObject({ phase: "ready" })

    // Stopped again after Kiln was ready, before it removed the restore's
    // record: the next pass clears it, and nothing waits on it.
    await writeFile(
      join(directory, "restore.json"),
      JSON.stringify({ ...marker, importing: true })
    )
    await fresh.pass()
    await expect(readFile(join(directory, "restore.json"))).rejects.toThrow()
    expect(fakeDocker.container(names.hearth)?.state.running).toBe(true)

    // Or, before that pass, an operator holds Hearth stopped: it stays so.
    await writeFile(
      join(directory, "restore.json"),
      JSON.stringify({ ...marker, importing: true })
    )
    await cli("stop-hearth")
    await fresh.pass()
    expect(fakeDocker.container(names.hearth)?.state.running).not.toBe(true)
    expect(
      await run(readPlatformState(fresh.config.dataDirectory))
    ).toMatchObject({ phase: "maintenance" })
  })
})
