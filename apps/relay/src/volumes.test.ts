import { RELAY_VOLUME_REFERENCES_PENDING } from "@workspace/contracts"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import { DockerEngine } from "./docker-engine.js"
import { fakeDocker } from "./test/docker.js"
import {
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"
import { RelayVolumes } from "./volumes.js"

const volumeId = "3f9a21c4".padEnd(40, "0")
const appId = "a".repeat(40)

afterEach(() => {
  vi.unstubAllEnvs()
})

async function relayVolumes(harness?: RelayHarness) {
  const relay = harness ?? (await relayHarness())
  return new RelayVolumes(
    relay.config,
    new DockerEngine(relay.config.dockerSocket),
    relay.state,
    () => relay.lifecycle.hostDataDirectory()
  )
}

function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect)
}

// A Hearth's control connection, as the control socket reports one; each
// call is a new connection.
function connect(volumes: RelayVolumes, clientId: string): string {
  const connectionId = `${clientId}-${Math.random().toString(16).slice(2)}`
  volumes.clientConnected(clientId, connectionId)
  return connectionId
}

// A Hearth paired with the Relay, as the control socket pairs one.
async function pairHearth(
  harness: RelayHarness,
  id: string,
  role: "full_access" | "read_only" = "full_access"
) {
  const now = Date.now()
  await run(
    harness.state.createInvitation({
      actions: [],
      createdAt: now,
      expiresAt: now + 60_000,
      id: `invitation-${id}`,
      role,
      tokenHash: `hash-${id}`,
    })
  )
  await run(
    harness.state.pairClient({
      actions: [],
      id,
      invitationId: `invitation-${id}`,
      name: id,
      origins: [],
      pairedAt: now,
      publicKey: `key-${id}`,
      role,
      sourceCidrs: [],
    })
  )
}

async function listed(volumes: RelayVolumes) {
  return (await run(volumes.list())).volumes
}

// Lists until Docker's measure is done; it's real I/O against the fake.
async function measured(volumes: RelayVolumes) {
  let latest = await run(volumes.list())
  for (let tries = 0; tries < 100 && latest.measuring; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    latest = await run(volumes.list())
  }
  return latest
}

describe("Relay volumes", () => {
  it("makes a Docker volume named after its ID and name, labeled as the Relay's", async () => {
    const volumes = await relayVolumes()

    await run(volumes.create(volumeId, "Postgres Data!"))

    const dockerName = `${TEST_NAMESPACE}-kiln-3f9a21c4-postgres-data`
    expect(fakeDocker.volumes.get(dockerName)?.labels).toEqual({
      "kiln.relay.owner": TEST_NAMESPACE,
      "kiln.resource.kind": "volume",
      "kiln.volume.id": volumeId,
      "kiln.volume.name": "Postgres Data!",
    })
    expect(await listed(volumes)).toEqual([
      expect.objectContaining({
        dockerName,
        id: volumeId,
        kind: "kiln",
        mountpoint: `/var/lib/docker/volumes/${dockerName}/_data`,
        mounts: [],
        name: "Postgres Data!",
      }),
    ])
  })

  it("answers a repeated create with the volume it made, and refuses a name another volume holds", async () => {
    const volumes = await relayVolumes()
    await run(volumes.create(volumeId, "data"))

    await expect(run(volumes.create(volumeId, "data"))).resolves.toMatchObject({
      id: volumeId,
    })
    // Another ID with the same short ID, whose name a volume already has.
    fakeDocker.addVolume({ name: `${TEST_NAMESPACE}-kiln-3f9a21c4-cache` })
    await expect(
      run(volumes.create("3f9a21c4".padEnd(40, "1"), "cache"))
    ).rejects.toThrow("already exists")
  })

  it("refuses a second volume under an ID another volume has", async () => {
    const volumes = await relayVolumes()
    await run(volumes.create(volumeId, "data"))

    await expect(run(volumes.create(volumeId, "uploads"))).rejects.toThrow(
      "Another volume already has this ID"
    )
    expect(
      [...fakeDocker.volumes.values()].filter(
        (volume) => volume.labels["kiln.volume.id"] === volumeId
      )
    ).toHaveLength(1)
  })

  it("lists volumes without waiting on Docker to measure them, then reports their sizes", async () => {
    const volumes = await relayVolumes()
    const created = await run(volumes.create(volumeId, "data"))
    fakeDocker.volumes.get(created.dockerName)!.files.set("/a", "hello")

    const first = await run(volumes.list())
    expect(first).toMatchObject({
      measuring: true,
      volumes: [{ sizeBytes: null }],
    })

    expect(await measured(volumes)).toMatchObject({
      measuring: false,
      volumes: [{ sizeBytes: 5 }],
    })
  })

  it("measures a volume made since the last measure right away", async () => {
    const volumes = await relayVolumes()
    await run(volumes.create(volumeId, "data"))
    await measured(volumes)

    const later = await run(volumes.create("b".repeat(40), "cache"))
    fakeDocker.volumes.get(later.dockerName)!.files.set("/a", "hi")

    expect((await run(volumes.list())).measuring).toBe(true)
    expect(await measured(volumes)).toMatchObject({
      measuring: false,
      volumes: [
        { name: "cache", sizeBytes: 2 },
        { name: "data", sizeBytes: 0 },
      ],
    })
  })

  it("stops measuring once Docker leaves a volume out of its measure", async () => {
    const volumes = await relayVolumes()
    const created = await run(volumes.create(volumeId, "data"))
    // As Docker leaves out volumes of other drivers, such as NFS.
    fakeDocker.volumes.get(created.dockerName)!.driver = "nfs"

    expect(await measured(volumes)).toMatchObject({
      measuring: false,
      volumes: [{ sizeBytes: null }],
    })
    expect((await run(volumes.list())).measuring).toBe(false)
  })

  it("stops measuring for a while once Docker fails to, so callers stop waiting", async () => {
    const volumes = await relayVolumes()
    await run(volumes.create(volumeId, "data"))
    fakeDocker.failNext({ command: "system df" }, "context deadline exceeded")

    expect((await run(volumes.list())).measuring).toBe(true)

    expect(await measured(volumes)).toMatchObject({
      measuring: false,
      volumes: [{ sizeBytes: null }],
    })
    expect((await run(volumes.list())).measuring).toBe(false)
  })

  it("lists only its own volumes, with the containers that mount each", async () => {
    const volumes = await relayVolumes()
    const created = await run(volumes.create(volumeId, "shared"))
    fakeDocker.addVolume({ name: "someone-elses" })
    fakeDocker.addVolume({
      labels: {
        "kiln.relay.owner": "another-relay",
        "kiln.resource.kind": "volume",
        "kiln.volume.id": "b".repeat(40),
      },
      name: "another-relay-kiln-bbbbbbbb-shared",
    })
    fakeDocker.addContainer({
      labels: { "kiln.app.id": appId, "kiln.resource.kind": "app" },
      mounts: [
        {
          destination: "/srv",
          readOnly: true,
          source: created.dockerName,
          type: "volume",
        },
      ],
      name: "web",
      running: true,
    })

    const [shared, ...others] = await listed(volumes)

    expect(others).toEqual([])
    expect(shared?.mounts).toEqual([
      {
        container: "web",
        destination: "/srv",
        kind: "app",
        readOnly: true,
        resourceId: appId,
        running: true,
      },
    ])
  })

  it("keeps a new name while Docker keeps the volume's own", async () => {
    const volumes = await relayVolumes()
    const created = await run(volumes.create(volumeId, "data"))

    await run(volumes.rename(volumeId, "Uploads"))

    expect(await listed(volumes)).toEqual([
      expect.objectContaining({
        dockerName: created.dockerName,
        name: "Uploads",
      }),
    ])
  })

  it("refuses to delete a volume a container mounts, then deletes it once none does", async () => {
    const volumes = await relayVolumes()
    const created = await run(volumes.create(volumeId, "data"))
    const container = fakeDocker.addContainer({
      mounts: [
        { destination: "/data", source: created.dockerName, type: "volume" },
      ],
      name: "worker",
    })

    await expect(run(volumes.delete(volumeId))).rejects.toThrow(
      "worker mounts this volume"
    )
    expect(fakeDocker.volumes.has(created.dockerName)).toBe(true)

    fakeDocker.containers.delete(container.id)
    await run(volumes.delete(volumeId))

    expect(fakeDocker.volumes.has(created.dockerName)).toBe(false)
    expect(await listed(volumes)).toEqual([])
  })

  it("lists the Relay's own data volume, which no request can name to delete", async () => {
    const harness = await relayHarness()
    const volumes = await relayVolumes(harness)
    fakeDocker.addVolume({ name: "kiln_relay-data" })
    const relay = fakeDocker.addContainer({
      mounts: [
        {
          destination: harness.config.dataDirectory,
          source: "kiln_relay-data",
          type: "volume",
        },
      ],
      name: "kiln-relay-1",
      running: true,
    })
    vi.stubEnv("HOSTNAME", relay.id.slice(0, 12))

    expect(await listed(volumes)).toEqual([
      expect.objectContaining({
        dockerName: "kiln_relay-data",
        id: null,
        kind: "relay",
        mounts: [expect.objectContaining({ kind: "relay" })],
      }),
    ])
  })
  it("refuses to delete a volume an App's configuration names, though the App isn't deployed", async () => {
    const harness = await relayHarness()
    const volumes = await relayVolumes(harness)
    await pairHearth(harness, "hearth-a")
    await harness.apps.create({ id: appId, name: "Website" })
    const created = await run(volumes.create(volumeId, "media"))

    // Until the Hearth has said which configurations name which volumes,
    // none can be deleted.
    await expect(run(volumes.delete(volumeId))).rejects.toThrow(
      RELAY_VOLUME_REFERENCES_PENDING
    )
    await run(
      volumes.importAppReferences(
        "hearth-a",
        connect(volumes, "hearth-a"),
        [{ appId, volumeIds: [volumeId] }],
        []
      )
    )
    await expect(run(volumes.delete(volumeId))).rejects.toThrow(
      "An App's configuration mounts this volume"
    )
    expect(fakeDocker.volumes.has(created.dockerName)).toBe(true)

    await run(volumes.writeAppReferences("hearth-a", appId, []))
    await run(volumes.delete(volumeId))

    expect(fakeDocker.volumes.has(created.dockerName)).toBe(false)
  })

  it("waits for every paired Hearth, even a read-only one, and forgets a revoked one", async () => {
    const harness = await relayHarness()
    const volumes = await relayVolumes(harness)
    await pairHearth(harness, "hearth-a")
    // Read-only now, it may still keep configurations from before.
    await pairHearth(harness, "hearth-b", "read_only")
    await harness.apps.create({ id: appId, name: "Website" })
    const created = await run(volumes.create(volumeId, "media"))

    // Hearth A's import says nothing about Hearth B's Apps.
    await run(
      volumes.importAppReferences(
        "hearth-a",
        connect(volumes, "hearth-a"),
        [],
        []
      )
    )
    await expect(run(volumes.delete(volumeId))).rejects.toThrow(
      "waiting for hearth-b to connect"
    )
    // Hearth B's undeployed App names the volume.
    await run(
      volumes.importAppReferences(
        "hearth-b",
        connect(volumes, "hearth-b"),
        [{ appId, volumeIds: [volumeId] }],
        []
      )
    )
    await expect(run(volumes.delete(volumeId))).rejects.toThrow(
      "An App's configuration mounts this volume"
    )

    // A Hearth paired since owes its configurations before anything goes.
    await pairHearth(harness, "hearth-c")
    await run(harness.state.revokeClient("hearth-b", Date.now()))
    const hearthC = connect(volumes, "hearth-c")
    await expect(run(volumes.delete(volumeId))).rejects.toThrow(
      "waiting for hearth-c to send"
    )
    await run(volumes.importAppReferences("hearth-c", hearthC, [], []))

    // What revoked Hearth B said no longer keeps the volume.
    await run(volumes.delete(volumeId))
    expect(fakeDocker.volumes.has(created.dockerName)).toBe(false)
  })

  it("counts a Hearth's import only on the connection that sent it, as after its database is restored", async () => {
    const harness = await relayHarness()
    const volumes = await relayVolumes(harness)
    await pairHearth(harness, "hearth-a")
    await harness.apps.create({ id: appId, name: "Website" })
    await run(volumes.create(volumeId, "media"))
    await run(
      volumes.importAppReferences(
        "hearth-a",
        connect(volumes, "hearth-a"),
        [],
        []
      )
    )

    // Its restored database names the volume again; it connects anew, and
    // an import from the old connection, arriving late, doesn't count.
    const stale = "hearth-a-before-restore"
    const current = connect(volumes, "hearth-a")
    await expect(
      run(volumes.importAppReferences("hearth-a", stale, [], []))
    ).rejects.toThrow("no longer the Hearth's current one")
    await expect(run(volumes.delete(volumeId))).rejects.toThrow(
      "waiting for hearth-a to send"
    )
    await run(
      volumes.importAppReferences(
        "hearth-a",
        current,
        [{ appId, volumeIds: [volumeId] }],
        []
      )
    )
    await expect(run(volumes.delete(volumeId))).rejects.toThrow(
      "An App's configuration mounts this volume"
    )
  })

  it("holds a Hearth's configurations once deletions under way finish, until it sends them on a new connection", async () => {
    const harness = await relayHarness()
    const volumes = await relayVolumes(harness)
    await pairHearth(harness, "hearth-a")
    await harness.apps.create({ id: appId, name: "Website" })
    const first = await run(volumes.create(volumeId, "media"))
    const otherId = "4e0b31d5".padEnd(40, "0")
    const other = await run(volumes.create(otherId, "cache"))
    const before = connect(volumes, "hearth-a")
    await run(volumes.importAppReferences("hearth-a", before, [], []))

    // A deletion that decided on what Hearth sent before finishes first.
    const removing = fakeDocker.hold({ command: "volume rm" })
    const deleting = run(volumes.delete(volumeId))
    await removing.reached
    let held = false
    const holding = run(volumes.holdAppReferences("hearth-a", before)).then(
      () => {
        held = true
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(held).toBe(false)
    removing.release()
    await deleting
    await holding
    expect(fakeDocker.volumes.has(first.dockerName)).toBe(false)

    // Then nothing is deleted until Hearth sends what it holds now, and
    // the connection it held on can't send what it held before.
    await expect(run(volumes.delete(otherId))).rejects.toThrow(
      "waiting for hearth-a to send"
    )
    await expect(
      run(volumes.importAppReferences("hearth-a", before, [], []))
    ).rejects.toThrow("send them on a new one")
    const after = connect(volumes, "hearth-a")
    await run(
      volumes.importAppReferences(
        "hearth-a",
        after,
        [{ appId, volumeIds: [otherId] }],
        []
      )
    )
    await expect(run(volumes.delete(otherId))).rejects.toThrow(
      "An App's configuration mounts this volume"
    )
    expect(fakeDocker.volumes.has(other.dockerName)).toBe(true)
  })

  it("holds a Hearth's configurations behind a deletion under way, ahead of deletions asked for since", async () => {
    const harness = await relayHarness()
    const volumes = await relayVolumes(harness)
    await pairHearth(harness, "hearth-a")
    const connection = connect(volumes, "hearth-a")
    await run(volumes.importAppReferences("hearth-a", connection, [], []))
    const ids = ["4e0b31d5", "5f1c42e6", "6a2d53f7"].map((prefix) =>
      prefix.padEnd(40, "0")
    )
    const made = await Promise.all(
      ids.map((id, index) => run(volumes.create(id, `cache-${index}`)))
    )

    const removing = fakeDocker.hold({ command: "volume rm" })
    const first = run(volumes.delete(ids[0]!))
    await removing.reached
    const holding = run(volumes.holdAppReferences("hearth-a", connection))
    // Deletions keep arriving while the hold waits.
    const later = ids.slice(1).map((id) =>
      run(volumes.delete(id)).then(
        () => null,
        (error: unknown) => (error as Error).message
      )
    )
    removing.release()
    await first
    await holding

    // They waited behind it, so they see what it held.
    for (const message of await Promise.all(later)) {
      expect(message).toContain("waiting for hearth-a to send")
    }
    expect(fakeDocker.volumes.has(made[1]!.dockerName)).toBe(true)
    expect(fakeDocker.volumes.has(made[2]!.dockerName)).toBe(true)
  })

  it("forgets only what the Hearth that deleted an App said of it", async () => {
    const harness = await relayHarness()
    const volumes = await relayVolumes(harness)
    await pairHearth(harness, "hearth-a")
    await pairHearth(harness, "hearth-b")
    await harness.apps.create({ id: appId, name: "Website" })
    await run(volumes.create(volumeId, "media"))
    await run(
      volumes.importAppReferences(
        "hearth-a",
        connect(volumes, "hearth-a"),
        [],
        [appId]
      )
    )
    await run(
      volumes.importAppReferences(
        "hearth-b",
        connect(volumes, "hearth-b"),
        [],
        [appId]
      )
    )

    await run(volumes.forgetApp("hearth-a", appId))

    // Hearth B still owes the configuration it couldn't read.
    await expect(run(volumes.delete(volumeId))).rejects.toThrow(
      "hearth-b couldn't read an App's configuration"
    )
    await expect(run(volumes.delete(volumeId))).rejects.not.toThrow(
      "hearth-a couldn't read"
    )
  })

  it("keeps waiting for a configuration its Hearth couldn't read until it can", async () => {
    const harness = await relayHarness()
    const volumes = await relayVolumes(harness)
    await pairHearth(harness, "hearth-a")
    await harness.apps.create({ id: appId, name: "Website" })
    const created = await run(volumes.create(volumeId, "media"))

    await run(
      volumes.importAppReferences(
        "hearth-a",
        connect(volumes, "hearth-a"),
        [],
        [appId]
      )
    )
    await expect(run(volumes.delete(volumeId))).rejects.toThrow(
      "hearth-a couldn't read an App's configuration"
    )
    expect((await run(volumes.list())).protection.ready).toBe(false)

    // Read since, it names no volume.
    await run(volumes.writeAppReferences("hearth-a", appId, []))
    await run(volumes.delete(volumeId))
    expect(fakeDocker.volumes.has(created.dockerName)).toBe(false)
  })

  it("lets a deleted App's configuration no longer keep a volume", async () => {
    const harness = await relayHarness()
    const volumes = await relayVolumes(harness)
    await pairHearth(harness, "hearth-a")
    await harness.apps.create({ id: appId, name: "Website" })
    const created = await run(volumes.create(volumeId, "media"))
    await run(
      volumes.importAppReferences(
        "hearth-a",
        connect(volumes, "hearth-a"),
        [{ appId, volumeIds: [volumeId] }],
        []
      )
    )

    await harness.apps.delete({ appId, deleteData: true })
    await run(volumes.delete(volumeId))

    expect(fakeDocker.volumes.has(created.dockerName)).toBe(false)
  })

  it("refuses to record a configuration naming a volume that's gone", async () => {
    const harness = await relayHarness()
    const volumes = await relayVolumes(harness)
    await harness.apps.create({ id: appId, name: "Website" })

    await expect(
      run(volumes.writeAppReferences("hearth-a", appId, [volumeId]))
    ).rejects.toThrow("no longer exists")
  })

  it("lists who owns and uses each volume, and what Apps mount that no volume covers", async () => {
    const harness = await relayHarness()
    const volumes = await relayVolumes(harness)
    const configuring = "a".repeat(40)
    const mounting = "b".repeat(40)
    await harness.apps.create({ id: configuring, name: "Configures it" })
    await harness.apps.create({ id: mounting, name: "Mounts it" })
    const shared = await run(volumes.create(volumeId, "shared"))
    await pairHearth(harness, "hearth-a")
    await run(
      volumes.importAppReferences(
        "hearth-a",
        connect(volumes, "hearth-a"),
        [{ appId: configuring, volumeIds: [volumeId] }],
        []
      )
    )
    const project = `${TEST_NAMESPACE}-kiln-app-${mounting}`
    fakeDocker.addVolume({
      labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.volume": "db",
      },
      name: `${project}_db`,
    })
    // Another Relay's App, sharing the daemon.
    fakeDocker.addVolume({
      labels: {
        "com.docker.compose.project": `elsewhere-kiln-app-${mounting}`,
        "com.docker.compose.volume": "db",
      },
      name: `elsewhere-kiln-app-${mounting}_db`,
    })
    const anonymous = "e".repeat(64)
    fakeDocker.addVolume({ name: anonymous })
    fakeDocker.addContainer({
      labels: {
        "com.docker.compose.project": project,
        "kiln.app.id": mounting,
        "kiln.app.service": "web",
        "kiln.relay.owner": TEST_NAMESPACE,
        "kiln.resource.kind": "app",
      },
      mounts: [
        { destination: "/shared", source: shared.dockerName, type: "volume" },
        { destination: "/db", source: `${project}_db`, type: "volume" },
        { destination: "/cache", source: anonymous, type: "volume" },
        { destination: "/media", source: "/srv/media", type: "bind" },
      ],
      name: "web",
      running: true,
    })

    const listing = await run(volumes.list())

    expect(listing.protection).toEqual({ ready: true, reason: null })
    expect(
      listing.volumes.map(({ dockerName, id, kind, owner, users }) => ({
        dockerName,
        id,
        kind,
        owner,
        users,
      }))
    ).toEqual([
      {
        dockerName: `${project}_db`,
        id: `${mounting}/db`,
        kind: "app",
        owner: { appId: mounting, volume: "db" },
        users: [{ appId: mounting, configured: false, mounted: true }],
      },
      {
        dockerName: shared.dockerName,
        id: volumeId,
        kind: "kiln",
        owner: null,
        users: [
          { appId: configuring, configured: true, mounted: false },
          { appId: mounting, configured: false, mounted: true },
        ],
      },
    ])
    expect(listing.uncovered).toEqual([
      expect.objectContaining({
        appId: mounting,
        destination: "/cache",
        kind: "anonymous",
        service: "web",
      }),
      expect.objectContaining({
        appId: mounting,
        destination: "/media",
        kind: "bind",
        source: "/srv/media",
      }),
    ])
  })
})
