import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import ssh2 from "ssh2"
import { describe, expect, it, onTestFinished } from "vite-plus/test"

import type { RelayConfig } from "./config.js"
import { attachSftpServer } from "./sftp-server.js"
import { testInstance, testRelayConfig } from "./test/fixtures.js"

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

describeLinux("Relay SFTP server", () => {
  it.each([
    {
      credential: "kiln_cli_secret",
      developmentAuthentication: false,
      password: "kiln_cli_secret",
    },
    {
      credential: "dev123",
      developmentAuthentication: false,
      password: "dev123",
    },
    {
      credential: "kiln_cli_secret",
      developmentAuthentication: true,
      password: "kiln_cli_secret",
    },
    {
      credential: undefined,
      developmentAuthentication: true,
      password: "dev123",
    },
  ])(
    "forwards $password to Hearth as credential $credential (development auth: $developmentAuthentication)",
    async ({ credential, developmentAuthentication, password }) => {
      const dataDirectory = await temporaryDirectory()
      await mkdir(resolve(dataDirectory, "instances"), { recursive: true })
      const requests: Array<{ operation: string; payload: unknown }> = []
      const server = await attachSftpServer({
        clientActions: allowFileAccess,
        config: {
          ...testConfig(dataDirectory),
          sftpDevAuthentication: developmentAuthentication,
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

      const client = await connect(server.port, password)
      try {
        expect(requests).toEqual([
          {
            operation: "sftp.authorization.resolve",
            payload: {
              ...(credential === undefined ? {} : { credential }),
              username: "user@example.test",
            },
          },
        ])
      } finally {
        client.end()
        await server.close()
      }
    }
  )

  it.each([false, true])(
    "rejects empty passwords without contacting Hearth (development auth: %s)",
    async (developmentAuthentication) => {
      const dataDirectory = await temporaryDirectory()
      await mkdir(resolve(dataDirectory, "instances"), { recursive: true })
      const requests: Array<unknown> = []
      const server = await attachSftpServer({
        clientActions: allowFileAccess,
        config: {
          ...testConfig(dataDirectory),
          sftpDevAuthentication: developmentAuthentication,
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
    }
  )

  it("exposes authorized instances, transfers files, and rejects SSH commands", async () => {
    const dataDirectory = await temporaryDirectory()
    const instanceId = "a".repeat(40)
    const rootDirectory = resolve(dataDirectory, "instances")
    const instanceDirectory = resolve(rootDirectory, instanceId)
    await mkdir(instanceDirectory, { recursive: true })
    await writeFile(resolve(instanceDirectory, "existing.txt"), "existing")
    const instance = testInstance({ id: instanceId })
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
          id === instanceId ? testInstance({ id: instanceId }) : null,
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
    ...testRelayConfig(dataDirectory),
    host: "127.0.0.1",
    sftpDevAuthentication: true,
    sftpPort: 0,
  }
}
