#!/usr/bin/env bun

import { readFile } from "node:fs/promises"
import { arch, hostname, platform } from "node:os"
import { basename } from "node:path"
import { spawn } from "node:child_process"

import {
  backupIdSchema,
  cliActivityResponseSchema,
  cliBackupDownloadResponseSchema,
  cliBackupMutationResponseSchema,
  cliBackupTargetsResponseSchema,
  cliBackupsResponseSchema,
  cliDeleteBackupResponseSchema,
  cliDeleteServerResponseSchema,
  cliDeviceCodeResponseSchema,
  cliDeviceTokenResponseSchema,
  cliPowerActionSchema,
  cliPowerResponseSchema,
  cliRelayInfoResponseSchema,
  cliRelaysResponseSchema,
  cliRemoteFileUploadResponseSchema,
  cliRestoreBackupResponseSchema,
  cliServerReferenceSchema,
  cliServerInfoResponseSchema,
  cliServerMutationResponseSchema,
  cliServersResponseSchema,
  cliSftpResponseSchema,
  DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
  MAXIMUM_INSTANCE_NAME_LENGTH,
  formatRelayInstanceStateReason,
  relayIdSchema,
  relayFileContentSchema,
  relayFileTreeSchema,
  relayConsoleCommandResultSchema,
  relayConsoleSchema,
  relayConsoleStreamEventSchema,
} from "@workspace/contracts"
import { Effect, Result } from "effect"
import { z } from "zod"

import { parseArguments, type CliArguments } from "./args.js"
import {
  normalizeKilnUrl,
  removeSessionEffect,
  resolveSessionEffect,
  saveSessionEffect,
  type KilnSession,
} from "./config.js"
import { CliCommandError, commandError } from "./errors.js"
import { downloadBackupEffect } from "./downloads.js"
import {
  apiJsonEffect,
  apiResponseEffect,
  CLI_LONG_OPERATION_TIMEOUT_MS,
  publicJsonEffect,
} from "./http.js"
import type { CliRequestInit } from "./http.js"
import { prepareFollowLogOutput, withFollowLogReader } from "./logs.js"
import {
  parseDiskBytes,
  parseMemoryVariable,
  parseVariableAssignments,
  remoteFileBasename,
} from "./inputs.js"
import { formatBytes, writeLine, writeTable, writeText } from "./output.js"
import { formatPowerResponse } from "./power.js"
import { downloadSftpFileEffect, uploadSftpFileEffect } from "./sftp.js"
import { runCliProgram } from "./runtime.js"
import { updateCliEffect } from "./update.js"
import release from "../../../release.json" with { type: "json" }

const VERSION = process.env.KILN_VERSION?.trim() || release.releaseLine

const whoamiSchema = z.object({
  credential: z.object({
    id: z.uuid(),
    mode: z.enum(["full_access", "read_only"]),
  }),
  user: z.object({ email: z.email(), id: z.string(), name: z.string() }),
})

const program = Effect.try({
  try: () => parseArguments(process.argv.slice(2)),
  catch: (cause) =>
    cause instanceof CliCommandError
      ? cause
      : commandError({
          cause,
          code: "invalid_arguments",
          exitCode: 2,
          message: "The CLI arguments are invalid.",
        }),
}).pipe(
  Effect.flatMap((args) => runCommandEffect(args)),
  Effect.withSpan("kiln.cli")
)

const runCommandEffect = Effect.fn("cli.command")(function* (
  args: CliArguments
) {
  if (args.version) {
    writeLine(`kiln ${VERSION}`)
    return
  }
  if (args.help || args.command.length === 0 || args.command[0] === "help") {
    writeHelp()
    return
  }

  const [group, action, ...rest] = args.command
  if (group === "login") {
    yield* loginEffect(args, action)
    return
  }
  if (group === "logout") {
    yield* logoutEffect(args)
    return
  }
  if (group === "update") {
    if (action !== undefined) return yield* invalidUsage("Usage: kiln update")
    yield* updateCliEffect()
    writeLine("Kiln CLI updated to the latest version.")
    return
  }

  const session = yield* resolveSessionEffect(args)
  if (group === "whoami") {
    const result = yield* apiJsonEffect(
      session,
      "/api/cli/v1/whoami",
      whoamiSchema
    )
    writeLine(`Name: ${result.user.name}`)
    writeLine(`Email: ${result.user.email}`)
    writeLine(`Access: ${result.credential.mode.replace("_", " ")}`)
    writeLine(`Profile: ${session.profile}`)
    writeLine(`Hearth: ${session.url}`)
    return
  }
  if (group === "servers" && action === "list") {
    const result = yield* apiJsonEffect(
      session,
      "/api/cli/v1/servers",
      cliServersResponseSchema
    )
    if (result.servers.length === 0) {
      writeLine("No servers found.")
    } else {
      writeTable(
        ["NAME", "STATE", "RELAY", "ID"],
        result.servers.map((server) => [
          server.name,
          server.state,
          server.relayName,
          server.id,
        ])
      )
    }
    return
  }
  if (group === "relays" && action === "list") {
    const result = yield* apiJsonEffect(
      session,
      "/api/cli/v1/relays",
      cliRelaysResponseSchema
    )
    if (result.relays.length === 0) {
      writeLine("No Relays found.")
    } else {
      writeTable(
        ["NAME", "STATUS", "VERSION", "PLATFORM", "SERVERS", "ID"],
        result.relays.map((relay) => [
          relay.name,
          relay.status,
          relay.version ?? "-",
          [relay.platform, relay.arch].filter(Boolean).join("/") || "-",
          relay.serverCount === null ? "-" : String(relay.serverCount),
          relay.id,
        ])
      )
    }
    return
  }
  if (group === "relay" && action === "info") {
    const relayId = yield* parseRelayIdEffect(rest[0])
    const query = new URLSearchParams({ relayId })
    const result = yield* apiJsonEffect(
      session,
      `/api/cli/v1/relay/info?${query}`,
      cliRelayInfoResponseSchema
    )
    writeRelayInfo(result)
    return
  }
  if (group === "activity" && action === "list") {
    const query = new URLSearchParams({ limit: String(args.limit) })
    const result = yield* apiJsonEffect(
      session,
      `/api/cli/v1/activity?${query}`,
      cliActivityResponseSchema
    )
    if (result.entries.length === 0) {
      writeLine("No activity found.")
    } else {
      writeTable(
        ["TIME", "ACTOR", "ACTION", "SERVER", "RELAY", "SOURCE"],
        result.entries.map((entry) => [
          new Date(entry.occurredAt).toISOString(),
          entry.actor.email ?? entry.actor.name,
          entry.label,
          entry.server?.name ?? "-",
          entry.relay.name,
          entry.source,
        ])
      )
    }
    return
  }
  if (group === "backups" && action === "targets") {
    const result = yield* apiJsonEffect(
      session,
      "/api/cli/v1/backup-targets",
      cliBackupTargetsResponseSchema
    )
    if (result.targets.length === 0) {
      writeLine("No backup targets found.")
    } else {
      writeTable(
        ["TYPE", "NAME", "RELAY", "REFERENCE"],
        result.targets.map((target) => [
          target.kind,
          target.name,
          target.relayName,
          target.reference,
        ])
      )
    }
    return
  }
  if (group === "backups" && action === "list") {
    const query = new URLSearchParams({ limit: String(args.limit) })
    const result = yield* apiJsonEffect(
      session,
      `/api/cli/v1/backups?${query}`,
      cliBackupsResponseSchema
    )
    if (result.backups.length === 0) {
      writeLine("No backups found.")
    } else {
      writeTable(
        ["CREATED", "STATUS", "MODE", "NAME", "TARGET", "DEST", "SIZE", "ID"],
        result.backups.map((backup) => [
          backup.createdAt,
          cliBackupStatus(backup),
          backup.backupMode,
          backup.name,
          `${backup.targetKind}:${backup.targetId}`,
          backup.destinations.join("+"),
          backup.bytes === null ? "-" : formatBytes(backup.bytes),
          backup.id,
        ])
      )
    }
    return
  }
  if (group === "backups" && action === "create") {
    const targetKind = z
      .enum(["server", "database", "platform"])
      .safeParse(rest[0])
    if (!targetKind.success) {
      return yield* invalidUsage(
        "Usage: kiln backups create <server|database|platform> <reference> [--name <name>] [--mode full|incremental] [--storage <default|local|id>]"
      )
    }
    const storageId = yield* parseBackupStorageEffect(args.storage)
    if (args.mode && targetKind.data !== "server") {
      return yield* invalidUsage(
        "--mode is only valid when creating a server backup."
      )
    }
    const common = {
      name: args.name?.trim() || "CLI backup",
      ...(args.mode ? { mode: args.mode } : {}),
      ...(storageId === undefined ? {} : { storageId }),
    }
    const body =
      targetKind.data === "platform"
        ? {
            ...common,
            relayId: yield* parseRelayIdEffect(rest[1]),
            targetKind: "platform",
          }
        : targetKind.data === "server"
          ? yield* parseServerReferenceEffect(rest[1]).pipe(
              Effect.map((target) => ({
                ...common,
                relayId: target.relayId,
                targetId: target.instanceId,
                targetKind: "instance",
              }))
            )
          : {
              ...common,
              ...(yield* parseBackupTargetReferenceEffect(rest[1])),
              targetKind: "database",
            }
    const result = yield* apiJsonEffect(
      session,
      "/api/cli/v1/backups",
      cliBackupMutationResponseSchema,
      jsonRequest("POST", body, CLI_LONG_OPERATION_TIMEOUT_MS)
    )
    writeLine(
      result.relayAccepted
        ? `Queued backup ${result.backupId}.`
        : `Saved backup ${result.backupId}; Relay will resume it when connected.`
    )
    return
  }
  if (group === "backup" && action === "restore") {
    const backupId = yield* parseBackupIdEffect(rest[0])
    const result = yield* apiJsonEffect(
      session,
      "/api/cli/v1/backup/restore",
      cliRestoreBackupResponseSchema,
      jsonRequest(
        "POST",
        { backupId, safetyBackup: args.safetyBackup },
        CLI_LONG_OPERATION_TIMEOUT_MS
      )
    )
    writeLine(
      result.relayAccepted
        ? `Queued restore ${result.restoreTaskId}.`
        : `Saved restore ${result.restoreTaskId}; Relay will resume it when connected.`
    )
    if (result.safetyBackupId) {
      writeLine(`Safety backup: ${result.safetyBackupId}`)
    }
    return
  }
  if (group === "backup" && action === "delete") {
    const backupId = yield* parseBackupIdEffect(rest[0])
    if (!args.confirm) {
      return yield* invalidUsage(
        `Deletion permanently removes the stored artifact. Repeat the backup ID with --confirm ${backupId}.`
      )
    }
    if (args.confirm !== backupId) {
      return yield* invalidUsage(
        `Deletion confirmation must exactly match ${backupId}.`
      )
    }
    const result = yield* apiJsonEffect(
      session,
      "/api/cli/v1/backup",
      cliDeleteBackupResponseSchema,
      jsonRequest(
        "DELETE",
        { backupId, confirmation: args.confirm },
        CLI_LONG_OPERATION_TIMEOUT_MS
      )
    )
    writeLine(
      result.relayAccepted
        ? `Queued deletion of ${result.backupId}.`
        : `Saved deletion of ${result.backupId}; Relay will resume it when connected.`
    )
    return
  }
  if (group === "backup" && action === "download") {
    const backupId = yield* parseBackupIdEffect(rest[0])
    let poll = false
    let signed = yield* apiJsonEffect(
      session,
      "/api/cli/v1/backup/download",
      cliBackupDownloadResponseSchema,
      jsonRequest("POST", { backupId, poll })
    )
    while (signed.status === "preparing") {
      writeLine("Preparing snapshot export…")
      yield* Effect.sleep("1 second")
      poll = true
      signed = yield* apiJsonEffect(
        session,
        "/api/cli/v1/backup/download",
        cliBackupDownloadResponseSchema,
        jsonRequest("POST", { backupId, poll })
      )
    }
    const localPath = rest[1] || basename(signed.filename)
    const downloaded = yield* downloadBackupEffect({
      localPath,
      url: signed.url,
    })
    writeLine(
      `Downloaded ${downloaded.bytes} bytes to ${downloaded.localPath}.`
    )
    return
  }
  if (group === "servers" && action === "create") {
    const relayId = yield* parseRelayIdEffect(rest[0])
    const brick = args.brick ?? rest[1]
    if (!brick) {
      return yield* invalidUsage(
        "Usage: kiln servers create <relayId> <brick-id|https-url> --name <name> [options]"
      )
    }
    const name = yield* parseServerNameEffect(args.name)
    const startup = yield* startupOptionsEffect(args)
    const result = yield* apiJsonEffect(
      session,
      "/api/cli/v1/servers",
      cliServerMutationResponseSchema,
      jsonRequest(
        "POST",
        {
          brick,
          diskLimitBytes:
            startup.diskLimitBytes ?? DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
          name,
          relayId,
          start: args.start,
          variables: startup.variables,
        },
        CLI_LONG_OPERATION_TIMEOUT_MS
      )
    )
    writeLine(
      `Created ${result.server.name} (${result.relayId}:${result.server.id}).`
    )
    return
  }
  if (group === "server" && action === "info") {
    const target = yield* parseServerReferenceEffect(rest[0])
    const result = yield* apiJsonEffect(
      session,
      `/api/cli/v1/server/info?${targetQuery(target)}`,
      cliServerInfoResponseSchema
    )
    writeServerInfo(result)
    return
  }
  if (group === "server" && (action === "startup" || action === "brick")) {
    const target = yield* parseServerReferenceEffect(rest[0])
    const startup = yield* startupOptionsEffect(args)
    const brick = action === "brick" ? rest[1] : args.brick
    if (
      !brick &&
      startup.diskLimitBytes === undefined &&
      Object.keys(startup.variables).length === 0
    ) {
      return yield* invalidUsage(
        action === "brick"
          ? "Usage: kiln server brick <server> <brick-id|https-url> [options]"
          : "Provide --brick, --disk, --memory, --java-version, --game-version, or --variable."
      )
    }
    const result = yield* apiJsonEffect(
      session,
      "/api/cli/v1/server/startup",
      cliServerMutationResponseSchema,
      jsonRequest(
        "POST",
        {
          ...target,
          ...(brick ? { brick } : {}),
          ...(startup.diskLimitBytes === undefined
            ? {}
            : { diskLimitBytes: startup.diskLimitBytes }),
          start: args.start,
          variables: startup.variables,
        },
        CLI_LONG_OPERATION_TIMEOUT_MS
      )
    )
    writeLine(`Updated startup settings for ${result.server.name}.`)
    return
  }
  if (group === "server" && action === "delete") {
    const serverReference = rest[0]
    const target = yield* parseServerReferenceEffect(serverReference)
    if (!args.confirm) {
      return yield* invalidUsage(
        `Deletion permanently removes server data. Repeat the server reference with --confirm ${serverReference}.`
      )
    }
    if (args.confirm !== serverReference) {
      return yield* invalidUsage(
        `Deletion confirmation must exactly match ${serverReference}.`
      )
    }
    const result = yield* apiJsonEffect(
      session,
      "/api/cli/v1/server",
      cliDeleteServerResponseSchema,
      jsonRequest(
        "DELETE",
        { ...target, confirmation: args.confirm },
        CLI_LONG_OPERATION_TIMEOUT_MS
      )
    )
    writeLine(`Deleted ${result.relayId}:${result.instanceId}.`)
    return
  }
  if (group === "server" && action === "power") {
    const [serverReference, powerAction] = rest
    const target = yield* parseServerReferenceEffect(serverReference)
    const parsedAction = cliPowerActionSchema.safeParse(powerAction)
    if (!parsedAction.success) {
      return yield* invalidUsage(
        "Usage: kiln server power <relayId:instanceId> <start|stop|restart|kill>"
      )
    }
    const result = yield* apiJsonEffect(
      session,
      "/api/cli/v1/power",
      cliPowerResponseSchema,
      jsonRequest(
        "POST",
        { ...target, action: parsedAction.data },
        CLI_LONG_OPERATION_TIMEOUT_MS
      )
    )
    writeLine(formatPowerResponse(result))
    return
  }
  if (group === "server" && action === "console") {
    const [serverReference, ...commandParts] = rest
    const target = yield* parseServerReferenceEffect(serverReference)
    const command = commandParts.length
      ? commandParts.join(" ")
      : (yield* readStdinEffect()).trim()
    if (!command) return yield* invalidUsage("A console command is required.")
    yield* apiJsonEffect(
      session,
      "/api/cli/v1/console",
      relayConsoleCommandResultSchema,
      jsonRequest("POST", { ...target, command })
    )
    writeLine("Command sent.")
    return
  }
  if (group === "server" && action === "logs") {
    const target = yield* parseServerReferenceEffect(rest[0])
    yield* logsEffect(args, session, target)
    return
  }
  if (group === "files") {
    yield* filesEffect(session, action, rest)
    return
  }
  return yield* invalidUsage(`Unknown command: ${args.command.join(" ")}`)
})

const parseServerNameEffect = Effect.fn("cli.serverName.parse")(function* (
  value: string | undefined
) {
  const name = value?.trim() ?? ""
  if (!name) {
    return yield* invalidUsage("--name is required when creating a server.")
  }
  if (name.length > MAXIMUM_INSTANCE_NAME_LENGTH) {
    return yield* invalidUsage(
      `--name must be ${MAXIMUM_INSTANCE_NAME_LENGTH} characters or fewer.`
    )
  }
  return name
})

const loginEffect = Effect.fn("cli.login")(function* (
  args: CliArguments,
  positionalUrl?: string
) {
  const url = yield* Effect.try({
    try: () => normalizeKilnUrl(args.url || positionalUrl || "kiln.site"),
    catch: (cause) =>
      cause instanceof CliCommandError
        ? cause
        : commandError({
            cause,
            code: "invalid_url",
            exitCode: 2,
            message: "The Kiln URL is invalid.",
          }),
  })
  const profile = args.profile || "default"
  const name = args.name?.trim() || `${hostname()} (${platform()}/${arch()})`
  const device = yield* publicJsonEffect(
    url,
    "/api/cli/auth/device",
    cliDeviceCodeResponseSchema,
    jsonRequest("POST", { name })
  )
  writeLine("Complete sign-in in your browser.")
  writeLine(`URL: ${device.verificationUriComplete}`)
  writeLine(`Code: ${device.userCode}`)
  if (!args.noOpen && process.stdin.isTTY && process.stdout.isTTY) {
    yield* openBrowserEffect(device.verificationUriComplete).pipe(
      Effect.catch(() => Effect.void)
    )
  }
  const token = yield* pollForTokenEffect(url, device)
  const saved = yield* saveSessionEffect({
    profile,
    token: token.accessToken,
    url,
  })
  writeLine(`Logged in to ${url} with profile "${profile}".`)
  if (saved.protected) {
    writeLine(`Credential stored in ${saved.credentialManagerLabel}.`)
  } else if (saved.fallbackReason === "manager-failed") {
    writeLine(
      `Warning: ${saved.credentialManagerLabel} could not store the credential; it is stored in the owner-only Kiln config file.`
    )
  } else {
    writeLine(
      "Warning: No system credential manager is available; the credential is stored in the owner-only Kiln config file."
    )
  }
})

const pollForTokenEffect = Effect.fn("cli.login.poll")(function* (
  url: string,
  device: z.infer<typeof cliDeviceCodeResponseSchema>
) {
  let delaySeconds = device.interval
  for (;;) {
    yield* Effect.sleep(`${delaySeconds} seconds`)
    const attempt = yield* Effect.result(
      publicJsonEffect(
        url,
        "/api/cli/auth/token",
        cliDeviceTokenResponseSchema,
        jsonRequest("POST", { deviceCode: device.deviceCode })
      )
    )
    if (Result.isSuccess(attempt)) return attempt.success
    if (attempt.failure.code === "authorization_pending") continue
    if (attempt.failure.code === "slow_down") {
      delaySeconds = Math.min(delaySeconds + 2, 15)
      continue
    }
    return yield* attempt.failure
  }
})

const logoutEffect = Effect.fn("cli.logout")(function* (args: CliArguments) {
  const session = yield* resolveSessionEffect({
    ...args,
    migrateStoredCredential: false,
  }).pipe(Effect.option)
  if (session._tag === "Some") {
    yield* apiJsonEffect(
      session.value,
      "/api/cli/v1/credential",
      z.object({ revoked: z.literal(true) }),
      { method: "DELETE" }
    ).pipe(Effect.catch(() => Effect.void))
  }
  const result = yield* removeSessionEffect(args.profile)
  writeLine(
    result.removed
      ? `Logged out of profile "${result.profile}".`
      : `Profile "${result.profile}" was not logged in.`
  )
  if (result.removed && !result.credentialRemoved) {
    writeLine(
      "Warning: The profile was removed, but its system credential could not be deleted."
    )
  }
})

const logsEffect = Effect.fn("cli.logs")(function* (
  args: CliArguments,
  session: KilnSession,
  target: { instanceId: string; relayId: string }
) {
  const query = targetQuery(target)
  query.set("limit", String(args.limit))
  if (!args.follow) {
    const result = yield* apiJsonEffect(
      session,
      `/api/cli/v1/logs?${query}`,
      relayConsoleSchema
    )
    for (const line of result.lines) writeLine(line.text)
    return
  }
  query.set("follow", "true")
  return yield* apiResponseEffect(
    session,
    `/api/cli/v1/logs?${query}`,
    { headers: { Accept: "application/x-ndjson" }, timeoutMs: null },
    (response) => {
      if (!response.body) {
        return commandError({
          code: "invalid_response",
          message: "Hearth did not return a log stream.",
        })
      }
      return withFollowLogReader(response.body, (reader) =>
        Effect.gen(function* () {
          const historyQuery = targetQuery(target)
          historyQuery.set("limit", String(args.limit))
          const history = yield* apiJsonEffect(
            session,
            `/api/cli/v1/logs?${historyQuery}`,
            relayConsoleSchema
          )
          const output = prepareFollowLogOutput(history.lines, args.limit)
          for (const line of output.initialLines) writeLine(line.text)

          const decoder = new TextDecoder()
          let buffered = ""
          for (;;) {
            const chunk = yield* Effect.tryPromise({
              try: () => reader.read(),
              catch: (cause) =>
                commandError({
                  cause,
                  code: "stream_interrupted",
                  message: "The server log stream was interrupted.",
                  retryable: true,
                }),
            })
            buffered += decoder.decode(chunk.value, { stream: !chunk.done })
            const records = buffered.split("\n")
            buffered = records.pop() ?? ""
            for (const record of records) {
              if (!record) continue
              const event = yield* parseConsoleEventEffect(record)
              const line = output.liveLine(event)
              if (line) writeLine(line.text)
            }
            if (chunk.done) break
          }
        })
      )
    }
  )
})

const filesEffect = Effect.fn("cli.files")(function* (
  session: KilnSession,
  action: string | undefined,
  rest: Array<string>
) {
  const target = yield* parseServerReferenceEffect(rest[0])
  if (action === "list") {
    const query = targetQuery(target)
    query.set("path", rest[1] || ".")
    const result = yield* apiJsonEffect(
      session,
      `/api/cli/v1/files/tree?${query}`,
      relayFileTreeSchema
    )
    if (result.paths.length === 0) {
      writeLine("No files found.")
    } else {
      writeTable(
        ["PATH", "SIZE"],
        result.paths.map((path) => [
          path,
          result.sizes[path] === undefined
            ? "-"
            : formatBytes(result.sizes[path]),
        ])
      )
      if (result.truncated) {
        writeLine()
        writeLine(`Showing ${result.paths.length} of ${result.total} entries.`)
      }
    }
    return
  }
  if (action === "read") {
    const path = yield* requiredPathEffect(rest[1])
    const query = targetQuery(target)
    query.set("path", path)
    const result = yield* apiJsonEffect(
      session,
      `/api/cli/v1/files/content?${query}`,
      relayFileContentSchema
    )
    writeText(result.content)
    return
  }
  if (action === "write") {
    const path = yield* requiredPathEffect(rest[1])
    const source = rest[2] || "-"
    const content =
      source === "-"
        ? yield* readStdinEffect()
        : yield* Effect.tryPromise({
            try: () => readFile(source, "utf8"),
            catch: (cause) =>
              commandError({
                cause,
                code: "local_file_unavailable",
                exitCode: 2,
                message: `Could not read ${source}.`,
              }),
          })
    const result = yield* apiJsonEffect(
      session,
      "/api/cli/v1/files/content",
      relayFileContentSchema,
      jsonRequest(
        "PUT",
        { ...target, content, path },
        CLI_LONG_OPERATION_TIMEOUT_MS
      )
    )
    writeLine(`Wrote ${result.path} (${formatBytes(result.decodedSize)}).`)
    return
  }
  if (action === "download" || action === "upload") {
    if (action === "download") {
      const connection = yield* sftpConnectionEffect(session, target)
      const remotePath = yield* requiredPathEffect(rest[1])
      const result = yield* downloadSftpFileEffect({
        connection,
        localPath: rest[2] || basename(remotePath),
        remotePath,
        session,
      })
      writeLine(
        `Downloaded ${result.remotePath} to ${result.localPath} (${formatBytes(result.bytes)}).`
      )
      return
    }
    const localPath = rest[1]
    if (!localPath)
      return yield* invalidUsage("A local upload path is required.")
    if (/^https?:\/\//iu.test(localPath)) {
      if (!/^https:\/\//iu.test(localPath)) {
        return yield* invalidUsage("Remote file uploads require an HTTPS URL.")
      }
      const remotePath = rest[2] || remoteFileBasename(localPath)
      if (!remotePath) {
        return yield* invalidUsage(
          "A remote destination is required when the URL has no filename."
        )
      }
      const result = yield* apiJsonEffect(
        session,
        "/api/cli/v1/files/upload-url",
        cliRemoteFileUploadResponseSchema,
        jsonRequest(
          "POST",
          { ...target, path: remotePath, url: localPath },
          CLI_LONG_OPERATION_TIMEOUT_MS
        )
      )
      writeLine(
        `Downloaded URL to ${result.path} on the Relay (${formatBytes(result.size)}).`
      )
      return
    }
    const connection = yield* sftpConnectionEffect(session, target)
    const result = yield* uploadSftpFileEffect({
      connection,
      localPath,
      remotePath: rest[2] || basename(localPath),
      session,
    })
    writeLine(
      `Uploaded ${result.localPath} to ${result.remotePath} (${formatBytes(result.bytes)}).`
    )
    return
  }
  return yield* invalidUsage(
    "Usage: kiln files <list|read|write|download|upload> <server> ..."
  )
})

function sftpConnectionEffect(
  session: KilnSession,
  target: { instanceId: string; relayId: string }
) {
  return apiJsonEffect(
    session,
    `/api/cli/v1/sftp?${targetQuery(target)}`,
    cliSftpResponseSchema
  )
}

const parseRelayIdEffect = Effect.fn("cli.relayId.parse")(function* (
  value: string | undefined
) {
  const parsed = relayIdSchema.safeParse(value)
  if (!parsed.success) {
    return yield* commandError({
      code: "invalid_arguments",
      exitCode: 2,
      message:
        "A full Relay ID is required. Run `kiln relays list` to discover it.",
    })
  }
  return parsed.data
})

const startupOptionsEffect = Effect.fn("cli.startup.options")(function* (
  args: CliArguments
) {
  return yield* Effect.try({
    try: () => {
      const variables = parseVariableAssignments(args.variables)
      const memory = parseMemoryVariable(args.memory)
      if (memory) variables.memory = memory
      if (args.javaVersion) variables.java_version = args.javaVersion
      if (args.gameVersion) variables.version = args.gameVersion
      return {
        diskLimitBytes: parseDiskBytes(args.disk),
        variables,
      }
    },
    catch: (cause) =>
      cause instanceof CliCommandError
        ? cause
        : commandError({
            cause,
            code: "invalid_arguments",
            exitCode: 2,
            message: "The startup options are invalid.",
          }),
  })
})

function writeRelayInfo(
  result: z.infer<typeof cliRelayInfoResponseSchema>
): void {
  writeLine(`Name: ${result.relay.name}`)
  writeLine(`ID: ${result.relay.id}`)
  writeLine(`Status: ${result.relay.status}`)
  writeLine(`Version: ${result.relay.version ?? "unknown"}`)
  writeLine(
    `Platform: ${[result.relay.platform, result.relay.arch].filter(Boolean).join("/") || "unknown"}`
  )
  writeLine(
    `Can provision servers: ${result.relay.canProvisionServers === null ? "unknown" : result.relay.canProvisionServers ? "yes" : "no"}`
  )
  writeLine(
    `Servers: ${result.relay.serverCount === null ? "unknown" : result.relay.serverCount}`
  )
  if (!result.node) return
  writeLine(`Node: ${result.node.name} (${result.node.id})`)
  writeLine(
    `CPU: ${result.node.cpuCores} cores, ${result.node.cpuLoadPercent.toFixed(1)}% load`
  )
  writeLine(
    `Memory: ${formatBytes(result.node.memory.usedBytes)} / ${formatBytes(result.node.memory.totalBytes)}`
  )
  writeLine(
    `Storage: ${formatBytes(result.node.storage.usedBytes)} / ${formatBytes(result.node.storage.totalBytes)}`
  )
}

function writeServerInfo(
  result: z.infer<typeof cliServerInfoResponseSchema>
): void {
  const server = result.server
  writeLine(`Name: ${server.name}`)
  writeLine(`ID: ${result.relay.id}:${server.id}`)
  writeLine(`Relay: ${result.relay.name}`)
  writeLine(`State: ${server.observedState} (desired ${server.desiredState})`)
  if (server.stateReason) {
    writeLine(`Reason: ${formatRelayInstanceStateReason(server.stateReason)}`)
  }
  writeLine(`Game: ${server.game}`)
  writeLine(`Implementation: ${server.implementation} ${server.version}`)
  writeLine(`Java: ${server.javaVersion}`)
  writeLine(`Brick: ${server.brickId ?? server.brickSource ?? "unknown"}`)
  writeLine(`Connect: ${server.connectAddress}`)
  if (server.publicAddress) writeLine(`Public: ${server.publicAddress}`)
  writeLine(`Memory limit: ${formatBytes(server.memoryLimitBytes)}`)
  writeLine(`Disk limit: ${formatBytes(server.diskLimitBytes)}`)
  if (server.resources) {
    writeLine(`CPU usage: ${server.resources.cpuPercent.toFixed(1)}%`)
    writeLine(`Memory usage: ${formatBytes(server.resources.memoryUsedBytes)}`)
    if (server.resources.storageUsedBytes !== null) {
      writeLine(`Disk usage: ${formatBytes(server.resources.storageUsedBytes)}`)
    }
  }
}

const parseServerReferenceEffect = Effect.fn("cli.serverReference.parse")(
  function* (value: string | undefined) {
    const parsed = cliServerReferenceSchema.safeParse(value)
    if (!parsed.success) {
      return yield* commandError({
        code: "invalid_arguments",
        exitCode: 2,
        message:
          "Server references use relayId:instanceId. Run `kiln servers list` to discover them.",
      })
    }
    const separator = parsed.data.indexOf(":")
    return {
      instanceId: parsed.data.slice(separator + 1),
      relayId: parsed.data.slice(0, separator),
    }
  }
)

const parseBackupTargetReferenceEffect = Effect.fn(
  "cli.backupTargetReference.parse"
)(function* (value: string | undefined) {
  const separator = value?.indexOf(":") ?? -1
  const targetId = separator > 0 ? value?.slice(separator + 1) : undefined
  const parsedTarget = z.string().min(1).max(120).safeParse(targetId)
  if (!value || separator < 1 || !parsedTarget.success) {
    return yield* commandError({
      code: "invalid_arguments",
      exitCode: 2,
      message: "Backup target references use relayId:targetId.",
    })
  }
  const relayId = yield* parseRelayIdEffect(value.slice(0, separator))
  return { relayId, targetId: parsedTarget.data }
})

const parseBackupIdEffect = Effect.fn("cli.backupId.parse")(function* (
  value: string | undefined
) {
  const parsed = backupIdSchema.safeParse(value)
  if (!parsed.success) {
    return yield* commandError({
      code: "invalid_arguments",
      exitCode: 2,
      message: "A complete backup UUID is required. Run `kiln backups list`.",
    })
  }
  return parsed.data
})

const parseBackupStorageEffect = Effect.fn("cli.backupStorage.parse")(
  function* (value: string | undefined) {
    if (!value || value === "default") return undefined
    if (value === "local") return null
    const parsed = z.uuid().safeParse(value)
    if (!parsed.success) {
      return yield* commandError({
        code: "invalid_arguments",
        exitCode: 2,
        message: "--storage must be default, local, or a destination UUID.",
      })
    }
    return parsed.data
  }
)

function cliBackupStatus(
  backup: z.infer<typeof cliBackupsResponseSchema>["backups"][number]
): string {
  if (
    backup.status === "available" &&
    (backup.taskStatus === "queued" || backup.taskStatus === "running")
  ) {
    return "restoring"
  }
  return backup.status
}

const requiredPathEffect = Effect.fn("cli.path.required")(function* (
  value: string | undefined
) {
  if (value) return value
  return yield* commandError({
    code: "invalid_arguments",
    exitCode: 2,
    message: "A remote file path is required.",
  })
})

function targetQuery(target: { instanceId: string; relayId: string }) {
  return new URLSearchParams(target)
}

function jsonRequest(
  method: string,
  body: unknown,
  timeoutMs?: number
): CliRequestInit {
  return { body: JSON.stringify(body), method, timeoutMs }
}

const readStdinEffect = Effect.fn("cli.stdin.read")(function* () {
  return yield* Effect.tryPromise({
    try: async () => {
      const chunks: Array<Buffer> = []
      let size = 0
      for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.byteLength
        if (size > 16 * 1024 * 1024) {
          throw new Error("input_too_large")
        }
        chunks.push(buffer)
      }
      return Buffer.concat(chunks).toString("utf8")
    },
    catch: (cause) =>
      commandError({
        cause,
        code:
          cause instanceof Error && cause.message === "input_too_large"
            ? "input_too_large"
            : "stdin_failed",
        exitCode: 2,
        message:
          cause instanceof Error && cause.message === "input_too_large"
            ? "Standard input exceeds the 16 MiB CLI limit."
            : "Could not read standard input.",
      }),
  })
})

const parseConsoleEventEffect = Effect.fn("cli.logs.parseEvent")(function* (
  record: string
) {
  const event = yield* Effect.try({
    try: () => relayConsoleStreamEventSchema.parse(JSON.parse(record)),
    catch: (cause) =>
      commandError({
        cause,
        code: "invalid_response",
        message: "Hearth returned an invalid log stream event.",
      }),
  })
  return event
})

function openBrowserEffect(url: string) {
  return Effect.try({
    try: () => {
      const command =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "cmd"
            : "xdg-open"
      const parameters =
        process.platform === "win32" ? ["/c", "start", "", url] : [url]
      const child = spawn(command, parameters, {
        detached: true,
        stdio: "ignore",
      })
      child.unref()
    },
    catch: (cause) =>
      commandError({
        cause,
        code: "browser_open_failed",
        message: "Could not open the browser automatically.",
      }),
  })
}

function invalidUsage(message: string) {
  return commandError({
    code: "invalid_arguments",
    exitCode: 2,
    message,
  })
}

function writeHelp(): void {
  writeText(`Kiln CLI ${VERSION}

Manage Kiln and self-hosted Hearth servers.

Usage:
  kiln <command> [options]

Commands:
  login [url]                              Sign in to Kiln or Hearth
  logout                                  Sign out of the active profile
  update                                  Update only the Kiln CLI
  whoami                                  Show the current account
  relays list                             List accessible Relays
  relay info <relay-id>                   Show Relay metadata and capacity
  activity list                           Show accessible recent activity
  backups targets                         List resources that can be backed up
  backups list                            List accessible backups
  backups create <type> <reference>       Create a manual backup
                                          (server default: incremental)
  backup restore <backup-id>              Restore a server or database backup
  backup download <backup-id> [local]     Download a backup
  backup delete <backup-id> --confirm <backup-id>
                                          Permanently delete a backup
  servers list                            List available servers
  servers create <relay> <brick>          Create a server
  server info <server>                    Show server metadata and resources
  server startup <server> [options]       Change startup settings
  server brick <server> <brick>           Change a server's Brick
  server delete <server> --confirm <server>
                                          Permanently delete a server
  server power <server> <action>          Start, stop, restart, or kill a server
  server logs <server>                    Show server logs
  server console <server> [command]       Send a console command
  files list <server> [path]              List files
  files read <server> <remote>            Print a file
  files write <server> <remote> [local|-] Write a file
  files download <server> <remote> [local] Download a file
  files upload <server> <local|url> [remote]
                                          Upload locally or download HTTPS on Relay

Options:
      --brick <id|url> Change the Brick recipe
      --confirm <id>   Confirm a destructive server or backup deletion
      --disk <size>    Set disk quota (minimum 0.1GiB), for example 25GiB
  -f, --follow        Follow server logs
      --game-version <version>
                       Set the Brick's version variable
  -h, --help          Show help
      --java-version <version>
                       Set the Brick's java_version variable
      --limit <n>     Limit log, activity, or backup history (1-10000)
      --memory <size> Set the Brick's memory variable, for example 4GiB
      --mode <full|incremental>
                       Server backup mode (default incremental)
      --name <name>   Name this CLI credential, server, or backup
      --no-open       Do not open a browser during login
      --no-safety-backup
                       Restore without taking a full backup first
      --no-start      Leave a created or reconfigured server stopped
      --profile <id>  Use a named profile
      --storage <default|local|id>
                       Select a backup destination
      --token <token> Use a token without saving it
      --url <url>     Use a specific Kiln or Hearth URL
      --variable <name=value>
                       Set a Brick variable; prefix value with json: for numbers or booleans
  -v, --version       Show the CLI version

Environment:
  KILN_URL, KILN_TOKEN, KILN_CONFIG
`)
}

runCliProgram(program)
