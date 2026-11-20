import { generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime, Schedule } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import {
  databaseFileRootId,
  newInstanceId,
  relayCreateDatabaseSchema,
  type RelayPeerTransferGrant,
} from "@workspace/contracts"

// Only the database case below reaches Docker.
vi.mock("../../command.js", () => import("../../test/docker.js"))

import type { DatabaseDriver } from "../../databases.js"
import { fingerprint, type RelayIdentity } from "../../effect/identity.js"
import { makeRelayStateLayer, RelayStateStore } from "../../effect/state.js"
import { FilesystemDriver } from "../../files.js"
import { OperationLanes } from "../../operation-lanes.js"
import {
  transferInstallLocks,
  transferPackLocks,
} from "../../operation-plans.js"
import { databaseBrick } from "../../test/database-bricks.js"
import { fakeDocker } from "../../test/docker.js"
import { testRelayConfig } from "../../test/fixtures.js"
import { relayHarness, TEST_NAMESPACE } from "../../test/relay.js"
import { TransferGate } from "../gate.js"
import { fetchArtifactRange } from "./client.js"
import { TransferPulls } from "./pulls.js"
import { peerTransferRoute } from "./route.js"
import {
  databaseTransferRoot,
  fileTransferRoot,
  type TransferRootResolver,
} from "./roots.js"
import { TransferSources } from "./sources.js"

const describeLinux = process.platform === "linux" ? describe : describe.skip
const issuer = "hearth-peer-test"
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()))
})

describeLinux("transfers between Relays", () => {
  it("copies a folder to the Relay its grant names", async () => {
    const source = await startSource()
    await writeFile(join(source.root, "level.dat"), "the world")
    const destination = await startDestination()
    const artifact = await source.prepare("transfer-copy-1")

    const pull = await destination.pull(source, artifact, { path: "copy" })

    expect(pull.error).toBeNull()
    expect(pull.state).toBe("completed")
    expect(
      await readFile(join(destination.root, "copy", "level.dat"), "utf8")
    ).toBe("the world")
  })

  it("refuses a grant presented by a Relay it doesn't name", async () => {
    const source = await startSource()
    await writeFile(join(source.root, "secret.txt"), "only for the peer")
    const named = await startDestination()
    const other = relayIdentity()
    const artifact = await source.prepare("transfer-refuse-1")

    const refused = await Effect.runPromise(
      Effect.scoped(
        fetchArtifactRange({
          audience: source.identity.id,
          endpoint: { caCertificatePem: null, url: source.url },
          grant: source.grant(artifact, named.identity.fingerprint),
          identity: other,
          offset: 0,
          transferId: artifact.transferId,
        })
      ).pipe(Effect.flip)
    )

    expect(refused.status).toBe(401)
  })

  it("discards an artifact that doesn't match its grant and installs nothing", async () => {
    const source = await startSource()
    await writeFile(join(source.root, "world.bin"), randomBytes(256 * 1024))
    const destination = await startDestination()
    const artifact = await source.prepare("transfer-tamper-1")
    // Changed on the source after Hearth signed for it, keeping its size.
    const path = join(
      source.dataDirectory,
      "transfers",
      "outgoing",
      "transfer-tamper-1.tar.gz"
    )
    const packed = await readFile(path)
    packed[packed.length - 10] ^= 0xff
    await writeFile(path, packed)

    const pull = await destination.pull(source, artifact, { path: "copy" })

    expect(pull.state).toBe("failed")
    await expect(stat(join(destination.root, "copy"))).rejects.toThrow()
  })
})

describe("a database copied between Relays", () => {
  const oldId = "a".repeat(12)
  const newId = "b".repeat(12)
  const dump =
    "CREATE TABLE players (name text);\nINSERT INTO players VALUES ('alex');\n"

  // One Docker holds both databases; the dump still crosses from one
  // Relay's transfers to another's, under a grant, as between two.
  async function databases(source: Pick<TransferSide, "issuerActions"> = {}) {
    const harness = await relayHarness()
    const database = async (id: string, name: string) => {
      await harness.databases.create(
        relayCreateDatabaseSchema.parse({
          databaseName: "kiln_app",
          ...databaseBrick("postgres"),
          id,
          name,
          password: "correct-horse-battery-staple-1",
          username: "kiln_user",
        })
      )
      const container = fakeDocker.container(
        `${TEST_NAMESPACE}-kiln-db-${id}-database`
      )
      if (!container) throw new Error("The database has no container")
      return container
    }
    const old = await database(oldId, "Old database")
    const copy = await database(newId, "New database")
    old.sqlDump = dump
    const resolveRoot = databaseRoots(harness.databases)
    return {
      copy,
      destination: await startDestination({
        resolveRoot,
        rootId: databaseFileRootId(newId),
      }),
      old,
      source: await startSource({
        ...source,
        resolveRoot,
        rootId: databaseFileRootId(oldId),
      }),
    }
  }

  it("runs the old database's dump into the new one, and leaves the old one as it was", async () => {
    const { copy, destination, old, source } = await databases()

    const artifact = await source.prepare("transfer-database-1")
    const pull = await destination.pull(source, artifact, { path: "" })

    expect(pull.error).toBeNull()
    expect(pull.state).toBe("completed")
    expect(copy.executedSql).toEqual([dump])
    expect(old.executedSql).toEqual([])
  })

  it("copies a database whole or not at all", async () => {
    const { copy, destination, source } = await databases()

    // Naming paths, an empty one first among them, packs nothing.
    await expect(
      source.prepare("transfer-database-2", ["", "players"])
    ).rejects.toThrow("copied whole")

    // And a dump runs into the database itself, never a path under it.
    const artifact = await source.prepare("transfer-database-3")
    const pull = await destination.pull(source, artifact, { path: "players" })
    expect(pull.state).toBe("failed")
    expect(pull.error).toContain("copied whole")
    expect(copy.executedSql).toEqual([])
  })

  it("serves no dump under a grant from a client that may only make backups", async () => {
    // Making a backup isn't taking one away: a client that may only make
    // them can pack a dump, and its grant fetches none.
    const made = await databases({ issuerActions: ["backup.create"] })
    const refused = await made.destination.pull(
      made.source,
      await made.source.prepare("transfer-database-4"),
      { path: "" }
    )
    expect(refused.state).toBe("failed")
    expect(refused.error).toContain("401")
    expect(made.copy.executedSql).toEqual([])
  })

  it("serves a dump under a grant from a client that may download backups", async () => {
    const { copy, destination, source } = await databases({
      issuerActions: ["backup.download"],
    })

    const pull = await destination.pull(
      source,
      await source.prepare("transfer-database-5"),
      { path: "" }
    )

    expect(pull.error).toBeNull()
    expect(copy.executedSql).toEqual([dump])
  })
})

interface ReadyArtifact {
  readonly sha256: string
  readonly size: number
  readonly transferId: string
}

type Source = Awaited<ReturnType<typeof startSource>>

// A Relay's own transfers over one root: a game server's folder, unless
// another is named.
interface TransferSide {
  /** What the client that signs the source's grants may do; all, unless named. */
  readonly issuerActions?: ReadonlyArray<string>
  readonly resolveRoot?: TransferRootResolver
  readonly rootId?: string
}

async function startSource(side: TransferSide = {}) {
  const rootId = side.rootId ?? "instance-1"
  const dataDirectory = await mkdtemp(join(tmpdir(), "kiln-peer-source-"))
  const root = join(dataDirectory, "instances", "instance-1")
  await mkdir(root, { recursive: true })
  const runtime = ManagedRuntime.make(
    makeRelayStateLayer(join(dataDirectory, "relay.sqlite"))
  )
  const state = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* RelayStateStore
    })
  )
  const issuerKeys = generateKeyPairSync("ed25519")
  const now = Date.now()
  await runtime.runPromise(
    Effect.gen(function* () {
      const actions = [...(side.issuerActions ?? ["*"])]
      const role = side.issuerActions ? "custom" : "full_access"
      yield* state.createInvitation({
        actions,
        createdAt: now,
        expiresAt: now + 60_000,
        id: "invitation-1",
        role,
        tokenHash: "hash-1",
      })
      yield* state.pairClient({
        actions,
        id: issuer,
        invitationId: "invitation-1",
        name: "Hearth",
        origins: [],
        pairedAt: now,
        publicKey: issuerKeys.publicKey
          .export({ format: "pem", type: "spki" })
          .toString(),
        role,
        sourceCidrs: [],
      })
    })
  )
  const identity = relayIdentity()
  const lanes = new OperationLanes()
  const sources = new TransferSources({
    directory: join(dataDirectory, "transfers", "outgoing"),
    lanes,
    resolveRoot: side.resolveRoot ?? fileRoots(dataDirectory),
  })
  const route = peerTransferRoute({
    gate: new TransferGate(),
    identity,
    sources,
    state,
  })
  const server: Server = createServer((request, response) => {
    void route.handleRequest(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No address")
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await runtime.dispose()
    await rm(dataDirectory, { force: true, recursive: true })
  })
  return {
    dataDirectory,
    identity,
    root,
    url: `http://127.0.0.1:${address.port}`,
    grant: (artifact: ReadyArtifact, peer: string) => {
      const grant: RelayPeerTransferGrant = {
        audience: identity.id,
        expiresAt: Date.now() + 60_000,
        issuedAt: Date.now(),
        issuer,
        peer,
        sha256: artifact.sha256,
        size: artifact.size,
        transferId: artifact.transferId,
        version: 1,
      }
      const encoded = Buffer.from(JSON.stringify(grant)).toString("base64url")
      return `${encoded}.${sign(null, Buffer.from(encoded), issuerKeys.privateKey).toString("base64url")}`
    },
    prepare: async (
      transferId: string,
      paths: ReadonlyArray<string> = []
    ): Promise<ReadyArtifact> => {
      await Effect.runPromise(sources.prepare({ paths, rootId, transferId }))
      const record = await vi.waitFor(
        () => {
          const packed = sources.get({ rootId, transferId })
          if (!packed || packed.state === "packing") {
            throw new Error("The transfer is still packing")
          }
          return packed
        },
        { timeout: 10_000 }
      )
      if (record.state !== "ready" || !record.sha256 || record.size === null) {
        throw new Error(`Transfer is ${record.state}: ${record.error}`)
      }
      return { sha256: record.sha256, size: record.size, transferId }
    },
  }
}

async function startDestination(side: TransferSide = {}) {
  const rootId = side.rootId ?? "instance-1"
  const dataDirectory = await mkdtemp(join(tmpdir(), "kiln-peer-destination-"))
  const root = join(dataDirectory, "instances", "instance-1")
  await mkdir(root, { recursive: true })
  cleanups.push(() => rm(dataDirectory, { force: true, recursive: true }))
  const identity = relayIdentity()
  const pulls = new TransferPulls({
    directory: join(dataDirectory, "transfers", "incoming"),
    identity,
    lanes: new OperationLanes(),
    resolveRoot: side.resolveRoot ?? fileRoots(dataDirectory),
    retrySchedule: Schedule.recurs(3),
  })
  return {
    identity,
    root,
    pull: async (
      source: Source,
      artifact: ReadyArtifact,
      target: { path: string }
    ) => {
      await Effect.runPromise(
        pulls.start({
          endpoints: [{ caCertificatePem: null, url: source.url }],
          grant: source.grant(artifact, identity.fingerprint),
          target: { path: target.path, rootId },
          transferId: artifact.transferId,
        })
      )
      return vi.waitFor(
        () => {
          const pull = pulls.get({ rootId, transferId: artifact.transferId })
          if (pull?.state !== "completed" && pull?.state !== "failed") {
            throw new Error(`Pull is ${pull?.state}`)
          }
          return pull
        },
        { timeout: 10_000 }
      )
    },
  }
}

// Game server roots under a data directory, as the Relay resolves them.
function fileRoots(dataDirectory: string): TransferRootResolver {
  const filesystem = new FilesystemDriver(testRelayConfig(dataDirectory))
  return (rootId) =>
    Promise.resolve(
      fileTransferRoot(
        filesystem,
        { directory: rootId, id: rootId },
        {
          installLocks: transferInstallLocks(rootId),
          packLocks: transferPackLocks(rootId),
        }
      )
    )
}

// Database roots, as the Relay resolves them.
function databaseRoots(databases: DatabaseDriver): TransferRootResolver {
  return (rootId) =>
    databaseTransferRoot(databases, rootId.slice("database:".length), {
      installLocks: transferInstallLocks(rootId),
      packLocks: transferPackLocks(rootId),
    })
}

function relayIdentity(): RelayIdentity {
  const keys = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  })
  return {
    fingerprint: fingerprint(keys.publicKey),
    id: newInstanceId(),
    name: "Relay",
    privateKeyPem: keys.privateKey,
    publicKeyPem: keys.publicKey,
  }
}
