import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto"
import type { KeyObject } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import type { IncomingMessage, Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("../test/held-commit.js")).withHeldCommits(importOriginal)
)

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
import { controlRequestLocks } from "../operation-plans.js"
import { testInstance, testRelayConfig } from "../test/fixtures.js"
import { holdNextCommit } from "../test/held-commit.js"
import { backupLinks } from "./backup-links.js"
import { TransferGate } from "./gate.js"

const origin = "https://hearth.test"
const relayId = "0123456789ab"
const issuer = "hearth-transfer-test"
const instanceId = "instance-1"
const backupId = "6f1e2a4c-7b39-4d2e-9a51-3c8b0f7d2e10"
const otherBackupId = "0b7d9c1e-2f4a-4e6b-8c3d-5a1f9e2b7c40"
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()))
})

// Reading or writing a file directly takes a Linux Relay host, which checks
// through /proc that what it opened is inside the root. On any other host the
// Relay refuses, so only what is refused before the file is opened runs there.
const itOnLinux = it.runIf(process.platform === "linux")

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

  itOnLinux(
    "never lets a save that checks the file is unchanged replace an upload",
    async () => {
      const relay = await startRelay()
      const path = join(relay.instanceRoot, "server.properties")
      await writeFile(path, "motd=old")
      // Someone saves the file they opened, as Hearth's editor does.
      const opened = Math.floor((await stat(path)).mtimeMs)
      const commit = holdNextCommit()
      const instance = testInstance({ id: instanceId, directory: instanceId })
      const saved = Effect.runPromise(
        relay.lanes.run(
          {
            label: "instance.files.put",
            locks:
              controlRequestLocks(
                "instance.files.put",
                { instanceId },
                (id) => id,
                () => []
              ) ?? [],
          },
          relay.filesystem
            .upload(
              instance,
              "server.properties",
              (async function* () {
                yield Buffer.from("motd=saved")
              })(),
              () => true,
              opened
            )
            .pipe(
              // Reporting a conflict is a right answer too.
              Effect.catchIf(
                (error) => error.code === "file_changed",
                () => Effect.void
              )
            )
        )
      )
      await commit.reached

      // A browser uploads the file as the save commits. Once the upload has
      // landed or waits its turn, the save goes on.
      let uploaded = false
      const upload = relay
        .signedRequest({ method: "PUT", path: "server.properties" })
        .then((request) => send(relay.port, { ...request, body: "motd=up" }))
        .then((response) => {
          uploaded = true
          return response
        })
      await vi.waitFor(() =>
        expect(uploaded || relay.lanes.pending.waiting > 0).toBe(true)
      )
      commit.release()
      const [, response] = await Promise.all([saved, upload])

      expect(response.status).toBe(200)
      // The save either saw the upload and reported a conflict, or landed
      // before it. It never replaces an upload it didn't see.
      expect(await readFile(path, "utf8")).toBe("motd=up")
    }
  )
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

describe("file preview links", () => {
  const previewPath = (token: string, path = "clips/intro.mp4") =>
    `/v1/browser/previews/${instanceId}?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`

  async function relayWithClip() {
    const relay = await startRelay()
    await mkdir(join(relay.instanceRoot, "clips"), { recursive: true })
    const clip = randomBytes(4096)
    await writeFile(join(relay.instanceRoot, "clips/intro.mp4"), clip)
    await writeFile(join(relay.instanceRoot, "clips/page.html"), "<script>")
    return { clip, relay }
  }

  itOnLinux(
    "plays a file inline, a range at a time, with no request proof",
    async () => {
      const { clip, relay } = await relayWithClip()

      const response = await send(relay.port, {
        headers: { Range: "bytes=1024-2047" },
        method: "GET",
        path: previewPath(relay.previewToken()),
      })

      expect(response.status).toBe(206)
      expect(response.body.equals(clip.subarray(1024, 2048))).toBe(true)
      expect(response.headers["content-type"]).toBe("video/mp4")
      expect(response.headers["content-disposition"]).toMatch(/^inline;/u)
      expect(response.headers["content-security-policy"]).toContain("sandbox")
    }
  )

  it("refuses a link for a different file", async () => {
    const { relay } = await relayWithClip()

    const response = await send(relay.port, {
      method: "GET",
      path: previewPath(
        relay.previewToken({ path: "clips/other.mp4" }),
        "clips/intro.mp4"
      ),
    })

    expect(response.status).toBe(401)
  })

  it("refuses a file transfer capability, which needs a proof", async () => {
    const { relay } = await relayWithClip()

    const response = await send(relay.port, {
      method: "GET",
      path: previewPath(relay.previewToken({ operation: "file" })),
    })

    expect(response.status).toBe(401)
  })

  it("refuses a link that grants writing", async () => {
    const { relay } = await relayWithClip()

    const response = await send(relay.port, {
      method: "GET",
      path: previewPath(
        relay.previewToken({ action: "instance.files.upload" })
      ),
    })

    expect(response.status).toBe(401)
  })

  it("refuses to change a file through a link", async () => {
    const { relay } = await relayWithClip()

    const response = await send(relay.port, {
      body: "replaced",
      method: "PUT",
      path: previewPath(relay.previewToken()),
    })

    expect(response.status).toBe(405)
    expect(
      await readFile(join(relay.instanceRoot, "clips/intro.mp4"))
    ).toHaveLength(4096)
  })

  it("never serves a page or script inline", async () => {
    const { relay } = await relayWithClip()

    const response = await send(relay.port, {
      method: "GET",
      path: previewPath(
        relay.previewToken({ path: "clips/page.html" }),
        "clips/page.html"
      ),
    })

    expect(response.status).toBe(415)
    expect(response.body.toString()).not.toContain("<script>")
  })

  it("refuses a link that lasts longer than a preview may", async () => {
    const { relay } = await relayWithClip()

    const response = await send(relay.port, {
      method: "GET",
      path: previewPath(relay.previewToken({ expiresInMs: 60 * 60_000 })),
    })

    expect(response.status).toBe(401)
  })

  it("isn't taken where a proof is asked for", async () => {
    const { relay } = await relayWithClip()
    const request = await relay.signedRequest({
      method: "GET",
      operation: "preview",
      path: "clips/intro.mp4",
    })

    expect((await send(relay.port, request)).status).toBe(401)
  })

  itOnLinux(
    "cuts off a file already playing when access is taken away",
    async () => {
      const relay = await startRelay()
      await mkdir(join(relay.instanceRoot, "clips"), { recursive: true })
      const size = 64 * 1024 * 1024
      await writeFile(
        join(relay.instanceRoot, "clips/intro.mp4"),
        Buffer.alloc(size, 7)
      )

      const { received, status } = await new Promise<{
        received: number
        status: number
      }>((resolve, reject) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            method: "GET",
            path: previewPath(relay.previewToken()),
            port: relay.port,
          },
          (response) => {
            let bytes = 0
            let revoked = false
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length
              if (revoked) return
              revoked = true
              // Hold the stream so the file is still being sent.
              response.pause()
              relay.revokeLive()
              setTimeout(() => response.resume(), 50)
            })
            const done = () =>
              resolve({ received: bytes, status: response.statusCode ?? 0 })
            response.once("close", done)
            response.once("error", done)
          }
        )
        request.once("error", reject)
        request.end()
      })

      // It was playing, and stopped short of the whole file.
      expect(status).toBe(200)
      expect(received).toBeGreaterThan(0)
      expect(received).toBeLessThan(size)
    }
  )

  it("waits its turn with the Relay's other unauthenticated requests", async () => {
    const relay = await startRelay({ pendingFileAuthentications: 1 })
    // A download form still arriving holds the one authentication slot.
    const slow = httpRequest({
      headers: {
        "Content-Length": "1024",
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: origin,
      },
      host: "127.0.0.1",
      method: "POST",
      path: `/v1/browser/files/${instanceId}`,
      port: relay.port,
    })
    slow.on("error", () => undefined)
    slow.write("path=")
    try {
      await vi.waitFor(async () => {
        const response = await send(relay.port, {
          method: "GET",
          path: previewPath(relay.previewToken()),
        })
        expect(response.status).toBe(429)
      })
    } finally {
      slow.destroy()
    }
  })

  itOnLinux("stops working once the person's access changes", async () => {
    const { relay } = await relayWithClip()
    const token = relay.previewToken()
    expect(
      (await send(relay.port, { method: "HEAD", path: previewPath(token) }))
        .status
    ).toBe(200)

    await relay.reviseAccess()

    expect(
      (await send(relay.port, { method: "GET", path: previewPath(token) }))
        .status
    ).toBe(401)
  })
})

async function startRelay(
  options: {
    instanceExists?: boolean
    pendingFileAuthentications?: number
  } = {}
) {
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
  const identity = { id: relayId } as RelayIdentity
  const gate = new TransferGate()
  const backups = backupLinks({ config, gate, identity, state })
  const filesystem = new FilesystemDriver(config)
  const lanes = new OperationLanes()
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
        pendingFileAuthentications: options.pendingFileAuthentications ?? 16,
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
    filesystem,
    gate,
    identity,
    lanes,
    onConsoleStop: () => undefined,
    runEffect: (effect) => Effect.runPromise(effect),
    server,
    state,
    subscribeSnapshots: () => () => undefined,
    workloadUsage: () => ({ history: [], resources: null, services: [] }),
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
    filesystem,
    instanceRoot,
    lanes,
    port: address.port,
    // A preview link's capability, as Hearth signs it for a media player.
    previewToken: (
      input: {
        action?: string
        expiresInMs?: number
        operation?: "file" | "preview"
        path?: string
      } = {}
    ) => {
      const issuedAt = Date.now()
      return signToken(issuerKeys.privateKey, {
        actions: [input.action ?? "instance.files.download"],
        audience: relayId,
        authorizationRevision: authority.minimumRevision,
        capabilityId: `preview-${randomBytes(6).toString("hex")}`,
        expiresAt: issuedAt + (input.expiresInMs ?? 10 * 60_000),
        instanceId,
        issuedAt,
        issuer,
        issuerGeneration: authority.issuerGeneration,
        keyThumbprint: "unused",
        loginSessionId: "login-1",
        operation: input.operation ?? "preview",
        origin,
        path: input.path ?? "clips/intro.mp4",
        subject: "user-1",
        version: 2,
      } satisfies RelayBrowserCapabilityV2)
    },
    // The Relay hears the person's access was taken away, as Hearth tells it,
    // which cuts off what's under way.
    revokeLive: () =>
      attached.reviseAuthorization(
        issuer,
        [
          {
            minimumRevision: authority.minimumRevision + 1,
            scope: { kind: "login_session", loginSessionId: "login-1" },
            subject: "user-1",
          },
        ],
        authority.issuerGeneration
      ),
    // Hearth raises the person's floor, as when their access is taken away.
    reviseAccess: () =>
      runtime.runPromise(
        state.reviseBrowserAuthorization(
          issuer,
          [
            {
              minimumRevision: authority.minimumRevision + 1,
              scope: { kind: "login_session", loginSessionId: "login-1" },
              subject: "user-1",
            },
          ],
          undefined,
          Date.now()
        )
      ),
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
      operation?: "file" | "preview"
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
        operation: input.operation ?? "file",
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
): Promise<{
  body: Buffer
  headers: IncomingMessage["headers"]
  status: number
}> {
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
            headers: response.headers,
            status: response.statusCode ?? 0,
          })
        )
      }
    )
    request.once("error", reject)
    request.end(input.body)
  })
}
