import "reflect-metadata"

import { webcrypto } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname } from "node:path"

import {
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509"
import { relayCreateDatabaseSchema } from "@workspace/contracts"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { PublicDatabases } from "./database-public.js"
import { DockerEngine } from "./docker-engine.js"
import { databaseBrick } from "./test/database-bricks.js"
import { fakeDocker } from "./test/docker.js"
import {
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"
import { webCertificateStorePath } from "./web-certificates.js"

const id = "d".repeat(12)
const gate = `${TEST_NAMESPACE}-kiln-db-${id}-public`
const opened = { hostnames: ["db.example.com"], port: 25_432 }

// Traefik's store, holding a certificate for each of these names.
async function traefikHolds(
  harness: RelayHarness,
  names: ReadonlyArray<string>
): Promise<Map<string, string>> {
  const keys = (await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as webcrypto.CryptoKeyPair
  const key = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(
    await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)
  ).toString("base64")}\n-----END PRIVATE KEY-----\n`
  const chains = new Map<string, string>()
  for (const name of names) {
    const certificate = await X509CertificateGenerator.createSelfSigned(
      {
        extensions: [
          new SubjectAlternativeNameExtension([{ type: "dns", value: name }]),
        ],
        keys,
        name: `CN=${name}`,
        notAfter: new Date(Date.now() + 30 * 24 * 60 * 60_000),
        notBefore: new Date(Date.now() - 60_000),
        serialNumber: "01",
        signingAlgorithm: { hash: "SHA-256", name: "ECDSA" },
      },
      webcrypto
    )
    chains.set(name, certificate.toString("pem"))
  }
  const path = webCertificateStorePath(harness.config)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    JSON.stringify({
      kiln: {
        Account: null,
        Certificates: [...chains].map(([main, chain]) => ({
          certificate: Buffer.from(chain).toString("base64"),
          domain: { main },
          key: Buffer.from(key).toString("base64"),
          Store: "default",
        })),
      },
    })
  )
  return chains
}

async function publicDatabases(harness: RelayHarness) {
  const databases = new PublicDatabases({
    certificates: harness.lifecycle.certificates,
    config: harness.config,
    databases: harness.databases,
    engine: new DockerEngine(harness.config.dockerSocket),
    hostPorts: harness.lifecycle.hostPorts,
    proxy: { runsTraefik: true },
    state: harness.state,
  })
  await databases.load()
  return databases
}

async function withDatabase() {
  const harness = await relayHarness()
  await harness.databases.create(
    relayCreateDatabaseSchema.parse({
      databaseName: "kiln_app",
      ...databaseBrick("postgres"),
      id,
      name: "Main database",
      password: "correct-horse-battery-staple-1",
      username: "kiln_user",
    })
  )
  return harness
}

describe("a public database", () => {
  it("opens once a name has its certificate, and its gate gets each name's as it comes, the database never", async () => {
    const harness = await withDatabase()
    fakeDocker.addContainer({
      image: "kiln/relay:test",
      name: harness.config.selfContainer ?? hostname(),
      running: true,
    })
    const databases = await publicDatabases(harness)
    // Each name the gate serves, and its certificate.
    const gateFile = () => {
      const file = fakeDocker.volumes
        .get(`${TEST_NAMESPACE}-kiln-db-${id}-certificates`)
        ?.files.get("certificates.json")
      return file === undefined
        ? undefined
        : (
            JSON.parse(file) as {
              names: Array<{ certificate: string; name: string }>
            }
          ).names
    }
    await databases.write(id, {
      hostnames: ["data.example.com", "db.example.com"],
      port: 25_432,
    })

    // No certificate yet: no gate.
    await databases.reconcile(id)
    expect(fakeDocker.container(gate)).toBeUndefined()

    // One name's: open there, while the other's comes.
    const first = await traefikHolds(harness, ["db.example.com"])
    await databases.reconcile(id)
    expect(fakeDocker.container(gate)?.state.running).toBe(true)
    expect(gateFile()?.map(({ name }) => name)).toEqual(["db.example.com"])
    expect(gateFile()?.[0]?.certificate).toContain(
      first.get("db.example.com")?.trim()
    )
    expect(gateFile()?.[0]?.certificate).toContain("PRIVATE KEY")
    expect(databases.status({ id })).toMatchObject({ state: "open" })

    // Both: each its own, the first name first, for a client that names
    // none.
    const both = await traefikHolds(harness, [
      "data.example.com",
      "db.example.com",
    ])
    await databases.reconcile(id)
    expect(gateFile()?.map(({ name }) => name)).toEqual([
      "data.example.com",
      "db.example.com",
    ])
    expect(gateFile()?.[0]?.certificate).toContain(
      both.get("data.example.com")?.trim()
    )
    expect(gateFile()?.[1]?.certificate).toContain(
      both.get("db.example.com")?.trim()
    )

    // Traefik's store caught partway through being written says nothing:
    // the gate stays as it is.
    await writeFile(webCertificateStorePath(harness.config), '{"kiln": {')
    await databases.reconcile(id)
    expect(fakeDocker.container(gate)?.state.running).toBe(true)
    expect(gateFile()).toHaveLength(2)

    // Postgres reaches its gate in the clear on its own network: it runs
    // as it did, with no certificate of its own.
    const database = await harness.databases.target(id)
    const container = fakeDocker.container(String(database.containerId))
    expect(container?.labels["kiln.database.tls"]).toBeUndefined()
    expect(container?.cmd.join(" ")).not.toContain("ssl")

    // Closed, its gate and its keys go.
    await databases.write(id, null)
    expect(fakeDocker.container(gate)).toBeUndefined()
    expect(gateFile()).toBeUndefined()
  })

  it("moves a database opened before its gate ended TLS itself off its names' certificate", async () => {
    const harness = await withDatabase()
    fakeDocker.addContainer({
      image: "kiln/relay:test",
      name: harness.config.selfContainer ?? hostname(),
      running: true,
    })
    const databases = await publicDatabases(harness)
    await databases.write(id, opened)
    await traefikHolds(harness, ["db.example.com"])
    // As the Relay before the update left it: Postgres running with the
    // name's certificate and key in a volume of its own.
    const before = await harness.databases.target(id)
    const container = fakeDocker.container(String(before.containerId))
    if (!container) throw new Error("no database container")
    container.labels["kiln.database.tls"] = "public"
    const tlsVolume = `${TEST_NAMESPACE}-kiln-db-${id}-tls`
    fakeDocker.addVolume({ name: tlsVolume })

    await databases.reconcile(id)

    const after = await harness.databases.target(id)
    expect(after.containerId).not.toBe(before.containerId)
    expect(
      fakeDocker.container(String(after.containerId))?.labels[
        "kiln.database.tls"
      ]
    ).toBeUndefined()
    expect(fakeDocker.volumes.has(tlsVolume)).toBe(false)
    expect(fakeDocker.container(gate)?.state.running).toBe(true)
  })

  it("stays public, and kept, when its gate can't be removed as it closes", async () => {
    const harness = await withDatabase()
    const databases = await publicDatabases(harness)
    await databases.write(id, opened)
    fakeDocker.addContainer({ name: gate, running: true })
    fakeDocker.failNext({ command: "rm", target: gate }, "device busy")

    await expect(databases.write(id, null)).rejects.toThrow()

    // Still saved across a restart, so the loop keeps it, and closing
    // again finishes.
    expect((await publicDatabases(harness)).ids()).toEqual([id])
    expect(databases.status({ id })).toMatchObject(opened)
    await databases.write(id, null)
    expect(fakeDocker.container(gate)).toBeUndefined()
    expect((await publicDatabases(harness)).ids()).toEqual([])
  })

  it("can't be given a port another public database waits for", async () => {
    const harness = await withDatabase()
    const other = "e".repeat(12)
    await harness.databases.create(
      relayCreateDatabaseSchema.parse({
        databaseName: "kiln_app",
        ...databaseBrick("postgres"),
        id: other,
        name: "Other database",
        password: "correct-horse-battery-staple-1",
        username: "kiln_user",
      })
    )
    const databases = await publicDatabases(harness)
    await databases.write(id, opened)

    await expect(
      databases.write(other, { hostnames: ["other.example.com"], port: 25_432 })
    ).rejects.toThrow(/port 25432/u)
    expect(databases.ids()).toEqual([id])
  })

  it("holds what it saved as a restart reads it back", async () => {
    const harness = await withDatabase()
    const databases = await publicDatabases(harness)
    await databases.write(id, opened)
    await databases.write(id, {
      hostnames: ["data.example.com", "db.example.com"],
      port: 25_433,
    })

    const restarted = await publicDatabases(harness)
    expect(databases.names()).toEqual(restarted.names())
    expect(databases.status({ id })).toMatchObject({ port: 25_433 })
    expect(restarted.status({ id })).toMatchObject({ port: 25_433 })
  })

  it("is forgotten once its database is gone, as after a delete the Relay stopped in", async () => {
    const harness = await withDatabase()
    const databases = await publicDatabases(harness)
    await databases.write(id, opened)
    fakeDocker.addContainer({
      labels: { "kiln.database.gate": id, "kiln.relay.owner": TEST_NAMESPACE },
      name: gate,
      running: true,
    })
    await harness.databases.delete({ databaseId: id, deleteData: true })

    await databases.reconcile(id)

    expect(databases.ids()).toEqual([])
    expect(fakeDocker.container(gate)).toBeUndefined()
    expect((await publicDatabases(harness)).ids()).toEqual([])
  })
})
