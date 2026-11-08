import { generateKeyPairSync } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { migratedInstanceId } from "@workspace/contracts"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { DockerEngine } from "./docker-engine.js"
import { fingerprint, loadOrCreateRelayIdentity } from "./effect/identity.js"
import { migrateInstanceIds } from "./instance-id-migration.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness, TEST_NAMESPACE } from "./test/relay.js"

// IDs from before 12-character instance IDs.
const serverId = "5".repeat(40)
const databaseId = "d".repeat(40)
const appId = "a".repeat(40)
const stackId = "7".repeat(40)

describe("the move to 12-character instance IDs", () => {
  it("addresses every old instance by its new ID and leaves what Docker and the disk hold where it was", async () => {
    const harness = await relayHarness()
    const { config, state } = harness
    const owner = { "kiln.relay.owner": TEST_NAMESPACE }

    // A Relay from before: its identity, a game server connected to a
    // database, an App, a Tailscale network, and records naming them.
    const keys = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    })
    const identityDirectory = join(config.dataDirectory, "network", "identity")
    await mkdir(identityDirectory, { recursive: true })
    await writeFile(join(identityDirectory, "identity.key"), keys.privateKey)
    await writeFile(
      join(identityDirectory, "identity.json"),
      JSON.stringify({
        name: "Old Relay",
        publicKeyPem: keys.publicKey,
        version: 1,
      })
    )
    const relayFingerprint = fingerprint(keys.publicKey)

    const databaseNetwork = `${TEST_NAMESPACE}-kiln-db-${databaseId}-network`
    const databaseLabels = {
      ...owner,
      "kiln.database.created-at": "2026-01-01T00:00:00.000Z",
      "kiln.database.database-name": "kiln_app",
      "kiln.database.engine": "postgres",
      "kiln.database.hostname": `database-${databaseId}`,
      "kiln.database.id": databaseId,
      "kiln.database.image": "postgres:17-alpine",
      "kiln.database.name": "Main database",
      "kiln.database.network": databaseNetwork,
      "kiln.database.volume": `${TEST_NAMESPACE}-kiln-db-${databaseId}-data`,
      "kiln.relay.managed": "true",
      "kiln.relay.owned": "true",
      "kiln.resource.kind": "database",
    }
    fakeDocker.addVolume({
      labels: databaseLabels,
      name: databaseLabels["kiln.database.volume"],
    })
    fakeDocker.addNetwork({
      internal: true,
      labels: databaseLabels,
      name: databaseNetwork,
    })
    const database = fakeDocker.addContainer({
      labels: databaseLabels,
      name: `${TEST_NAMESPACE}-kiln-db-${databaseId}-database`,
      networks: [databaseNetwork],
      running: true,
    })
    database.networks.get(databaseNetwork)!.aliases = [`database-${databaseId}`]

    const serverContainer = `${TEST_NAMESPACE}-kiln-${serverId.slice(0, 8)}`
    const server = await harness.seedServer({
      id: serverId,
      name: serverContainer,
      running: true,
    })
    fakeDocker.connect(serverContainer, databaseNetwork)
    server.networks.get(databaseNetwork)!.aliases = [`server-${serverId}`]

    const appNetwork = `${TEST_NAMESPACE}-kiln-app-${appId}-network`
    fakeDocker.addNetwork({
      labels: { ...owner, "kiln.app.id": appId, "kiln.resource.kind": "app" },
      name: appNetwork,
    })

    const stackDirectory = join(config.rootDirectory, stackId)
    await mkdir(stackDirectory, { recursive: true })
    await writeFile(
      join(stackDirectory, "stack.json"),
      `${JSON.stringify(
        {
          bindings: [
            {
              address: "10.140.2.10",
              enabled: true,
              hostname: "survival",
              memberId: `instance:${serverId}`,
            },
          ],
          domain: "example.ts.net",
          hostname: "kiln",
          id: stackId,
          name: "Friends",
          subnet: "10.140.2.0/24",
        },
        null,
        2
      )}\n`
    )

    await Effect.runPromise(
      state.setDatabaseConnection(
        {
          databaseId,
          memberId: serverId,
          memberKind: "instance",
          relayId: relayFingerprint,
        },
        true
      )
    )
    await Effect.runPromise(state.setInstanceName(serverId, "Survival"))

    // The Relay starts.
    const identity = await Effect.runPromise(loadOrCreateRelayIdentity(config))
    const migrate = () =>
      migrateInstanceIds({
        config,
        engine: new DockerEngine(config.dockerSocket),
        identity,
        state,
      })
    await migrate()

    const relayId = await migratedInstanceId({
      fingerprint: relayFingerprint,
      kind: "relay",
    })
    const newServerId = await migratedInstanceId({
      id: serverId,
      kind: "server",
      relayFingerprint,
    })
    const newDatabaseId = await migratedInstanceId({
      id: databaseId,
      kind: "database",
    })
    const newAppId = await migratedInstanceId({ id: appId, kind: "app" })
    const newStackId = await migratedInstanceId({
      id: stackId,
      kind: "tailscale",
    })

    // The Relay keeps the ID Hearth computes for it, and its fingerprint
    // only authenticates it.
    expect(identity).toMatchObject({
      fingerprint: relayFingerprint,
      id: relayId,
    })
    expect(
      JSON.parse(
        await readFile(join(identityDirectory, "identity.json"), "utf8")
      )
    ).toMatchObject({ id: relayId, version: 2 })

    // Each instance answers to its new ID, from the resources it had.
    expect(await harness.docker.findInstance(newServerId)).toMatchObject({
      directory: serverId,
      id: newServerId,
      service: serverContainer,
    })
    expect(await harness.docker.findInstance(serverId)).toBeNull()
    const [migratedDatabase] = await harness.databases.list()
    expect(migratedDatabase).toMatchObject({
      hostname: `database-${newDatabaseId}`,
      id: newDatabaseId,
    })
    expect(migratedDatabase?.members).toEqual([
      expect.objectContaining({ id: newServerId, kind: "instance" }),
    ])
    const [migratedApp] = await harness.apps.list()
    expect(migratedApp).toMatchObject({ id: newAppId, network: appNetwork })

    // On the database's network, each answers to its new name and its old.
    expect(database.networks.get(databaseNetwork)?.aliases).toEqual(
      expect.arrayContaining([
        `database-${newDatabaseId}`,
        `database-${databaseId}`,
      ])
    )
    expect(server.networks.get(databaseNetwork)?.aliases).toEqual(
      expect.arrayContaining([`server-${newServerId}`, `server-${serverId}`])
    )

    // Records and state files name the new IDs.
    expect(
      await Effect.runPromise(
        state.listMemberDatabaseConnections({
          id: newServerId,
          kind: "instance",
        })
      )
    ).toEqual([
      {
        databaseId: newDatabaseId,
        memberId: newServerId,
        memberKind: "instance",
        relayId,
      },
    ])
    expect(await Effect.runPromise(state.listInstanceNames())).toEqual([
      expect.objectContaining({ instanceId: newServerId, name: "Survival" }),
    ])
    const stack = JSON.parse(
      await readFile(join(stackDirectory, "stack.json"), "utf8")
    ) as { bindings: Array<{ memberId: string }>; id: string }
    expect(stack.id).toBe(newStackId)
    expect(stack.bindings[0]?.memberId).toBe(`instance:${newServerId}`)

    // Nothing physical moved or was renamed.
    expect(
      fakeDocker.container(serverContainer)?.labels["kiln.server.id"]
    ).toBe(serverId)
    expect(fakeDocker.networks.has(databaseNetwork)).toBe(true)
    expect(fakeDocker.networks.has(appNetwork)).toBe(true)
    expect(fakeDocker.volumes.has(databaseLabels["kiln.database.volume"])).toBe(
      true
    )

    // Starting again leaves it as it is.
    await migrate()
    expect(await harness.docker.findInstance(newServerId)).toMatchObject({
      id: newServerId,
    })
    expect(
      (await Effect.runPromise(loadOrCreateRelayIdentity(config))).id
    ).toBe(relayId)
  })
})
