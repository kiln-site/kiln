import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import ssh2 from "ssh2"
import { describe, expect, it, onTestFinished } from "vite-plus/test"

import type { RelayConfig, RelayInstanceConfig } from "./config.js"
import {
  attachSftpServer,
  generateSftpHostKey,
  resolveSftpAuthentication,
} from "./sftp-server.js"

const describeLinux = process.platform === "linux" ? describe : describe.skip
const malformedLeadingZeroHostKey =
  "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMgAAAAtz\n" +
  "c2gtZWQyNTUxOQAAAB+jDciCPNYigCaepbLo4ALlS5noOsmjwBiR1J0bM1F3AAAA\n" +
  "iDm+j7k5vo+5AAAAC3NzaC1lZDI1NTE5AAAAH6MNyII81iKAJp6lsujgAuVLmeg6\n" +
  "yaPAGJHUnRszUXcAAAA/RAHNwV+KXisa0Z0KAzz7d5kSa8TvBf0b9jh2Pu3RpJmj\n" +
  "DciCPNYigCaepbLo4ALlS5noOsmjwBiR1J0bM1F3AAAAAAECAwQFBgc=\n" +
  "-----END OPENSSH PRIVATE KEY-----\n"
const allowFileAccess = async () => [
  "instance.sftp.connect",
  "instance.files.list",
  "instance.files.read",
  "instance.files.create",
  "instance.files.write",
  "instance.files.delete",
  "instance.files.rename",
  "instance.files.chmod",
]

describe("Relay SFTP host key", () => {
  it("retries when ssh2 generates a malformed leading-zero Ed25519 key", () => {
    const validHostKey = generateSftpHostKey()
    let attempts = 0
    const generated = generateSftpHostKey(() => {
      attempts += 1
      return attempts === 1 ? malformedLeadingZeroHostKey : validHostKey
    })

    expect(attempts).toBe(2)
    expect(generated).toEqual(validHostKey)
  })
})

describe("Relay SFTP authentication", () => {
  it("reserves credential-free authorization for the development password", () => {
    expect(resolveSftpAuthentication("", false)).toBeNull()
    expect(resolveSftpAuthentication("", true)).toBeNull()
    expect(resolveSftpAuthentication("kiln_cli_secret", false)).toEqual({
      credential: "kiln_cli_secret",
    })
    expect(resolveSftpAuthentication("dev123", true)).toEqual({
      credential: undefined,
    })
  })
})

describeLinux("Relay SFTP server", () => {
  it("forwards production passwords to Hearth as CLI credentials", async () => {
    const dataDirectory = await temporaryDirectory()
    await mkdir(resolve(dataDirectory, "instances"), { recursive: true })
    const requests: Array<{ operation: string; payload: unknown }> = []
    const server = await attachSftpServer({
      clientActions: allowFileAccess,
      config: {
        ...testConfig(dataDirectory),
        sftpDevAuthentication: false,
      },
      control: {
        requestClients: async (operation, payload) => {
          requests.push({ operation, payload })
          return [
            {
              clientId: "hearth-test",
              payload: {
                instances: [
                  {
                    actions: ["instance.files.list"],
                    id: "a".repeat(40),
                  },
                ],
                userId: "user-test",
                username: "user@example.test",
              },
            },
          ]
        },
      },
      docker: { findInstance: async () => null },
    })

    const client = await connect(server.port, "kiln_cli_secret")
    try {
      expect(requests[0]).toEqual({
        operation: "sftp.authorization.resolve",
        payload: {
          credential: "kiln_cli_secret",
          username: "user@example.test",
        },
      })
    } finally {
      client.end()
      await server.close()
    }
  })

  it("rejects empty production passwords without contacting Hearth", async () => {
    const dataDirectory = await temporaryDirectory()
    await mkdir(resolve(dataDirectory, "instances"), { recursive: true })
    const requests: Array<unknown> = []
    const server = await attachSftpServer({
      clientActions: allowFileAccess,
      config: {
        ...testConfig(dataDirectory),
        sftpDevAuthentication: false,
      },
      control: {
        requestClients: async (_operation, payload) => {
          requests.push(payload)
          return []
        },
      },
      docker: { findInstance: async () => null },
    })
    try {
      await expect(connect(server.port, "")).rejects.toThrow(
        "All configured authentication methods failed"
      )
      expect(requests).toEqual([])
    } finally {
      await server.close()
    }
  })

  it("exposes authorized instances, transfers files, and rejects SSH commands", async () => {
    const dataDirectory = await temporaryDirectory()
    const instanceId = "a".repeat(40)
    const rootDirectory = resolve(dataDirectory, "instances")
    const instanceDirectory = resolve(rootDirectory, instanceId)
    await mkdir(instanceDirectory, { recursive: true })
    await writeFile(resolve(instanceDirectory, "existing.txt"), "existing")
    const instance = testInstance(instanceId)
    const server = await attachSftpServer({
      clientActions: allowFileAccess,
      config: testConfig(dataDirectory),
      control: {
        requestClients: async () => [
          {
            clientId: "hearth-test",
            payload: {
              instances: [
                {
                  actions: [
                    "instance.files.list",
                    "instance.files.read",
                    "instance.files.create",
                    "instance.files.write",
                    "instance.files.delete",
                    "instance.files.rename",
                    "instance.files.chmod",
                  ],
                  id: instanceId,
                },
              ],
              userId: "user-test",
              username: "user@example.test",
            },
          },
        ],
      },
      docker: {
        findInstance: async (id) => (id === instanceId ? instance : null),
      },
    })

    const client = await connect(server.port, "dev123")
    try {
      const stream = await sftp(client)
      const roots = await sftpCall<Array<{ filename: string }>>(
        stream,
        "readdir",
        "/"
      )
      expect(roots.map((entry) => entry.filename)).toEqual([instanceId])
      const path = `/${instanceId}/round-trip.txt`
      await sftpCall(stream, "writeFile", path, Buffer.from("round trip"))
      const downloaded = await sftpCall<Buffer>(stream, "readFile", path)
      expect(downloaded.toString()).toBe("round trip")
      expect(
        await readFile(resolve(instanceDirectory, "round-trip.txt"), "utf8")
      ).toBe("round trip")
      await sftpCall(stream, "unlink", path)
      await expect(execute(client, "whoami")).rejects.toThrow()
    } finally {
      client.end()
      await server.close()
    }
  })

  it("rejects invalid development credentials", async () => {
    const dataDirectory = await temporaryDirectory()
    await mkdir(resolve(dataDirectory, "instances"), { recursive: true })
    const server = await attachSftpServer({
      clientActions: allowFileAccess,
      config: testConfig(dataDirectory),
      control: { requestClients: async () => [] },
      docker: { findInstance: async () => null },
    })
    try {
      await expect(connect(server.port, "wrong-password")).rejects.toThrow(
        "All configured authentication methods failed"
      )
    } finally {
      await server.close()
    }
  })

  it("closes active connections before server shutdown completes", async () => {
    const dataDirectory = await temporaryDirectory()
    await mkdir(resolve(dataDirectory, "instances"), { recursive: true })
    const server = await attachSftpServer({
      clientActions: allowFileAccess,
      config: testConfig(dataDirectory),
      control: {
        requestClients: async () => [
          {
            clientId: "hearth-test",
            payload: {
              instances: [
                {
                  actions: ["instance.files.list"],
                  id: "a".repeat(40),
                },
              ],
              userId: "user-test",
              username: "user@example.test",
            },
          },
        ],
      },
      docker: { findInstance: async () => null },
    })
    const client = await connect(server.port, "dev123")
    const closed = new Promise<void>((resolveClose) => {
      client.once("close", () => resolveClose())
    })

    await server.close()
    await closed
    await expect(connect(server.port, "dev123")).rejects.toThrow()
  })

  it("rejects a Hearth without the SFTP connection action", async () => {
    const dataDirectory = await temporaryDirectory()
    await mkdir(resolve(dataDirectory, "instances"), { recursive: true })
    const server = await attachSftpServer({
      clientActions: async () => ["instance.files.list", "instance.files.read"],
      config: testConfig(dataDirectory),
      control: {
        requestClients: async () => [
          {
            clientId: "revoked-hearth",
            payload: {
              instances: [
                {
                  actions: ["instance.files.list", "instance.files.read"],
                  id: "a".repeat(40),
                },
              ],
              userId: "user-test",
              username: "user@example.test",
            },
          },
        ],
      },
      docker: { findInstance: async () => null },
    })
    try {
      await expect(connect(server.port, "dev123")).rejects.toThrow(
        "All configured authentication methods failed"
      )
    } finally {
      await server.close()
    }
  })

  it("intersects file operations with the paired Hearth grant", async () => {
    const dataDirectory = await temporaryDirectory()
    const instanceId = "b".repeat(40)
    const instanceDirectory = resolve(dataDirectory, "instances", instanceId)
    await mkdir(instanceDirectory, { recursive: true })
    await writeFile(resolve(instanceDirectory, "readable.txt"), "read only")
    const server = await attachSftpServer({
      clientActions: async () => [
        "instance.sftp.connect",
        "instance.files.list",
        "instance.files.read",
      ],
      config: testConfig(dataDirectory),
      control: {
        requestClients: async () => [
          {
            clientId: "read-only-hearth",
            payload: {
              instances: [
                {
                  actions: [
                    "instance.files.list",
                    "instance.files.read",
                    "instance.files.create",
                    "instance.files.write",
                  ],
                  id: instanceId,
                },
              ],
              userId: "user-test",
              username: "user@example.test",
            },
          },
        ],
      },
      docker: {
        findInstance: async (id) =>
          id === instanceId ? testInstance(instanceId) : null,
      },
    })
    const client = await connect(server.port, "dev123")
    try {
      const stream = await sftp(client)
      const readable = await sftpCall<Buffer>(
        stream,
        "readFile",
        `/${instanceId}/readable.txt`
      )
      expect(readable.toString()).toBe("read only")
      await expect(
        sftpCall(
          stream,
          "writeFile",
          `/${instanceId}/forbidden.txt`,
          Buffer.from("no")
        )
      ).rejects.toThrow()
    } finally {
      client.end()
      await server.close()
    }
  })

  it("rejects an email claimed by more than one connected Hearth", async () => {
    const dataDirectory = await temporaryDirectory()
    await mkdir(resolve(dataDirectory, "instances"), { recursive: true })
    const authorization = {
      instances: [
        {
          actions: ["instance.files.list", "instance.files.read"],
          id: "a".repeat(40),
        },
      ],
      userId: "user-test",
      username: "user@example.test",
    }
    const server = await attachSftpServer({
      clientActions: allowFileAccess,
      config: testConfig(dataDirectory),
      control: {
        requestClients: async () => [
          { clientId: "hearth-one", payload: authorization },
          { clientId: "hearth-two", payload: authorization },
        ],
      },
      docker: { findInstance: async () => null },
    })
    try {
      await expect(connect(server.port, "dev123")).rejects.toThrow(
        "All configured authentication methods failed"
      )
    } finally {
      await server.close()
    }
  })

  it("persists a stable SSH host-key fingerprint", async () => {
    const dataDirectory = await temporaryDirectory()
    await mkdir(resolve(dataDirectory, "instances"), { recursive: true })
    const hostKeyPath = resolve(dataDirectory, "network", "sftp", "host.key")
    await mkdir(resolve(dataDirectory, "network", "sftp"), { recursive: true })
    await writeFile(hostKeyPath, malformedLeadingZeroHostKey)
    const options = {
      clientActions: allowFileAccess,
      config: testConfig(dataDirectory),
      control: { requestClients: async () => [] },
      docker: { findInstance: async () => null },
    }
    const first = await attachSftpServer(options)
    const fingerprint = first.hostKeyFingerprint
    await first.close()
    const second = await attachSftpServer(options)
    try {
      expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/u)
      expect(second.hostKeyFingerprint).toBe(fingerprint)
      expect(
        ssh2.utils.parseKey(await readFile(hostKeyPath))
      ).not.toBeInstanceOf(Error)
    } finally {
      await second.close()
    }
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "kiln-sftp-test-"))
  onTestFinished(() => rm(directory, { force: true, recursive: true }))
  return directory
}

function connect(port: number, password: string): Promise<ssh2.Client> {
  const client = new ssh2.Client()
  return new Promise((resolveConnect, reject) => {
    client.once("ready", () => resolveConnect(client))
    client.once("error", reject)
    client.connect({
      host: "127.0.0.1",
      hostVerifier: () => true,
      password,
      port,
      readyTimeout: 5_000,
      username: "user@example.test",
    })
  })
}

function sftp(client: ssh2.Client): Promise<ssh2.SFTPWrapper> {
  return new Promise((resolveSftp, reject) => {
    client.sftp((cause, stream) =>
      cause ? reject(cause) : resolveSftp(stream)
    )
  })
}

function sftpCall<T = void>(
  stream: ssh2.SFTPWrapper,
  method: string,
  ...arguments_: ReadonlyArray<unknown>
): Promise<T> {
  return new Promise((resolveCall, reject) => {
    const operation = stream[method as keyof ssh2.SFTPWrapper] as Function
    operation.call(
      stream,
      ...arguments_,
      (cause: Error | undefined, value: T) =>
        cause ? reject(cause) : resolveCall(value)
    )
  })
}

function execute(client: ssh2.Client, command: string): Promise<void> {
  return new Promise((resolveExecution, reject) => {
    client.exec(command, (cause, stream) =>
      cause || !stream
        ? reject(cause ?? new Error("No stream"))
        : resolveExecution()
    )
  })
}

function testConfig(dataDirectory: string): RelayConfig {
  return {
    advertisedHost: "127.0.0.1",
    advertisedHostInferred: false,
    backupTimeoutMs: 60 * 60_000,
    bootstrapToken: null,
    brickCatalogUrl: "https://example.test/catalog.yml",
    browserOrigin: "https://127.0.0.1:4100",
    canProvisionInstances: true,
    coolifyPublicOrigin: null,
    composeFile: resolve(dataDirectory, "instances", "compose.yaml"),
    connectDomain: "test",
    connectPort: 25_565,
    dataDirectory,
    directBrowserOrigin: "https://127.0.0.1:4100",
    directPublicPort: 4100,
    discoveredPublicIp: null,
    dockerSocket: "/var/run/docker.sock",
    gameHost: "127.0.0.1",
    gamePortRange: { end: 39_999, start: 30_000 },
    gameHostSource: "relay",
    gitRepository: "https://github.com/kiln-site/kiln",
    hearthInternalOrigin: null,
    hearthPublicOrigin: null,
    host: "127.0.0.1",
    installationId: null,
    managedLabel: "kiln.relay.managed=true",
    mclogsApiUrl: "https://api.mclo.gs/1/log",
    nodeId: "test",
    nodeName: "Test Relay",
    port: 4100,
    platformBackupKey: null,
    publicPort: 4100,
    projectDirectory: resolve(dataDirectory, "instances"),
    projectName: "test",
    proxyMode: "none",
    resourceNamespace: null,
    rootDirectory: resolve(dataDirectory, "instances"),
    runtimeRecovery: {
      initialDelayMs: 5_000,
      maxRetries: 2,
      stabilityMs: 300_000,
    },
    serverIdLabel: "kiln.server.id",
    sftpDevAuthentication: true,
    sftpPort: 0,
    tlsCertificatePath: null,
    tlsKeyPath: null,
    tlsMode: "development",
    traefikAcmeEmail: null,
    traefikImage: "traefik:v3.6.6",
  }
}

function testInstance(id: string): RelayInstanceConfig {
  return {
    connectAddress: "localhost",
    directory: id,
    game: "Minecraft",
    id,
    implementation: "Paper",
    javaVersion: "21",
    limits: { diskBytes: 0, memoryBytes: 0 },
    managedByRelay: true,
    name: "Test Instance",
    ports: [],
    service: "test",
    shortId: id.slice(0, 8),
    tailscale: { enabled: false },
    version: "1.21.11",
  }
}
