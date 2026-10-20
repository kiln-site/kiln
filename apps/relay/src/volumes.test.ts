import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import { DockerEngine } from "./docker-engine.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness, TEST_NAMESPACE } from "./test/relay.js"
import { RelayVolumes } from "./volumes.js"

const volumeId = "3f9a21c4".padEnd(40, "0")
const appId = "a".repeat(40)

afterEach(() => {
  vi.unstubAllEnvs()
})

async function relayVolumes() {
  const harness = await relayHarness()
  return new RelayVolumes(
    harness.config,
    new DockerEngine(harness.config.dockerSocket),
    harness.state
  )
}

function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect)
}

async function listed(volumes: RelayVolumes) {
  return (await run(volumes.list())).volumes
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
        kind: "volume",
        mountpoint: `/var/lib/docker/volumes/${dockerName}/_data`,
        mounts: [],
        name: "Postgres Data!",
      }),
    ])
  })

  it("answers a repeated create with the volume it made, and refuses a name another volume holds", async () => {
    const volumes = await relayVolumes()
    await run(volumes.create(volumeId, "data"))

    await expect(run(volumes.create(volumeId, "data"))).resolves.toMatchObject(
      { id: volumeId }
    )
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

    let latest = first
    for (let tries = 0; tries < 100 && latest.measuring; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      latest = await run(volumes.list())
    }
    expect(latest).toMatchObject({
      measuring: false,
      volumes: [{ sizeBytes: 5 }],
    })
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
    const volumes = new RelayVolumes(
      harness.config,
      new DockerEngine(harness.config.dockerSocket),
      harness.state
    )
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
})
