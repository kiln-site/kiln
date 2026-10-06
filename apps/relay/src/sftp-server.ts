import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
  lstat,
} from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import type { Stats } from "node:fs"
import type { AddressInfo } from "node:net"
import { dirname, posix, resolve, sep } from "node:path"
import * as Sentry from "@sentry/node"
import { Effect, Fiber } from "effect"
import ssh2 from "ssh2"
import type { Attributes, Connection, FileEntry, SFTPWrapper } from "ssh2"
import type { FileHandle } from "node:fs/promises"

import type { RelayConfig } from "./config.js"
import type { ControlSocketServer } from "./control-socket.js"
import type { DockerDriver } from "./docker.js"

const DEVELOPMENT_PASSWORD = "dev123"
const MAX_OPEN_HANDLES = 128
const DIRECTORY_BATCH_SIZE = 128
const MAX_DIRECTORY_ENTRIES = 10_000
const MAX_SFTP_CONNECTIONS = 64
const HOST_KEY_GENERATION_ATTEMPTS = 8
const DIRECTORY_MODE = fsConstants.S_IFDIR | 0o755
const { Server, utils } = ssh2
const { OPEN_MODE, STATUS_CODE } = utils.sftp

interface SftpGrant {
  actions: ReadonlyArray<string>
  id: string
}

interface ResolvedGrant extends SftpGrant {
  root: string
}

interface OpenFile {
  actions: ReadonlyArray<string>
  file: FileHandle
  kind: "file"
  readable: boolean
  writable: boolean
}

interface OpenDirectory {
  entries: Array<FileEntry>
  index: number
  kind: "directory"
}

type OpenResource = OpenDirectory | OpenFile

interface ResolvedPath {
  grant: ResolvedGrant | null
  physicalPath: string | null
  virtualPath: string
}

export interface SftpServerHandle {
  close: () => Promise<void>
  hostKeyFingerprint: string
  port: number
}

export async function attachSftpServer(options: {
  clientActions: (clientId: string) => Promise<ReadonlyArray<string>>
  config: RelayConfig
  control: Pick<ControlSocketServer, "requestClients">
  docker: Pick<DockerDriver, "findInstance">
}): Promise<SftpServerHandle> {
  if (process.platform !== "linux") {
    throw new Error("Secure Relay SFTP requires a Linux host")
  }
  const hostKey = await loadOrCreateHostKey(options.config)
  const hostKeyFingerprint = fingerprintHostKey(hostKey)
  const connections = new Set<Connection>()
  const server = new Server(
    {
      hostKeys: [hostKey],
      ident: "kiln-relay",
      keepaliveCountMax: 3,
      keepaliveInterval: 15_000,
    },
    (client) => {
      if (connections.size >= MAX_SFTP_CONNECTIONS) {
        client.end()
        return
      }
      connections.add(client)
      const connectionFibers = new Set<Fiber.Fiber<void, never>>()
      let grants: ReadonlyArray<SftpGrant> | null = null
      let authenticatedUsername: string | null = null
      let authenticatedCredential: string | undefined

      const forkConnection = (
        effect: Effect.Effect<void>
      ): Fiber.Fiber<void, never> => {
        let fiber: Fiber.Fiber<void, never>
        fiber = Effect.runFork(
          effect.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                connectionFibers.delete(fiber)
              })
            )
          )
        )
        connectionFibers.add(fiber)
        return fiber
      }

      client.on("authentication", (context) => {
        if (context.method !== "password") {
          context.reject(["password"])
          return
        }
        const authentication = resolveSftpAuthentication(
          context.password,
          options.config.sftpDevAuthentication
        )
        if (!authentication) {
          context.reject(["password"])
          return
        }
        const { credential } = authentication
        forkConnection(
          sftpOperation(() =>
            authorizeUsername(
              options.control,
              context.username,
              options.clientActions,
              credential
            )
          ).pipe(
            Effect.match({
              onSuccess: (authorized) => {
                if (!authorized.length) {
                  context.reject(["password"])
                  return
                }
                grants = authorized
                authenticatedUsername = context.username.trim().toLowerCase()
                authenticatedCredential = credential
                Sentry.addBreadcrumb({
                  category: "relay.sftp",
                  level: "info",
                  message: "SFTP authentication accepted",
                })
                context.accept()
              },
              onFailure: (cause) => {
                Sentry.captureException(cause, {
                  tags: { "kiln.operation": "sftp.authentication" },
                })
                context.reject(["password"])
              },
            })
          )
        )
      })

      client.on("ready", () => {
        if (!grants) {
          client.end()
          return
        }
        forkConnection(
          Effect.sleep("15 seconds").pipe(
            Effect.andThen(
              Effect.suspend(() => {
                if (!authenticatedUsername || !grants) return Effect.void
                return sftpOperation(() =>
                  authorizeUsername(
                    options.control,
                    authenticatedUsername as string,
                    options.clientActions,
                    authenticatedCredential
                  )
                ).pipe(
                  Effect.match({
                    onSuccess: (authorized) => {
                      if (!grants || !sameGrants(grants, authorized)) {
                        client.end()
                      }
                    },
                    onFailure: (cause) => {
                      Sentry.captureException(cause, {
                        tags: {
                          "kiln.operation": "sftp.authorization.refresh",
                        },
                      })
                      client.end()
                    },
                  })
                )
              })
            ),
            Effect.forever
          )
        )
        client.on("session", (accept) => {
          const session = accept()
          session.on("sftp", (acceptSftp) => {
            forkConnection(
              sftpOperation(() => resolveGrants(options, grants ?? [])).pipe(
                Effect.match({
                  onSuccess: (resolved) => {
                    if (!resolved.length) {
                      session.end()
                      return
                    }
                    serveSftp(acceptSftp(), resolved)
                  },
                  onFailure: (cause) => {
                    Sentry.captureException(cause, {
                      tags: { "kiln.operation": "sftp.session" },
                    })
                    session.end()
                  },
                })
              )
            )
          })
          session.on("shell", (_accept, reject) => reject())
          session.on("exec", (_accept, reject) => reject())
          session.on("pty", (_accept, reject) => reject())
          session.on("subsystem", (_accept, reject) => reject())
        })
      })
      client.on("error", (cause) => {
        Sentry.addBreadcrumb({
          category: "relay.sftp",
          level: "warning",
          message: cause.message,
        })
      })
      client.once("close", () => {
        for (const fiber of connectionFibers) fiber.interruptUnsafe()
        connectionFibers.clear()
        connections.delete(client)
        Sentry.addBreadcrumb({
          category: "relay.sftp",
          level: "info",
          message: "SFTP connection closed",
        })
      })
    }
  )

  await Effect.runPromise(
    listenSftpServerEffect(server, options.config.sftpPort, options.config.host)
  )
  server.on("error", (cause: Error) => {
    Sentry.captureException(cause, {
      tags: { "kiln.operation": "sftp.server" },
    })
  })
  const address = server.address() as AddressInfo
  const port = address.port
  if (options.config.sftpDevAuthentication) {
    console.warn(
      "Relay development SFTP authentication is enabled; password material is not suitable for production."
    )
  }
  console.log(
    `Relay SFTP listening on ${options.config.host}:${port} (${hostKeyFingerprint})`
  )
  return {
    close: () =>
      Effect.runPromise(
        Effect.sync(() => {
          for (const connection of connections) connection.end()
        }).pipe(Effect.andThen(closeSftpServerEffect(server)))
      ),
    hostKeyFingerprint,
    port,
  }
}

function fingerprintHostKey(hostKey: Buffer): string {
  const parsed = utils.parseKey(hostKey)
  if (parsed instanceof Error) throw parsed
  const digest = createHash("sha256")
    .update(parsed.getPublicSSH())
    .digest("base64")
    .replace(/=+$/u, "")
  return `SHA256:${digest}`
}

function generateSftpHostKey(): Buffer {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < HOST_KEY_GENERATION_ATTEMPTS; attempt += 1) {
    // ssh2 1.17 can serialize an Ed25519 public key as 31 bytes when its
    // first byte is zero, so validate each candidate before it reaches disk.
    const candidate = Buffer.from(utils.generateKeyPairSync("ed25519").private)
    lastError = hostKeyParseError(candidate)
    if (!lastError) return candidate
  }
  throw new Error(
    `Relay could not generate a valid SFTP host key after ${HOST_KEY_GENERATION_ATTEMPTS} attempts`,
    { cause: lastError }
  )
}

function loadOrCreateHostKey(config: RelayConfig): Promise<Buffer> {
  const directory = resolve(config.dataDirectory, "network", "sftp")
  const path = resolve(directory, "host.key")
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* sftpOperation(() =>
        mkdir(directory, { mode: 0o700, recursive: true })
      )
      const existing = yield* sftpOperation(() => readFile(path)).pipe(
        Effect.catch((cause) =>
          isMissing(cause) ? Effect.succeed(null) : Effect.fail(cause)
        )
      )
      if (existing) {
        const parseError = hostKeyParseError(existing)
        if (!parseError) return existing
        console.warn(
          `Relay SFTP host key at ${path} is invalid and will be replaced: ${parseError.message}`
        )
        return yield* replaceHostKeyEffect(path)
      }

      const generated = generateSftpHostKey()
      const created = yield* sftpOperation(() =>
        writeFile(path, generated, { flag: "wx", mode: 0o600 })
      ).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          errorCode(cause) === "EEXIST"
            ? Effect.succeed(false)
            : Effect.fail(cause)
        )
      )
      if (!created) {
        const concurrent = yield* sftpOperation(() => readFile(path))
        const parseError = hostKeyParseError(concurrent)
        if (!parseError) return concurrent
        console.warn(
          `Relay SFTP host key at ${path} is invalid and will be replaced: ${parseError.message}`
        )
        return yield* replaceHostKeyEffect(path)
      }
      yield* sftpOperation(() => chmod(path, 0o600))
      return generated
    })
  )
}

function replaceHostKeyEffect(path: string): Effect.Effect<Buffer, Error> {
  const generated = generateSftpHostKey()
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  return Effect.acquireUseRelease(
    Effect.succeed(temporaryPath),
    (temporary) =>
      Effect.gen(function* () {
        yield* sftpOperation(() =>
          writeFile(temporary, generated, { flag: "wx", mode: 0o600 })
        )
        yield* sftpOperation(() => rename(temporary, path))
        yield* sftpOperation(() => chmod(path, 0o600))
        return generated
      }),
    (temporary) =>
      sftpOperation(() => unlink(temporary)).pipe(
        Effect.catch(() => Effect.void)
      )
  )
}

function hostKeyParseError(hostKey: Buffer): Error | null {
  const parsed = utils.parseKey(hostKey)
  return parsed instanceof Error ? parsed : null
}

function authorizeUsername(
  control: Pick<ControlSocketServer, "requestClients">,
  username: string,
  clientActions: (clientId: string) => Promise<ReadonlyArray<string>>,
  credential?: string
): Promise<ReadonlyArray<SftpGrant>> {
  return Effect.runPromise(
    sftpOperation(() =>
      control.requestClients(
        "sftp.authorization.resolve",
        {
          username,
          ...(credential === undefined ? {} : { credential }),
        },
        5_000
      )
    ).pipe(
      Effect.flatMap((responses) =>
        Effect.forEach(
          responses,
          (response) => {
            const payload = record(response.payload)
            if (
              !payload ||
              typeof payload.username !== "string" ||
              payload.username.toLowerCase() !==
                username.trim().toLowerCase() ||
              !Array.isArray(payload.instances)
            ) {
              return Effect.succeed(null)
            }
            return sftpOperation(() => clientActions(response.clientId)).pipe(
              Effect.map((actions) => {
                const clientGrant = new Set(actions)
                if (!clientGrant.has("instance.sftp.connect")) return null
                const grants = new Map<string, Set<string>>()
                for (const item of payload.instances as Array<unknown>) {
                  const grant = record(item)
                  if (!grant || typeof grant.id !== "string" || !grant.id) {
                    continue
                  }
                  if (!Array.isArray(grant.actions)) continue
                  const allowed = grant.actions.filter(
                    (action): action is string =>
                      typeof action === "string" && clientGrant.has(action)
                  )
                  if (!allowed.includes("instance.files.list")) continue
                  const current = grants.get(grant.id) ?? new Set<string>()
                  for (const action of allowed) current.add(action)
                  grants.set(grant.id, current)
                }
                return [...grants].map(([id, grantActions]) => ({
                  actions: [...grantActions].sort(),
                  id,
                }))
              })
            )
          },
          { concurrency: 8 }
        )
      ),
      Effect.map((authorizations) => {
        const authorized = authorizations.flatMap((grants) =>
          grants === null ? [] : [grants]
        )
        return authorized.length === 1 ? (authorized[0] ?? []) : []
      })
    )
  )
}

function sameGrants(
  left: ReadonlyArray<SftpGrant>,
  right: ReadonlyArray<SftpGrant>
): boolean {
  if (left.length !== right.length) return false
  const expected = new Map(
    left.map((grant) => [grant.id, grant.actions.join("\0")])
  )
  return right.every(
    (grant) => expected.get(grant.id) === grant.actions.join("\0")
  )
}

function resolveGrants(
  options: { config: RelayConfig; docker: Pick<DockerDriver, "findInstance"> },
  grants: ReadonlyArray<SftpGrant>
): Promise<ReadonlyArray<ResolvedGrant>> {
  return Effect.runPromise(
    sftpOperation(() => realpath(options.config.rootDirectory)).pipe(
      Effect.flatMap((rootDirectory) =>
        Effect.forEach(
          grants,
          (grant) =>
            sftpOperation(() => options.docker.findInstance(grant.id)).pipe(
              Effect.flatMap((instance) =>
                instance
                  ? sftpOperation(() =>
                      realpath(resolve(rootDirectory, instance.directory))
                    ).pipe(
                      Effect.map((root) => {
                        ensureContained(rootDirectory, root)
                        return { ...grant, root }
                      })
                    )
                  : Effect.succeed(null)
              )
            ),
          { concurrency: 8 }
        )
      ),
      Effect.map((resolved) =>
        resolved
          .filter((grant): grant is ResolvedGrant => grant !== null)
          .sort((left, right) => left.id.localeCompare(right.id))
      )
    )
  )
}

function serveSftp(stream: SFTPWrapper, grants: ReadonlyArray<ResolvedGrant>) {
  const handles = new Map<number, OpenResource>()
  const operations = new Set<Fiber.Fiber<void, never>>()
  let nextHandle = 1

  stream.on("REALPATH", (requestId, requestedPath) => {
    void respond(requestId, async () => {
      const resolvedPath = normalizeVirtualPath(requestedPath)
      stream.name(requestId, [
        {
          attrs: virtualDirectoryAttributes(),
          filename: resolvedPath,
          longname: resolvedPath,
        },
      ])
    })
  })

  const statPath = (requestId: number, requestedPath: string) => {
    void respond(requestId, async () => {
      const target = await resolvePath(grants, requestedPath, true)
      if (target.grant) requireAction(target.grant, "instance.files.list")
      if (!target.physicalPath) {
        stream.attrs(requestId, virtualDirectoryAttributes())
        return
      }
      await withOpenFile(
        () =>
          open(
            target.physicalPath as string,
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
          ),
        async (file) => {
          await verifyOpenPath(target.grant?.root ?? "", file)
          stream.attrs(requestId, attributes(await file.stat()))
        }
      )
    })
  }
  stream.on("STAT", statPath)
  stream.on("LSTAT", statPath)

  stream.on("OPENDIR", (requestId, requestedPath) => {
    void respond(requestId, async () => {
      ensureHandleCapacity(handles)
      const target = await resolvePath(grants, requestedPath, true)
      if (target.grant) requireAction(target.grant, "instance.files.list")
      const entries = target.physicalPath
        ? await physicalDirectoryEntries(
            target.grant!.root,
            target.physicalPath
          )
        : target.grant
          ? await physicalDirectoryEntries(target.grant.root, target.grant.root)
          : grants.map((grant) => virtualDirectoryEntry(grant.id))
      const handle = nextHandle++
      handles.set(handle, { entries, index: 0, kind: "directory" })
      stream.handle(requestId, encodeHandle(handle))
    })
  })

  stream.on("READDIR", (requestId, encodedHandle) => {
    const resource = findHandle(handles, encodedHandle)
    if (!resource || resource.kind !== "directory") {
      stream.status(requestId, STATUS_CODE.FAILURE)
      return
    }
    if (resource.index >= resource.entries.length) {
      stream.status(requestId, STATUS_CODE.EOF)
      return
    }
    const batch = resource.entries.slice(
      resource.index,
      resource.index + DIRECTORY_BATCH_SIZE
    )
    resource.index += batch.length
    stream.name(requestId, batch)
  })

  stream.on("OPEN", (requestId, requestedPath, flags, inputAttributes) => {
    void respond(requestId, async () => {
      ensureHandleCapacity(handles)
      const writable = Boolean(flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND))
      const readable = Boolean(flags & OPEN_MODE.READ) || !writable
      const target = await resolvePath(
        grants,
        requestedPath,
        !(flags & OPEN_MODE.CREAT)
      )
      if (!target.grant || !target.physicalPath) throw missingPath()
      if (readable) requireAction(target.grant, "instance.files.read")
      if (flags & OPEN_MODE.CREAT)
        requireAction(target.grant, "instance.files.create")
      if (writable || flags & OPEN_MODE.TRUNC)
        requireAction(target.grant, "instance.files.write")
      const file = await withAnchoredParent(
        target.grant.root,
        target.physicalPath,
        (anchoredPath) =>
          open(
            anchoredPath,
            nodeOpenFlags(flags),
            sanitizeMode(inputAttributes.mode, 0o644)
          )
      )
      await verifyRetainedFile(target.grant.root, file)
      const handle = nextHandle++
      handles.set(handle, {
        actions: target.grant.actions,
        file,
        kind: "file",
        readable,
        writable,
      })
      stream.handle(requestId, encodeHandle(handle))
    })
  })

  stream.on("READ", (requestId, encodedHandle, offset, length) => {
    void respond(requestId, async () => {
      const resource = findHandle(handles, encodedHandle)
      if (!resource || resource.kind !== "file" || !resource.readable)
        throw new Error("Invalid handle")
      const buffer = Buffer.allocUnsafe(Math.min(length, 256 * 1024))
      const result = await resource.file.read(buffer, 0, buffer.length, offset)
      if (result.bytesRead === 0) {
        stream.status(requestId, STATUS_CODE.EOF)
        return
      }
      stream.data(requestId, buffer.subarray(0, result.bytesRead))
    })
  })

  stream.on("WRITE", (requestId, encodedHandle, offset, data) => {
    void respond(requestId, async () => {
      const resource = findHandle(handles, encodedHandle)
      if (!resource || resource.kind !== "file" || !resource.writable) {
        throw permissionDenied()
      }
      await writeFully(resource.file, data, offset)
      stream.status(requestId, STATUS_CODE.OK)
    })
  })

  stream.on("FSTAT", (requestId, encodedHandle) => {
    void respond(requestId, async () => {
      const resource = findHandle(handles, encodedHandle)
      if (!resource || resource.kind !== "file")
        throw new Error("Invalid handle")
      stream.attrs(requestId, attributes(await resource.file.stat()))
    })
  })

  stream.on("CLOSE", (requestId, encodedHandle) => {
    void respond(requestId, async () => {
      const id = decodeHandle(encodedHandle)
      const resource = id === null ? undefined : handles.get(id)
      if (!resource || id === null) throw new Error("Invalid handle")
      handles.delete(id)
      if (resource.kind === "file") await resource.file.close()
      stream.status(requestId, STATUS_CODE.OK)
    })
  })

  stream.on("REMOVE", (requestId, requestedPath) => {
    void mutate(
      requestId,
      requestedPath,
      "instance.files.delete",
      async (path) => unlink(path)
    )
  })
  stream.on("RMDIR", (requestId, requestedPath) => {
    void mutate(
      requestId,
      requestedPath,
      "instance.files.delete",
      async (path) => rmdir(path)
    )
  })
  stream.on("MKDIR", (requestId, requestedPath, inputAttributes) => {
    void mutate(
      requestId,
      requestedPath,
      "instance.files.create",
      async (path) =>
        mkdir(path, { mode: sanitizeMode(inputAttributes.mode, 0o755) }),
      false
    )
  })
  stream.on("RENAME", (requestId, oldPath, newPath) => {
    void respond(requestId, async () => {
      const source = await resolvePath(grants, oldPath, true)
      const destination = await resolvePath(grants, newPath, false)
      if (
        !source.grant ||
        !destination.grant ||
        source.grant.id !== destination.grant.id ||
        !source.physicalPath ||
        !destination.physicalPath
      )
        throw permissionDenied()
      requireAction(source.grant, "instance.files.rename")
      requireAction(destination.grant, "instance.files.rename")
      await withAnchoredParent(
        source.grant.root,
        source.physicalPath,
        (anchoredSource) =>
          withAnchoredParent(
            destination.grant!.root,
            destination.physicalPath!,
            (anchoredDestination) => rename(anchoredSource, anchoredDestination)
          )
      )
      stream.status(requestId, STATUS_CODE.OK)
    })
  })

  stream.on("SETSTAT", (requestId, requestedPath, inputAttributes) => {
    void respond(requestId, async () => {
      const target = await resolvePath(grants, requestedPath, true)
      if (
        !target.grant ||
        !target.physicalPath ||
        inputAttributes.mode === undefined
      )
        throw permissionDenied()
      requireAction(target.grant, "instance.files.chmod")
      await withOpenFile(
        () =>
          withAnchoredParent(
            target.grant!.root,
            target.physicalPath as string,
            (anchoredPath) =>
              open(anchoredPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
          ),
        async (file) => {
          await verifyOpenPath(target.grant!.root, file)
          await file.chmod(sanitizeMode(inputAttributes.mode, 0o644))
        }
      )
      stream.status(requestId, STATUS_CODE.OK)
    })
  })
  stream.on("FSETSTAT", (requestId, encodedHandle, inputAttributes) => {
    void respond(requestId, async () => {
      const resource = findHandle(handles, encodedHandle)
      if (
        !resource ||
        resource.kind !== "file" ||
        inputAttributes.mode === undefined
      )
        throw permissionDenied()
      if (!resource.actions.includes("instance.files.chmod"))
        throw permissionDenied()
      await resource.file.chmod(sanitizeMode(inputAttributes.mode, 0o644))
      stream.status(requestId, STATUS_CODE.OK)
    })
  })

  for (const operation of ["READLINK", "SYMLINK", "EXTENDED"] as const) {
    stream.on(operation, (requestId: number) => {
      stream.status(requestId, STATUS_CODE.OP_UNSUPPORTED)
    })
  }

  stream.once("close", () => {
    Effect.runFork(
      Effect.forEach(operations, (fiber) => Fiber.interrupt(fiber), {
        concurrency: 16,
        discard: true,
      }).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            operations.clear()
            const resources = [...handles.values()]
            handles.clear()
            return Effect.forEach(
              resources,
              (resource) =>
                resource.kind === "file"
                  ? sftpOperation(() => resource.file.close()).pipe(
                      Effect.ignore
                    )
                  : Effect.void,
              { concurrency: 16, discard: true }
            )
          })
        )
      )
    )
  })

  function mutate(
    requestId: number,
    requestedPath: string,
    action: string,
    operation: (path: string) => Promise<unknown>,
    mustExist = true
  ): void {
    respond(requestId, async () => {
      const target = await resolvePath(grants, requestedPath, mustExist)
      if (!target.grant || !target.physicalPath) {
        throw permissionDenied()
      }
      requireAction(target.grant, action)
      await withAnchoredParent(
        target.grant.root,
        target.physicalPath,
        operation
      )
      Sentry.addBreadcrumb({
        category: "relay.sftp.operation",
        data: { action },
        level: "info",
        message: "SFTP mutation completed",
      })
      stream.status(requestId, STATUS_CODE.OK)
    })
  }

  function respond(requestId: number, operation: () => Promise<void>): void {
    let operationFiber: Fiber.Fiber<void, never>
    operationFiber = Effect.runFork(
      sftpOperation(operation).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            const status = statusForError(cause)
            stream.status(requestId, status, safeErrorMessage(cause))
          })
        ),
        Effect.uninterruptible,
        Effect.ensuring(
          Effect.sync(() => {
            operations.delete(operationFiber)
          })
        )
      )
    )
    operations.add(operationFiber)
  }
}

function requireAction(grant: SftpGrant, action: string): void {
  if (!grant.actions.includes(action)) throw permissionDenied()
}

async function resolvePath(
  grants: ReadonlyArray<ResolvedGrant>,
  requestedPath: string,
  mustExist: boolean
): Promise<ResolvedPath> {
  const virtualPath = normalizeVirtualPath(requestedPath)
  const segments = virtualPath.split("/").filter(Boolean)
  if (segments.length === 0) {
    return { grant: null, physicalPath: null, virtualPath }
  }
  const grant = grants.find((item) => item.id === segments[0])
  if (!grant) throw missingPath()
  if (segments.length === 1) {
    return { grant, physicalPath: null, virtualPath }
  }
  const relativePath = segments.slice(1).join("/")
  const candidate = resolve(grant.root, relativePath)
  ensureContained(grant.root, candidate)
  if (mustExist) {
    const actual = await realpath(candidate)
    ensureContained(grant.root, actual)
    return { grant, physicalPath: actual, virtualPath }
  }
  const parent = await realpath(dirname(candidate))
  ensureContained(grant.root, parent)
  const physicalPath = resolve(parent, segments.at(-1) as string)
  ensureContained(grant.root, physicalPath)
  return { grant, physicalPath, virtualPath }
}

function normalizeVirtualPath(value: string): string {
  if (value.includes("\0") || value.includes("\\")) throw permissionDenied()
  return posix.resolve("/", value || ".")
}

function physicalDirectoryEntries(
  root: string,
  path: string
): Promise<Array<FileEntry>> {
  return Effect.runPromise(
    Effect.acquireUseRelease(
      sftpOperation(() =>
        open(
          path,
          fsConstants.O_RDONLY |
            fsConstants.O_DIRECTORY |
            fsConstants.O_NOFOLLOW
        )
      ),
      (directory) =>
        Effect.gen(function* () {
          const anchored = fdPath(directory)
          yield* sftpOperation(() => verifyOpenPath(root, directory))
          const entries = yield* sftpOperation(() =>
            readdir(anchored, { withFileTypes: true })
          )
          if (entries.length > MAX_DIRECTORY_ENTRIES) {
            return yield* Effect.fail(
              new Error("Directory contains too many entries")
            )
          }
          return yield* Effect.forEach(
            entries,
            (entry) =>
              sftpOperation(() => lstat(resolve(anchored, entry.name))).pipe(
                Effect.map((metadata) => ({
                  attrs: attributes(metadata),
                  filename: entry.name,
                  longname: longname(entry.name, metadata),
                }))
              ),
            { concurrency: 16 }
          )
        }),
      (directory) => sftpOperation(() => directory.close()).pipe(Effect.ignore)
    )
  )
}

function withAnchoredParent<T>(
  root: string,
  path: string,
  operation: (anchoredPath: string) => Promise<T>
): Promise<T> {
  return Effect.runPromise(
    Effect.acquireUseRelease(
      sftpOperation(() =>
        open(
          dirname(path),
          fsConstants.O_RDONLY |
            fsConstants.O_DIRECTORY |
            fsConstants.O_NOFOLLOW
        )
      ),
      (parent) =>
        Effect.gen(function* () {
          const anchoredParent = fdPath(parent)
          yield* sftpOperation(() => verifyOpenPath(root, parent))
          return yield* sftpOperation(() =>
            operation(resolve(anchoredParent, posix.basename(path)))
          )
        }),
      (parent) => sftpOperation(() => parent.close()).pipe(Effect.ignore)
    )
  )
}

function withOpenFile<T>(
  acquire: () => Promise<FileHandle>,
  use: (file: FileHandle) => Promise<T>
): Promise<T> {
  return Effect.runPromise(
    Effect.acquireUseRelease(
      sftpOperation(acquire),
      (file) => sftpOperation(() => use(file)),
      (file) => sftpOperation(() => file.close()).pipe(Effect.ignore)
    )
  )
}

function verifyRetainedFile(root: string, file: FileHandle): Promise<void> {
  return Effect.runPromise(
    sftpOperation(() => verifyOpenPath(root, file)).pipe(
      Effect.onError(() =>
        sftpOperation(() => file.close()).pipe(Effect.ignore)
      )
    )
  )
}

function fdPath(file: FileHandle): string {
  return `/proc/self/fd/${file.fd}`
}

function writeFully(
  file: FileHandle,
  data: Uint8Array,
  position: number
): Promise<void> {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const writeFrom = (written: number): Effect.Effect<void, Error> =>
    written >= buffer.length
      ? Effect.void
      : sftpOperation(() =>
          file.write(
            buffer,
            written,
            buffer.length - written,
            position + written
          )
        ).pipe(
          Effect.flatMap((result) =>
            result.bytesWritten <= 0
              ? Effect.fail(
                  new Error(
                    "Filesystem stopped before the SFTP block was complete"
                  )
                )
              : Effect.suspend(() => writeFrom(written + result.bytesWritten))
          )
        )
  return Effect.runPromise(writeFrom(0))
}

async function verifyOpenPath(root: string, file: FileHandle): Promise<void> {
  const actual = await realpath(fdPath(file))
  ensureContained(root, actual)
}

function virtualDirectoryEntry(name: string): FileEntry {
  return {
    attrs: virtualDirectoryAttributes(),
    filename: name,
    longname: `drwxr-xr-x 1 kiln kiln 0 Jan 01 00:00 ${name}`,
  }
}

function virtualDirectoryAttributes(): Attributes {
  const now = Math.floor(Date.now() / 1_000)
  return {
    atime: now,
    gid: 0,
    mode: DIRECTORY_MODE,
    mtime: now,
    size: 0,
    uid: 0,
  }
}

function attributes(metadata: Stats): Attributes {
  return {
    atime: Math.floor(metadata.atimeMs / 1_000),
    gid: metadata.gid,
    mode: metadata.mode,
    mtime: Math.floor(metadata.mtimeMs / 1_000),
    size: metadata.size,
    uid: metadata.uid,
  }
}

function longname(name: string, metadata: Stats): string {
  const type = metadata.isDirectory() ? "d" : "-"
  return `${type}${metadata.mode & 0o400 ? "r" : "-"}${metadata.mode & 0o200 ? "w" : "-"}${metadata.mode & 0o100 ? "x" : "-"}------ 1 kiln kiln ${metadata.size} Jan 01 00:00 ${name}`
}

function nodeOpenFlags(flags: number): number {
  const read = Boolean(flags & OPEN_MODE.READ)
  const write = Boolean(flags & OPEN_MODE.WRITE)
  let result =
    read && write
      ? fsConstants.O_RDWR
      : write
        ? fsConstants.O_WRONLY
        : fsConstants.O_RDONLY
  if (flags & OPEN_MODE.APPEND) result |= fsConstants.O_APPEND
  if (flags & OPEN_MODE.CREAT) result |= fsConstants.O_CREAT
  if (flags & OPEN_MODE.TRUNC) result |= fsConstants.O_TRUNC
  if (flags & OPEN_MODE.EXCL) result |= fsConstants.O_EXCL
  if (fsConstants.O_NOFOLLOW) result |= fsConstants.O_NOFOLLOW
  return result
}

function ensureHandleCapacity(handles: Map<number, OpenResource>) {
  if (handles.size >= MAX_OPEN_HANDLES) throw new Error("Too many open handles")
}

function encodeHandle(value: number): Buffer {
  const handle = Buffer.allocUnsafe(4)
  handle.writeUInt32BE(value)
  return handle
}

function decodeHandle(handle: Buffer): number | null {
  return handle.length === 4 ? handle.readUInt32BE(0) : null
}

function findHandle(
  handles: ReadonlyMap<number, OpenResource>,
  handle: Buffer
): OpenResource | undefined {
  const decoded = decodeHandle(handle)
  return decoded === null ? undefined : handles.get(decoded)
}

function statusForError(cause: unknown): number {
  if (isPermissionError(cause)) return STATUS_CODE.PERMISSION_DENIED
  if (isMissing(cause)) return STATUS_CODE.NO_SUCH_FILE
  return STATUS_CODE.FAILURE
}

function permissionDenied(): NodeJS.ErrnoException {
  return Object.assign(new Error("Permission denied"), { code: "EACCES" })
}

function missingPath(): NodeJS.ErrnoException {
  return Object.assign(new Error("No such file or directory"), {
    code: "ENOENT",
  })
}

function isPermissionError(cause: unknown): boolean {
  return errorCode(cause) === "EACCES" || errorCode(cause) === "EPERM"
}

function isMissing(cause: unknown): boolean {
  return errorCode(cause) === "ENOENT"
}

function errorCode(cause: unknown): string | null {
  return cause &&
    typeof cause === "object" &&
    "code" in cause &&
    typeof cause.code === "string"
    ? cause.code
    : null
}

function safeErrorMessage(cause: unknown): string {
  if (!cause || typeof cause !== "object" || !("message" in cause))
    return "SFTP operation failed"
  const message = cause.message
  return typeof message === "string" && message.length <= 160
    ? message
    : "SFTP operation failed"
}

function sanitizeMode(value: number | undefined, fallback: number): number {
  return typeof value === "number" ? value & 0o777 : fallback
}

function ensureContained(root: string, candidate: string): void {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  if (
    normalizedCandidate !== normalizedRoot &&
    !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  )
    throw permissionDenied()
}

function safeEqual(input: string, expected: string): boolean {
  const inputBuffer = Buffer.from(input)
  const expectedBuffer = Buffer.from(expected)
  const comparable = Buffer.alloc(expectedBuffer.length)
  inputBuffer.copy(comparable, 0, 0, expectedBuffer.length)
  const contentsMatch = timingSafeEqual(comparable, expectedBuffer)
  return inputBuffer.length === expectedBuffer.length && contentsMatch
}

function resolveSftpAuthentication(
  password: string,
  developmentAuthentication: boolean
): { credential: string | undefined } | null {
  if (developmentAuthentication && safeEqual(password, DEVELOPMENT_PASSWORD)) {
    return { credential: undefined }
  }
  return password.length === 0 ? null : { credential: password }
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null
}

function listenSftpServerEffect(
  server: InstanceType<typeof Server>,
  port: number,
  host: string
): Effect.Effect<void, Error> {
  return Effect.callback<void, Error>((resume) => {
    const failed = (cause: Error) => {
      resume(Effect.fail(cause))
    }
    server.once("error", failed)
    server.listen(port, host, () => {
      server.off("error", failed)
      resume(Effect.void)
    })
    return Effect.sync(() => {
      server.off("error", failed)
      server.close()
    })
  })
}

function closeSftpServerEffect(
  server: InstanceType<typeof Server>
): Effect.Effect<void, Error> {
  return Effect.callback<void, Error>((resume) => {
    server.close((cause) => {
      resume(cause ? Effect.fail(cause) : Effect.void)
    })
  })
}

function sftpOperation<TResult>(
  run: () => Promise<TResult>
): Effect.Effect<TResult, Error> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("SFTP operation failed"),
  })
}
