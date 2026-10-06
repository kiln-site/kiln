import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assert, describe, it } from "@effect/vitest"
import type { CliSftpResponse } from "@workspace/contracts"
import { Cause, Effect, Exit, Fiber } from "effect"
import { Server, utils, type Connection } from "ssh2"
import { afterEach, beforeEach } from "vite-plus/test"

import type { KilnSession } from "./config.js"
import { downloadSftpFileEffect, uploadSftpFileEffect } from "./sftp.js"

const { OPEN_MODE, STATUS_CODE } = utils.sftp
const root = "/srv/kiln/instances/test/root"
const session: KilnSession = {
  profile: "test",
  token: "kiln_cli_sftp_secret",
  url: "https://kiln.example.test",
}

const hostKey = utils.generateKeyPairSync("ed25519")
const parsedHostKey = utils.parseKey(hostKey.public)
if (parsedHostKey instanceof Error) throw parsedHostKey
const hostKeyFingerprint = `SHA256:${createHash("sha256")
  .update(parsedHostKey.getPublicSSH())
  .digest("base64")}`

interface RelaySftpOptions {
  // Never answer password authentication, holding the client mid-handshake.
  holdAuthentication?: boolean
  // Never answer reads, holding a download mid-transfer.
  holdReads?: boolean
}

// An in-process Relay SFTP endpoint backed by an in-memory file map.
async function startRelaySftp(options: RelaySftpOptions = {}) {
  const files = new Map<string, Buffer>()
  const passwords: Array<string> = []
  const clients: Array<Connection> = []
  const closed: Array<Promise<unknown>> = []
  const authenticating = deferred()
  const reading = deferred()

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.push(client)
    // Resets from an aborting client are expected; only closure matters.
    client.on("error", () => undefined)
    closed.push(new Promise<void>((resolve) => client.on("close", resolve)))
    client.on("authentication", (context) => {
      if (context.method !== "password") {
        context.reject(["password"])
        return
      }
      passwords.push(context.password)
      if (options.holdAuthentication) {
        authenticating.resolve()
        return
      }
      if (context.password === session.token) context.accept()
      else context.reject()
    })
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        acceptSession().on("sftp", (acceptSftp) => {
          const sftp = acceptSftp()
          const handles = new Map<
            string,
            { path: string; data: Buffer; write: boolean }
          >()
          let nextHandle = 0
          const entry = (handle: Buffer) => handles.get(handle.toString())
          const attrs = (size: number) => ({
            atime: 0,
            gid: 0,
            mode: 0o100644,
            mtime: 0,
            size,
            uid: 0,
          })
          sftp.on("OPEN", (reqId, path, flags) => {
            const write = (flags & OPEN_MODE.WRITE) !== 0
            const existing = files.get(path)
            if (!write && !existing) {
              sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE)
              return
            }
            const handle = String(nextHandle++)
            handles.set(handle, {
              data: write ? Buffer.alloc(0) : existing!,
              path,
              write,
            })
            sftp.handle(reqId, Buffer.from(handle))
          })
          sftp.on("FSTAT", (reqId, handle) => {
            const file = entry(handle)
            if (!file) return sftp.status(reqId, STATUS_CODE.FAILURE)
            sftp.attrs(reqId, attrs(file.data.length))
          })
          sftp.on("STAT", (reqId, path) => {
            const data = files.get(path)
            if (!data) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE)
            sftp.attrs(reqId, attrs(data.length))
          })
          sftp.on("READ", (reqId, handle, offset, length) => {
            if (options.holdReads) {
              reading.resolve()
              return
            }
            const file = entry(handle)
            if (!file) return sftp.status(reqId, STATUS_CODE.FAILURE)
            if (offset >= file.data.length) {
              return sftp.status(reqId, STATUS_CODE.EOF)
            }
            sftp.data(reqId, file.data.subarray(offset, offset + length))
          })
          sftp.on("WRITE", (reqId, handle, offset, data) => {
            const file = entry(handle)
            if (!file) return sftp.status(reqId, STATUS_CODE.FAILURE)
            const next = Buffer.alloc(
              Math.max(file.data.length, offset + data.length)
            )
            file.data.copy(next)
            data.copy(next, offset)
            file.data = next
            sftp.status(reqId, STATUS_CODE.OK)
          })
          sftp.on("CLOSE", (reqId, handle) => {
            const file = entry(handle)
            if (file?.write) files.set(file.path, file.data)
            handles.delete(handle.toString())
            sftp.status(reqId, STATUS_CODE.OK)
          })
        })
      })
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const connection: CliSftpResponse = {
    host: "127.0.0.1",
    hostKeyFingerprint,
    port: (server.address() as AddressInfo).port,
    root,
    username: "test@example.test",
  }
  return {
    authenticating: authenticating.promise,
    // Resolves once every connection the CLI opened has been closed.
    allClosed: () => Promise.all(closed),
    clients,
    close: () => {
      clients.forEach((client) => client.end())
      server.close()
    },
    connection,
    files,
    passwords,
    reading: reading.promise,
  }
}

function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

let directory = ""
let relay: Awaited<ReturnType<typeof startRelaySftp>> | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kiln-cli-sftp-"))
})

afterEach(async () => {
  relay?.close()
  relay = undefined
  await rm(directory, { force: true, recursive: true })
})

function defectCode(exit: Exit.Exit<unknown, unknown>) {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause) as { code?: string }
  return error.code
}

describe("CLI SFTP transfers", () => {
  it("uploads into the server root and downloads the same bytes back", async () => {
    relay = await startRelaySftp()
    const contents = Buffer.from("plugin bytes ".repeat(10_000))
    const source = join(directory, "source.jar")
    const destination = join(directory, "destination.jar")
    await writeFile(source, contents)

    const uploaded = await Effect.runPromise(
      uploadSftpFileEffect({
        connection: relay.connection,
        localPath: source,
        remotePath: "plugins/My Plugin.jar",
        session,
      })
    )
    const downloaded = await Effect.runPromise(
      downloadSftpFileEffect({
        connection: relay.connection,
        localPath: destination,
        remotePath: "/plugins/My Plugin.jar",
        session,
      })
    )

    assert.strictEqual(uploaded.bytes, contents.length)
    assert.deepStrictEqual(
      relay.files.get(`${root}/plugins/My Plugin.jar`),
      contents
    )
    assert.strictEqual(downloaded.bytes, contents.length)
    assert.deepStrictEqual(await readFile(destination), contents)
    await relay.allClosed()
  })

  it("rejects remote paths that escape the server root before connecting", async () => {
    relay = await startRelaySftp()
    const source = join(directory, "source.jar")
    await writeFile(source, "contents")

    for (const remotePath of ["../../etc/passwd", "plugins/../../x", ""]) {
      const upload = await Effect.runPromiseExit(
        uploadSftpFileEffect({
          connection: relay.connection,
          localPath: source,
          remotePath: remotePath || " ",
          session,
        })
      )
      const download = await Effect.runPromiseExit(
        downloadSftpFileEffect({
          connection: relay.connection,
          localPath: join(directory, "download"),
          remotePath,
          session,
        })
      )
      assert.strictEqual(defectCode(upload), "invalid_arguments", remotePath)
      assert.strictEqual(defectCode(download), "invalid_arguments", remotePath)
    }
    assert.strictEqual(relay.clients.length, 0)
  })

  it("never sends the token to a server with an unexpected host key", async () => {
    relay = await startRelaySftp()

    const exit = await Effect.runPromiseExit(
      downloadSftpFileEffect({
        connection: {
          ...relay.connection,
          hostKeyFingerprint: `SHA256:${Buffer.alloc(32).toString("base64")}`,
        },
        localPath: join(directory, "download"),
        remotePath: "server.jar",
        session,
      })
    )

    assert.strictEqual(defectCode(exit), "sftp_failed")
    assert.deepStrictEqual(relay.passwords, [])
  })

  it("closes the connection when interrupted during the handshake", async () => {
    relay = await startRelaySftp({ holdAuthentication: true })
    const fiber = Effect.runFork(
      downloadSftpFileEffect({
        connection: relay.connection,
        localPath: join(directory, "download"),
        remotePath: "server.jar",
        session,
      })
    )

    await relay.authenticating
    fiber.interruptUnsafe()
    const exit = await Effect.runPromise(Fiber.await(fiber))

    assert.isTrue(Exit.hasInterrupts(exit))
    await relay.allClosed()
  })

  it("closes the connection when interrupted during a transfer", async () => {
    relay = await startRelaySftp({ holdReads: true })
    relay.files.set(`${root}/server.jar`, Buffer.alloc(1024 * 1024))
    const fiber = Effect.runFork(
      downloadSftpFileEffect({
        connection: relay.connection,
        localPath: join(directory, "download"),
        remotePath: "server.jar",
        session,
      })
    )

    await relay.reading
    fiber.interruptUnsafe()
    const exit = await Effect.runPromise(Fiber.await(fiber))

    assert.isTrue(Exit.hasInterrupts(exit))
    await relay.allClosed()
  })
})
