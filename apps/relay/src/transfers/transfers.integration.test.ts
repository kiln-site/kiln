import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto"
import type { KeyObject } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import type { IncomingMessage, Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import {
  relayBrowserRequestProofTranscript,
  type RelayBrowserCapabilityV2,
} from "@workspace/contracts"

import { attachBrowserSocket } from "../browser-socket.js"
import type { BrowserSocketServer } from "../browser-socket.js"
import type { ConsoleSources } from "../console-sources.js"
import type { DockerDriver } from "../docker.js"
import type { RelayIdentity } from "../effect/identity.js"
import { makeRelayStateLayer, RelayStateStore } from "../effect/state.js"
import { FilesystemDriver } from "../files.js"
import { OperationLanes } from "../operation-lanes.js"
import { testInstance, testRelayConfig } from "../test/fixtures.js"
import { backupLinks } from "./backup-links.js"
import { TransferGate } from "./gate.js"

const origin = "https://hearth.test"
const relayId = "relay-transfer-test"
const issuer = "hearth-transfer-test"
const instanceId = "instance-1"
const backupId = "6f1e2a4c-7b39-4d2e-9a51-3c8b0f7d2e10"
const otherBackupId = "0b7d9c1e-2f4a-4e6b-8c3d-5a1f9e2b7c40"
const describeLinux = process.platform === "linux" ? describe : describe.skip
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("browser file transfers", () => {
  it("refuses a capability issued for a different file", async () => {
    const relay = await startRelay()
    const request = await relay.signedRequest({
      capabilityPath: "server.properties",
      method: "HEAD",
      path: "world/level.dat",
    })

    const response = await send(relay.port, request)

    expect(response.status).toBe(401)
  })

  it("refuses an upload under a download capability", async () => {
    const relay = await startRelay()
    const request = await relay.signedRequest({
      action: "instance.files.download",
      method: "PUT",
      path: "plugins/evil.jar",
    })

    const response = await send(relay.port, { ...request, body: "payload" })

    expect(response.status).toBe(401)
  })

  it("refuses a proof sent a second time", async () => {
    // The server isn't found, so the first request ends after it
    // authenticates; the repeat never authenticates.
    const relay = await startRelay({ instanceExists: false })
    const request = await relay.signedRequest({ method: "HEAD", path: "a" })

    expect((await send(relay.port, request)).status).toBe(404)
    expect((await send(relay.port, request)).status).toBe(401)
  })

  it("refuses a preflight from an origin no Hearth paired", async () => {
    const relay = await startRelay()

    const response = await send(relay.port, {
      headers: { Origin: "https://elsewhere.test" },
      method: "OPTIONS",
      path: `/v1/browser/files/${instanceId}`,
    })

    expect(response.status).toBe(403)
  })
})

describeLinux("browser file transfers on Linux", () => {
  it("stores an upload whole and serves a range of it back", async () => {
    const relay = await startRelay()
    const contents = randomBytes(256 * 1024)
    const upload = await relay.signedRequest({
      method: "PUT",
      path: "world/region.mca",
    })

    const stored = await send(relay.port, { ...upload, body: contents })

    expect(stored.status).toBe(200)
    expect(JSON.parse(stored.body.toString()).sha256).toBe(
      createHash("sha256").update(contents).digest("hex")
    )
    expect(
      createHash("sha256")
        .update(await readFile(join(relay.instanceRoot, "world", "region.mca")))
        .digest("hex")
    ).toBe(createHash("sha256").update(contents).digest("hex"))

    const download = await relay.signedRequest({
      action: "instance.files.download",
      method: "GET",
      path: "world/region.mca",
    })
    const ranged = await send(relay.port, {
      ...download,
      headers: { ...download.headers, Range: "bytes=1000-1999" },
    })

    expect(ranged.status).toBe(206)
    expect(ranged.body).toEqual(contents.subarray(1000, 2000))
  })

  it("frees a transfer's slot when the browser leaves mid-download", async () => {
    const relay = await startRelay()
    await writeFile(
      join(relay.instanceRoot, "world.bin"),
      randomBytes(32 * 1024 * 1024)
    )
    const download = await relay.signedRequest({
      action: "instance.files.download",
      method: "GET",
      path: "world.bin",
    })

    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        {
          headers: download.headers,
          host: "127.0.0.1",
          method: "GET",
          path: download.path,
          port: relay.port,
        },
        (response) => {
          response.once("data", () => {
            request.destroy()
            resolve()
          })
        }
      )
      request.once("error", (cause) => {
        if (!request.destroyed) reject(cause)
      })
      request.end()
    })

    await vi.waitFor(() => expect(relay.browser.activeTransfers()).toBe(0))
  })
})

describe("backup download links", () => {
  it("serves a backup to its own link and resumes it from a range", async () => {
    const relay = await startRelay()
    const archive = randomBytes(64 * 1024)
    await mkdir(join(relay.dataDirectory, "backups"), { recursive: true })
    await writeFile(
      join(relay.dataDirectory, "backups", `${backupId}.zip`),
      archive
    )

    const resumed = await send(relay.port, {
      headers: { Range: "bytes=4096-" },
      method: "GET",
      path: `/v1/browser/backups/${backupId}?token=${relay.backupToken(backupId)}`,
    })
    const other = await send(relay.port, {
      method: "GET",
      path: `/v1/browser/backups/${otherBackupId}?token=${relay.backupToken(backupId)}`,
    })

    expect(resumed.status).toBe(206)
    expect(resumed.body).toEqual(archive.subarray(4096))
    expect(other.status).toBe(401)
  })
})

interface SignedRequest {
  readonly headers: Record<string, string>
  readonly method: string
  readonly path: string
}

async function startRelay(options: { instanceExists?: boolean } = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "kiln-transfers-"))
  const instanceRoot = join(dataDirectory, "instances", instanceId)
  await mkdir(instanceRoot, { recursive: true })
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
        origins: [origin],
        pairedAt: now,
        publicKey: issuerKeys.publicKey
          .export({ format: "pem", type: "spki" })
          .toString(),
        role: "full_access",
        sourceCidrs: [],
      })
    })
  )
  const config = testRelayConfig(dataDirectory)
  const identity = { fingerprint: relayId } as RelayIdentity
  const gate = new TransferGate()
  const backups = backupLinks({ config, gate, identity, state })
  let browser: BrowserSocketServer | null = null
  const server: Server = createServer((request, response) => {
    void (async () => {
      if (await backups.handleRequest(request, response)) return
      if (await browser?.handleRequest(request, response)) return
      response.writeHead(404).end()
    })()
  })
  browser = attachBrowserSocket({
    config: {
      browserLimits: {
        ...config.browserLimits,
        fileReplayEntries: 100,
        pendingFileAuthentications: 16,
      },
      proxyMode: "none",
    },
    consoleSources: {} as ConsoleSources,
    docker: {
      findInstance: (id: string) =>
        Promise.resolve(
          options.instanceExists !== false && id === instanceId
            ? testInstance({ id, directory: instanceId })
            : null
        ),
    } as unknown as DockerDriver,
    filesystem: new FilesystemDriver(config),
    gate,
    identity,
    lanes: new OperationLanes(),
    onConsoleStop: () => undefined,
    runEffect: (effect) => Effect.runPromise(effect),
    server,
    state,
    subscribeSnapshots: () => () => undefined,
  })
  const attached = browser
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(async () => {
    // Transfers still recording their audit hold their slot until they do.
    await vi.waitFor(() => expect(gate.active()).toBe(0))
    server.closeAllConnections()
    await attached.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await runtime.dispose()
    await rm(dataDirectory, { force: true, recursive: true })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No address")
  const authority = await runtime.runPromise(
    state.browserAuthority({
      instanceId,
      issuer,
      loginSessionId: "login-1",
      subject: "user-1",
    })
  )

  return {
    browser: attached,
    dataDirectory,
    instanceRoot,
    port: address.port,
    backupToken: (backupId: string) =>
      signToken(issuerKeys.privateKey, {
        action: "backup.download",
        audience: relayId,
        backupId,
        capabilityId: randomUUID(),
        expiresAt: Date.now() + 60_000,
        filename: "backup.zip",
        issuedAt: Date.now(),
        issuer,
        subject: "user-1",
        version: 1,
      }),
    signedRequest: async (input: {
      action?: string
      capabilityPath?: string
      method: "GET" | "HEAD" | "PUT"
      path: string
    }): Promise<SignedRequest> => {
      const browserKeys = generateKeyPairSync("ec", { namedCurve: "P-256" })
      const jwk = browserKeys.publicKey.export({ format: "jwk" })
      const publicKeyJwk = {
        crv: "P-256" as const,
        kty: "EC" as const,
        x: String(jwk.x),
        y: String(jwk.y),
      }
      const issuedAt = Date.now()
      const capability: RelayBrowserCapabilityV2 = {
        actions: [
          input.action ??
            (input.method === "PUT"
              ? "instance.files.upload"
              : "instance.files.download"),
        ],
        audience: relayId,
        authorizationRevision: authority.minimumRevision,
        capabilityId: `capability-${randomBytes(6).toString("hex")}`,
        expiresAt: issuedAt + 30_000,
        instanceId,
        issuedAt,
        issuer,
        issuerGeneration: authority.issuerGeneration,
        keyThumbprint: createHash("sha256")
          .update(JSON.stringify(publicKeyJwk))
          .digest("base64url"),
        loginSessionId: "login-1",
        operation: "file",
        origin,
        path: input.capabilityPath ?? input.path,
        subject: "user-1",
        version: 2,
      }
      const nonce = randomBytes(32).toString("base64url")
      const requestedAt = Date.now()
      const proof = sign(
        "sha256",
        Buffer.from(
          relayBrowserRequestProofTranscript({
            capabilityId: capability.capabilityId,
            expiresAt: capability.expiresAt,
            instanceId,
            method: input.method,
            nonce,
            path: input.path,
            relayId,
            requestedAt,
          })
        ),
        { dsaEncoding: "ieee-p1363", key: browserKeys.privateKey }
      ).toString("base64url")
      return {
        headers: {
          Authorization: `Kiln ${signToken(issuerKeys.privateKey, capability)}`,
          Origin: origin,
          "X-Kiln-Nonce": nonce,
          "X-Kiln-Proof": proof,
          "X-Kiln-Public-Key": Buffer.from(
            JSON.stringify(publicKeyJwk)
          ).toString("base64url"),
          "X-Kiln-Requested-At": String(requestedAt),
        },
        method: input.method,
        path: `/v1/browser/files/${instanceId}?path=${encodeURIComponent(input.path)}`,
      }
    },
  }
}

function signToken(privateKey: KeyObject, payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString("base64url")}`
}

function send(
  port: number,
  input:
    | (SignedRequest & { body?: Buffer | string })
    | {
        body?: Buffer | string
        headers?: Record<string, string>
        method: string
        path: string
      }
): Promise<{ body: Buffer; status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: input.headers,
        host: "127.0.0.1",
        method: input.method,
        path: input.path,
        port,
      },
      (response: IncomingMessage) => {
        const chunks: Array<Buffer> = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.once("end", () =>
          resolve({
            body: Buffer.concat(chunks),
            status: response.statusCode ?? 0,
          })
        )
      }
    )
    request.once("error", reject)
    request.end(input.body)
  })
}
