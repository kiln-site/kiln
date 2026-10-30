import { RELAY_VOLUME_REFERENCES_PENDING } from "@workspace/contracts"
import { Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"

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
    // Nor frozen for its deletion.
    await expect(run(volumes.requireDeletable(volumeId))).rejects.toThrow(
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
})
