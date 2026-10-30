import { generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime, Schedule } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import type { RelayPeerTransferGrant } from "@workspace/contracts"

import { fingerprint, type RelayIdentity } from "../../effect/identity.js"
import { makeRelayStateLayer, RelayStateStore } from "../../effect/state.js"
import { FilesystemDriver } from "../../files.js"
import { OperationLanes } from "../../operation-lanes.js"
import {
  transferInstallLocks,
  transferPackLocks,
} from "../../operation-plans.js"
import { testRelayConfig } from "../../test/fixtures.js"
import { TransferGate } from "../gate.js"
import { fetchArtifactRange } from "./client.js"
import { TransferPulls } from "./pulls.js"
import { peerTransferRoute } from "./route.js"
import type { TransferRootResolver } from "./roots.js"
import { TransferSources } from "./sources.js"

const describeLinux = process.platform === "linux" ? describe : describe.skip
const issuer = "hearth-peer-test"
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()))
})

describeLinux("transfers between Relays", () => {
  it("refuses a grant presented by a Relay it doesn't name", async () => {
    const source = await startSource()
    await writeFile(join(source.root, "secret.txt"), "only for the peer")
    const named = await startDestination()
    const other = relayIdentity()
    const artifact = await source.prepare("transfer-refuse-1")

    const refused = await Effect.runPromise(
      Effect.scoped(
        fetchArtifactRange({
          audience: source.identity.fingerprint,
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

interface ReadyArtifact {
  readonly sha256: string
  readonly size: number
  readonly transferId: string
}

type Source = Awaited<ReturnType<typeof startSource>>

async function startSource() {
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
      yield* state.createInvitation({
        actions: ["*"],
        createdAt: now,
        expiresAt: now + 60_000,
        id: "invitation-1",
        role: "full_access",
        tokenHash: "hash-1",
      })
      yield* state.pairClient({
        actions: ["*"],
        id: issuer,
        invitationId: "invitation-1",
        name: "Hearth",
        origins: [],
        pairedAt: now,
        publicKey: issuerKeys.publicKey
          .export({ format: "pem", type: "spki" })
          .toString(),
        role: "full_access",
        sourceCidrs: [],
      })
    })
  )
  const identity = relayIdentity()
  const lanes = new OperationLanes()
  const sources = new TransferSources({
    directory: join(dataDirectory, "transfers", "outgoing"),
    lanes,
    resolveRoot: fileRoots(dataDirectory),
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
        audience: identity.fingerprint,
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
      await Effect.runPromise(
        sources.prepare({ paths, rootId: "instance-1", transferId })
      )
      return vi.waitFor(
        () => {
          const record = sources.get({ rootId: "instance-1", transferId })
          if (
            record?.state !== "ready" ||
            !record.sha256 ||
            record.size === null
          ) {
            throw new Error(`Transfer is ${record?.state}: ${record?.error}`)
          }
          return { sha256: record.sha256, size: record.size, transferId }
        },
        { timeout: 10_000 }
      )
    },
  }
}

async function startDestination() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "kiln-peer-destination-"))
  const root = join(dataDirectory, "instances", "instance-1")
  await mkdir(root, { recursive: true })
  cleanups.push(() => rm(dataDirectory, { force: true, recursive: true }))
  const identity = relayIdentity()
  const pulls = new TransferPulls({
    directory: join(dataDirectory, "transfers", "incoming"),
    identity,
    lanes: new OperationLanes(),
    resolveRoot: fileRoots(dataDirectory),
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
          target: { path: target.path, rootId: "instance-1" },
          transferId: artifact.transferId,
        })
      )
      return vi.waitFor(
        () => {
          const pull = pulls.get({
            rootId: "instance-1",
            transferId: artifact.transferId,
          })
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
    Promise.resolve({
      filesystem,
      installLocks: transferInstallLocks(rootId),
      packLocks: transferPackLocks(rootId),
      root: { directory: rootId, id: rootId },
    })
}

function relayIdentity(): RelayIdentity {
  const keys = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  })
  return {
    fingerprint: fingerprint(keys.publicKey),
    name: "Relay",
    privateKeyPem: keys.privateKey,
    publicKeyPem: keys.publicKey,
  }
}
