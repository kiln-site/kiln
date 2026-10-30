import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { Effect } from "effect"
import ssh2 from "ssh2"
import { describe, expect, it, onTestFinished } from "vite-plus/test"

import type { RelayConfig } from "./config.js"
import { attachSftpServer } from "./sftp-server.js"
import { testInstance, testRelayConfig } from "./test/fixtures.js"
import { OperationLanes } from "./operation-lanes.js"
import { instanceReplaceLocks } from "./operation-plans.js"

const describeLinux = process.platform === "linux" ? describe : describe.skip
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
  it("stops writing through a handle opened before the server was replaced", async () => {
    const dataDirectory = await temporaryDirectory()
    const instanceId = "c".repeat(40)
    const instanceDirectory = resolve(dataDirectory, "instances", instanceId)
    await mkdir(instanceDirectory, { recursive: true })
    const instance = testInstance({ id: instanceId })
    const lanes = new OperationLanes()
    const server = await attachSftpServer({
      lanes,
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
      const path = `/${instanceId}/world.dat`
      const handle = await sftpCall<Buffer>(stream, "open", path, "w")
      const chunk = Buffer.from("before")
      await sftpCall(stream, "write", handle, chunk, 0, chunk.length, 0)

      // A restore replaces the server's files while the handle is open.
      await Effect.runPromise(
        lanes.run(
          { label: "restore", locks: instanceReplaceLocks(instanceId) },
          Effect.void
        )
      )

      const late = Buffer.from("after")
      await expect(
        sftpCall(stream, "write", handle, late, 0, late.length, 6)
      ).rejects.toThrow()
      expect(
        await readFile(resolve(instanceDirectory, "world.dat"), "utf8")
      ).toBe("before")
      // Reopening writes to the restored server.
      const reopened = await sftpCall<Buffer>(stream, "open", path, "w")
      await sftpCall(stream, "write", reopened, late, 0, late.length, 0)
      expect(
        await readFile(resolve(instanceDirectory, "world.dat"), "utf8")
      ).toBe("after")
    } finally {
      client.end()
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
      lanes: new OperationLanes(),
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
      lanes: new OperationLanes(),
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

function testConfig(dataDirectory: string): RelayConfig {
  return {
    ...testRelayConfig(dataDirectory),
    host: "127.0.0.1",
    sftpDevAuthentication: true,
    sftpPort: 0,
  }
}
