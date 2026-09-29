import { stat } from "node:fs/promises"
import { basename, posix } from "node:path"

import type { CliSftpResponse } from "@workspace/contracts"
import { Effect } from "effect"
import { Client } from "ssh2"
import type { SFTPWrapper } from "ssh2"

import type { KilnSession } from "./config.js"
import { commandError } from "./errors.js"

export const downloadSftpFileEffect = Effect.fn("cli.sftp.download")(
  function* (input: {
    connection: CliSftpResponse
    localPath: string
    remotePath: string
    session: KilnSession
  }) {
    const remotePath = resolveRemotePath(
      input.connection.root,
      input.remotePath
    )
    yield* withSftp(input.session, input.connection, (sftp) =>
      sftpOperation("download", (done) =>
        sftp.fastGet(remotePath, input.localPath, done)
      )
    )
    const details = yield* Effect.tryPromise({
      try: () => stat(input.localPath),
      catch: (cause) => sftpError("inspect download", cause),
    })
    return {
      bytes: details.size,
      localPath: input.localPath,
      remotePath: input.remotePath,
      transferred: true as const,
    }
  }
)

export const uploadSftpFileEffect = Effect.fn("cli.sftp.upload")(
  function* (input: {
    connection: CliSftpResponse
    localPath: string
    remotePath: string
    session: KilnSession
  }) {
    const details = yield* Effect.tryPromise({
      try: () => stat(input.localPath),
      catch: (cause) =>
        commandError({
          cause,
          code: "local_file_unavailable",
          exitCode: 2,
          message: `Could not read ${input.localPath}.`,
        }),
    })
    if (!details.isFile()) {
      return yield* commandError({
        code: "invalid_arguments",
        exitCode: 2,
        message: "SFTP upload currently accepts one regular file.",
      })
    }
    const remotePath = resolveRemotePath(
      input.connection.root,
      input.remotePath || basename(input.localPath)
    )
    yield* withSftp(input.session, input.connection, (sftp) =>
      sftpOperation("upload", (done) =>
        sftp.fastPut(input.localPath, remotePath, done)
      )
    )
    return {
      bytes: details.size,
      localPath: input.localPath,
      remotePath: input.remotePath || basename(input.localPath),
      transferred: true as const,
    }
  }
)

function withSftp<TResult>(
  session: KilnSession,
  connection: CliSftpResponse,
  use: (
    sftp: SFTPWrapper
  ) => Effect.Effect<TResult, ReturnType<typeof sftpError>>
) {
  return Effect.acquireUseRelease(
    Effect.interruptible(connectEffect(session, connection)),
    (client) =>
      openSftpEffect(client).pipe(
        Effect.flatMap((sftp) =>
          use(sftp).pipe(Effect.ensuring(Effect.sync(() => sftp.end())))
        )
      ),
    (client) => Effect.sync(() => client.end())
  )
}

function connectEffect(session: KilnSession, connection: CliSftpResponse) {
  return Effect.callback<Client, ReturnType<typeof sftpError>>((resume) => {
    const client = new Client()
    let settled = false
    const ready = () => {
      if (settled) return
      settled = true
      removePendingListeners()
      client.on("error", ignoreError)
      resume(Effect.succeed(client))
    }
    const fail = (cause: Error) => {
      if (settled) return
      settled = true
      removePendingListeners()
      client.on("error", ignoreError)
      client.destroy()
      resume(Effect.fail(sftpError("connect", cause)))
    }
    const ignoreError = () => undefined
    const removePendingListeners = () => {
      client.off("error", fail)
      client.off("ready", ready)
    }
    client.once("error", fail)
    client.once("ready", ready)
    client.connect({
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: session.token,
      hostHash: "sha256",
      hostVerifier: (hash: string) => hash === expectedHostHash(connection),
      keepaliveInterval: 10_000,
      readyTimeout: 15_000,
    })
    return Effect.sync(() => {
      if (settled) return
      settled = true
      removePendingListeners()
      client.on("error", ignoreError)
      client.destroy()
    })
  })
}

function openSftpEffect(client: Client) {
  return Effect.callback<SFTPWrapper, ReturnType<typeof sftpError>>(
    (resume) => {
      client.sftp((cause, sftp) =>
        cause
          ? resume(Effect.fail(sftpError("open session", cause)))
          : resume(Effect.succeed(sftp))
      )
    }
  )
}

function sftpOperation(
  operation: string,
  run: (done: (cause?: Error | null) => void) => void
) {
  return Effect.callback<void, ReturnType<typeof sftpError>>((resume) => {
    run((cause) =>
      cause
        ? resume(Effect.fail(sftpError(operation, cause)))
        : resume(Effect.void)
    )
  })
}

function resolveRemotePath(root: string, remotePath: string): string {
  const segments = remotePath.replace(/^\/+|\/+$/gu, "").split("/")
  if (
    !remotePath.trim() ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\0")
    )
  ) {
    throw commandError({
      code: "invalid_arguments",
      exitCode: 2,
      message: "Remote paths must stay within the server root.",
    })
  }
  return posix.join(root, ...segments)
}

function expectedHostHash(connection: CliSftpResponse): string {
  return Buffer.from(
    connection.hostKeyFingerprint.slice("SHA256:".length),
    "base64"
  ).toString("hex")
}

function sftpError(operation: string, cause: unknown) {
  return commandError({
    cause,
    code: "sftp_failed",
    message: `SFTP ${operation} failed.`,
    retryable: true,
  })
}
