import { createFileRoute } from "@tanstack/react-router"
import {
  cliBackupDownloadRequestSchema,
  cliConsoleRequestSchema,
  cliCreateBackupRequestSchema,
  cliCreateServerRequestSchema,
  cliDeleteBackupRequestSchema,
  cliDeleteServerRequestSchema,
  cliFileWriteRequestSchema,
  cliPowerRequestSchema,
  cliRemoteFileUploadRequestSchema,
  cliTargetSchema,
  cliRestoreBackupRequestSchema,
  cliUpdateServerStartupRequestSchema,
  relayIdSchema,
  relayConsoleStreamEventSchema,
} from "@workspace/contracts"
import { Effect } from "effect"

import {
  authenticateCliTokenEffect,
  bearerToken,
  revokeCliCredentialEffect,
  type CliPrincipal,
} from "@/effect/cli-access"
import {
  authorizeCliConsoleStreamEffect,
  createCliBackupEffect,
  createCliServerEffect,
  deleteCliBackupEffect,
  deleteCliServerEffect,
  getCliConsoleHistoryEffect,
  getCliBackupDownloadEffect,
  getCliFileTreeEffect,
  getCliRelayInfoEffect,
  getCliServerInfoEffect,
  getCliSftpConnectionEffect,
  listCliActivityEffect,
  listCliBackupsEffect,
  listCliBackupTargetsEffect,
  listCliRelaysEffect,
  listCliServersEffect,
  performCliPowerActionEffect,
  readCliFileEffect,
  restoreCliBackupEffect,
  sendCliConsoleCommandEffect,
  updateCliServerStartupEffect,
  uploadCliFileFromUrlEffect,
  writeCliFileEffect,
} from "@/effect/cli-api"
import { CliAccessError } from "@/effect/errors"
import { runAppEffect } from "@/effect/runtime"
import type { AppCache } from "@/effect/cache"
import type { Database } from "@/effect/database"
import {
  cliFailureResponse,
  cliInvalidRequest,
  cliJsonResponse,
} from "@/lib/cli-http"
import { openHearthRelayConsoleStream } from "@/server/relay-console-proxy"

const encoder = new TextEncoder()

export const Route = createFileRoute("/api/cli/v1/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const principal = await authenticateRequest(request)
        if (principal instanceof Response) return principal
        const endpoint = endpointName(request.url)

        if (endpoint === "whoami") {
          return cliJsonResponse({
            credential: {
              id: principal.credentialId,
              mode: principal.mode,
            },
            user: {
              email: principal.user.email,
              id: principal.user.id,
              name: principal.user.name,
            },
          })
        }
        if (endpoint === "servers") {
          return runCliEffect(
            "cli.http.servers",
            listCliServersEffect(principal)
          )
        }
        if (endpoint === "relays") {
          return runCliEffect("cli.http.relays", listCliRelaysEffect(principal))
        }

        const url = new URL(request.url)
        if (endpoint === "activity") {
          return runCliEffect(
            "cli.http.activity",
            listCliActivityEffect(
              principal,
              boundedLimit(url.searchParams.get("limit"))
            )
          )
        }
        if (endpoint === "backups") {
          return runCliEffect(
            "cli.http.backups",
            listCliBackupsEffect(
              principal,
              boundedLimit(url.searchParams.get("limit"))
            )
          )
        }
        if (endpoint === "backup-targets") {
          return runCliEffect(
            "cli.http.backups.targets",
            listCliBackupTargetsEffect(principal)
          )
        }
        if (endpoint === "relay/info") {
          const relayId = relayIdSchema.safeParse(
            url.searchParams.get("relayId")
          )
          if (!relayId.success)
            return invalidRequest("A valid relayId is required.")
          return runCliEffect(
            "cli.http.relay.info",
            getCliRelayInfoEffect(principal, relayId.data)
          )
        }

        const target = targetFromSearch(url)
        if (target instanceof Response) return target
        if (endpoint === "server/info") {
          return runCliEffect(
            "cli.http.server.info",
            getCliServerInfoEffect(principal, target)
          )
        }
        if (endpoint === "logs") {
          const limit = boundedLimit(url.searchParams.get("limit"))
          if (url.searchParams.get("follow") === "true") {
            return streamConsole(request, principal, { ...target, limit })
          }
          return runCliEffect(
            "cli.http.logs",
            getCliConsoleHistoryEffect(principal, { ...target, limit })
          )
        }
        if (endpoint === "files/tree") {
          return runCliEffect(
            "cli.http.files.list",
            getCliFileTreeEffect(principal, {
              ...target,
              path: url.searchParams.get("path") || ".",
            })
          )
        }
        if (endpoint === "files/content") {
          return runCliEffect(
            "cli.http.files.read",
            readCliFileEffect(principal, {
              ...target,
              path: url.searchParams.get("path"),
            })
          )
        }
        if (endpoint === "sftp") {
          return runCliEffect(
            "cli.http.sftp",
            getCliSftpConnectionEffect(principal, target)
          )
        }
        return notFound()
      },
      POST: async ({ request }) => {
        const principal = await authenticateRequest(request)
        if (principal instanceof Response) return principal
        const endpoint = endpointName(request.url)
        const body = await requestBody(request)
        if (body instanceof Response) return body

        if (endpoint === "power") {
          return runCliEffect(
            "cli.http.power",
            decodeBody(cliPowerRequestSchema, body.value).pipe(
              Effect.flatMap((input) =>
                performCliPowerActionEffect(principal, input)
              )
            )
          )
        }
        if (endpoint === "console") {
          return runCliEffect(
            "cli.http.console",
            decodeBody(cliConsoleRequestSchema, body.value).pipe(
              Effect.flatMap((input) =>
                sendCliConsoleCommandEffect(principal, input)
              )
            )
          )
        }
        if (endpoint === "servers") {
          return runCliEffect(
            "cli.http.servers.create",
            decodeBody(cliCreateServerRequestSchema, body.value).pipe(
              Effect.flatMap((input) => createCliServerEffect(principal, input))
            )
          )
        }
        if (endpoint === "backups") {
          return runCliEffect(
            "cli.http.backups.create",
            decodeBody(cliCreateBackupRequestSchema, body.value).pipe(
              Effect.flatMap((input) => createCliBackupEffect(principal, input))
            )
          )
        }
        if (endpoint === "backup/restore") {
          return runCliEffect(
            "cli.http.backups.restore",
            decodeBody(cliRestoreBackupRequestSchema, body.value).pipe(
              Effect.flatMap((input) =>
                restoreCliBackupEffect(principal, input)
              )
            )
          )
        }
        if (endpoint === "backup/download") {
          return runCliEffect(
            "cli.http.backups.download",
            decodeBody(cliBackupDownloadRequestSchema, body.value).pipe(
              Effect.flatMap((input) =>
                getCliBackupDownloadEffect(principal, input)
              )
            )
          )
        }
        if (endpoint === "server/startup") {
          return runCliEffect(
            "cli.http.server.startup",
            decodeBody(cliUpdateServerStartupRequestSchema, body.value).pipe(
              Effect.flatMap((input) =>
                updateCliServerStartupEffect(principal, input)
              )
            )
          )
        }
        if (endpoint === "files/upload-url") {
          return runCliEffect(
            "cli.http.files.uploadUrl",
            decodeBody(cliRemoteFileUploadRequestSchema, body.value).pipe(
              Effect.flatMap((input) =>
                uploadCliFileFromUrlEffect(principal, input)
              )
            )
          )
        }
        return notFound()
      },
      PUT: async ({ request }) => {
        const principal = await authenticateRequest(request)
        if (principal instanceof Response) return principal
        if (endpointName(request.url) !== "files/content") return notFound()
        const body = await requestBody(request)
        if (body instanceof Response) return body
        return runCliEffect(
          "cli.http.files.write",
          decodeBody(cliFileWriteRequestSchema, body.value).pipe(
            Effect.flatMap((input) => writeCliFileEffect(principal, input))
          )
        )
      },
      DELETE: async ({ request }) => {
        const principal = await authenticateRequest(request)
        if (principal instanceof Response) return principal
        const endpoint = endpointName(request.url)
        if (endpoint === "credential") {
          return runCliEffect(
            "cli.http.credential.revoke",
            revokeCliCredentialEffect({
              credentialId: principal.credentialId,
              user: principal.user,
            })
          )
        }
        if (endpoint === "server") {
          const body = await requestBody(request)
          if (body instanceof Response) return body
          return runCliEffect(
            "cli.http.server.delete",
            decodeBody(cliDeleteServerRequestSchema, body.value).pipe(
              Effect.flatMap((input) => deleteCliServerEffect(principal, input))
            )
          )
        }
        if (endpoint === "backup") {
          const body = await requestBody(request)
          if (body instanceof Response) return body
          return runCliEffect(
            "cli.http.backups.delete",
            decodeBody(cliDeleteBackupRequestSchema, body.value).pipe(
              Effect.flatMap((input) => deleteCliBackupEffect(principal, input))
            )
          )
        }
        return notFound()
      },
    },
  },
})

async function authenticateRequest(
  request: Request
): Promise<CliPrincipal | Response> {
  const token = bearerToken(request.headers) ?? ""
  return runAppEffect(
    "cli.http.authenticate",
    authenticateCliTokenEffect(token).pipe(
      Effect.match({
        onFailure: cliFailureResponse,
        onSuccess: (principal) => principal,
      })
    )
  )
}

function runCliEffect<TResult, TError>(
  name: string,
  effect: Effect.Effect<TResult, TError, AppCache | Database>
): Promise<Response> {
  return runAppEffect(
    name,
    effect.pipe(
      Effect.match({
        onFailure: cliFailureResponse,
        onSuccess: (value) => cliJsonResponse(value),
      })
    )
  )
}

function decodeBody<TValue>(
  schema: { parse: (value: unknown) => TValue },
  value: unknown
) {
  return Effect.try({
    try: () => schema.parse(value),
    catch: (cause) => cliInvalidRequest(cause),
  })
}

async function requestBody(
  request: Request
): Promise<{ value: unknown } | Response> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: () => request.json(),
      catch: (cause) => cause,
    }).pipe(
      Effect.match({
        onFailure: (cause) =>
          cliFailureResponse(
            CliAccessError.make({
              code: "invalid_request",
              message: "The request body must be valid JSON.",
              retryable: false,
              cause,
            })
          ),
        onSuccess: (body) => ({ value: body }),
      })
    )
  )
}

function targetFromSearch(url: URL) {
  const parsed = cliTargetSchema.safeParse({
    instanceId: url.searchParams.get("instanceId"),
    relayId: url.searchParams.get("relayId"),
  })
  return parsed.success
    ? parsed.data
    : cliFailureResponse(
        CliAccessError.make({
          code: "invalid_request",
          message: "A valid relayId and instanceId are required.",
          retryable: false,
        })
      )
}

function endpointName(requestUrl: string): string {
  const pathname = new URL(requestUrl).pathname
  return pathname.split("/api/cli/v1/")[1]?.replace(/\/$/u, "") ?? ""
}

function boundedLimit(value: string | null): number {
  const parsed = Number(value ?? 2_000)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10_000
    ? parsed
    : 2_000
}

async function streamConsole(
  request: Request,
  principal: CliPrincipal,
  input: { instanceId: string; limit: number; relayId: string }
): Promise<Response> {
  const authorization = await runCliEffect(
    "cli.http.logs.authorize",
    authorizeCliConsoleStreamEffect(principal, input)
  )
  if (!authorization.ok) return authorization

  const lifecycle = new AbortController()
  const abort = () => lifecycle.abort()
  request.signal.addEventListener("abort", abort, { once: true })
  if (request.signal.aborted) abort()
  const iterator = openHearthRelayConsoleStream({
    instanceId: input.instanceId,
    relayId: input.relayId,
    signal: lifecycle.signal,
    user: principal.user,
  })
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await iterator.next()
      if (result.done) {
        controller.close()
        return
      }
      const event = relayConsoleStreamEventSchema.parse(result.value)
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
    },
    async cancel() {
      lifecycle.abort()
      request.signal.removeEventListener("abort", abort)
      await iterator.return(undefined)
    },
  })
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store, no-transform",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  })
}

function notFound(): Response {
  return cliFailureResponse(
    CliAccessError.make({
      code: "not_found",
      message: "The CLI API endpoint was not found.",
      retryable: false,
    })
  )
}

function invalidRequest(message: string): Response {
  return cliFailureResponse(
    CliAccessError.make({
      code: "invalid_request",
      message,
      retryable: false,
    })
  )
}
