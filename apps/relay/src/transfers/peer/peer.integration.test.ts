import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { once } from "node:events"
import { createServer, request as httpRequest, type Server } from "node:http"
import { createServer as createTcpServer, type AddressInfo } from "node:net"
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
  it("copies a game server's files to another Relay", async () => {
    const source = await startSource()
    await writeFile(join(source.root, "server.properties"), "motd=hello\n")
    await mkdir(join(source.root, "world", "region"), { recursive: true })
    const region = randomBytes(512 * 1024)
    await writeFile(join(source.root, "world", "region", "r.0.0.mca"), region)
    await writeFile(join(source.root, "start.sh"), "#!/bin/sh\n", {
      mode: 0o755,
    })
    const destination = await startDestination()

    const artifact = await source.prepare("transfer-copy-1")
    await destination.pull(source, artifact, { path: "copy" })

    const installed = join(destination.root, "copy")
    expect(await readFile(join(installed, "server.properties"), "utf8")).toBe(
      "motd=hello\n"
    )
    expect(
      digest(await readFile(join(installed, "world", "region", "r.0.0.mca")))
    ).toBe(digest(region))
    expect((await stat(join(installed, "start.sh"))).mode & 0o777).toBe(0o755)
  })

  it("copies a selected folder as that folder", async () => {
    const source = await startSource()
    await mkdir(join(source.root, "plugins", "config"), { recursive: true })
    await writeFile(join(source.root, "plugins", "config", "a.yml"), "a: 1\n")
    await writeFile(join(source.root, "server.properties"), "motd=hello\n")
    const destination = await startDestination()

    const artifact = await source.prepare("transfer-select-1", ["plugins"])
    await destination.pull(source, artifact, { path: "copy" })

    expect(
      await readFile(
        join(destination.root, "copy", "plugins", "config", "a.yml"),
        "utf8"
      )
    ).toBe("a: 1\n")
    await expect(
      stat(join(destination.root, "copy", "server.properties"))
    ).rejects.toThrow()
  })

  it("resumes a pull whose connection drops partway", async () => {
    const source = await startSource({ dropFirstResponseAfter: 64 * 1024 })
    const contents = randomBytes(2 * 1024 * 1024)
    await writeFile(join(source.root, "world.bin"), contents)
    const destination = await startDestination()

    const artifact = await source.prepare("transfer-resume-1")
    const pull = await destination.pull(source, artifact, { path: "" })

    expect(pull.state).toBe("completed")
    expect(digest(await readFile(join(destination.root, "world.bin")))).toBe(
      digest(contents)
    )
  })

  it("falls back to a pass-through when it can't reach the source", async () => {
    const source = await startSource()
    const contents = randomBytes(256 * 1024)
    await writeFile(join(source.root, "world.bin"), contents)
    const destination = await startDestination()
    // As Hearth passes pulls through to a Relay that dialed it: beneath a
    // path of its own, forwarding the request as it is.
    const passThrough = createServer((request, response) => {
      const route = (request.url ?? "").match(
        /^\/api\/relays\/source\/peer(\/v1\/peer\/transfers\/[^/?]+(?:\?.*)?)$/u
      )?.[1]
      if (!route) {
        response.writeHead(404).end()
        return
      }
      const forwarded = httpRequest(
        `${source.url}${route}`,
        { headers: request.headers, method: request.method },
        (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers)
          answer.pipe(response)
        }
      )
      request.pipe(forwarded)
    })
    passThrough.listen(0, "127.0.0.1")
    await once(passThrough, "listening")
    cleanups.push(
      () => new Promise<void>((resolve) => passThrough.close(() => resolve()))
    )
    const { port } = passThrough.address() as AddressInfo

    const artifact = await source.prepare("transfer-through-hearth-1")
    const pull = await destination.pull(source, artifact, {
      endpoints: [
        // Nothing answers here, as for a Relay behind a home router.
        {
          caCertificatePem: null,
          url: `http://127.0.0.1:${await closedPort()}`,
        },
        // Something else answers here, as a router's own pages would.
        { caCertificatePem: null, url: await somethingElse(404) },
        { caCertificatePem: null, url: await somethingElse(200) },
        {
          caCertificatePem: null,
          url: `http://127.0.0.1:${port}/api/relays/source/peer`,
        },
      ],
      path: "",
    })

    expect(pull.state).toBe("completed")
    expect(digest(await readFile(join(destination.root, "world.bin")))).toBe(
      digest(contents)
    )
  })

  it("deletes what a failed pull fetched once it's cancelled", async () => {
    const source = await startSource({ dropEveryResponseAfter: 64 * 1024 })
    await writeFile(
      join(source.root, "world.bin"),
      randomBytes(2 * 1024 * 1024)
    )
    const destination = await startDestination()
    const artifact = await source.prepare("transfer-give-up-1")

    const pull = await destination.pull(source, artifact, { path: "" })
    expect(pull.state).toBe("failed")
    expect((await stat(destination.partPath(artifact.transferId))).size).toBe(
      pull.receivedBytes
    )

    const cancelled = await destination.cancel(artifact.transferId)

    expect(cancelled?.state).toBe("cancelled")
    await expect(
      stat(destination.partPath(artifact.transferId))
    ).rejects.toThrow()
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

async function startSource(
  options: {
    dropFirstResponseAfter?: number
    dropEveryResponseAfter?: number
  } = {}
) {
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
  let dropNext = options.dropFirstResponseAfter
  const server: Server = createServer((request, response) => {
    // Cuts the first artifact response off partway, as a network might, or
    // every one, as a network that keeps failing does.
    if (
      (dropNext !== undefined || options.dropEveryResponseAfter) &&
      request.method === "GET"
    ) {
      const limit = dropNext ?? options.dropEveryResponseAfter ?? 0
      dropNext = undefined
      let sent = 0
      const write = response.write.bind(response)
      response.write = ((chunk: Buffer, ...rest: Array<never>) => {
        sent += chunk.byteLength
        if (sent > limit) {
          response.destroy()
          return false
        }
        return write(chunk, ...rest)
      }) as typeof response.write
    }
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
    cancel: (transferId: string) =>
      Effect.runPromise(pulls.cancel({ rootId: "instance-1", transferId })),
    partPath: (transferId: string) =>
      join(dataDirectory, "transfers", "incoming", `${transferId}.part`),
    pull: async (
      source: Source,
      artifact: ReadyArtifact,
      target: {
        endpoints?: ReadonlyArray<{ caCertificatePem: null; url: string }>
        path: string
      }
    ) => {
      await Effect.runPromise(
        pulls.start({
          endpoints: target.endpoints ?? [
            { caCertificatePem: null, url: source.url },
          ],
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

// A local port nothing listens on.
// An address where something other than the source answers.
async function somethingElse(status: number): Promise<string> {
  const server = createServer((_request, response) => {
    response
      .writeHead(status, { "content-type": "text/html" })
      .end("<h1>Sign in to your router</h1>")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve()))
  )
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function closedPort(): Promise<number> {
  const server = createTcpServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
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

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}
