import { randomBytes } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import { Agent, request as httpsRequest } from "node:https"
import type { Readable } from "node:stream"
import { finished, pipeline } from "node:stream/promises"

import {
  backupRepositoryAccessReplySchema,
  resticRepositoryFileSchema,
  resticRepositoryFolderSchema,
  type BackupRepositoryAccessReply,
  type BackupRepositoryAccessRequest,
} from "@workspace/contracts"
import { Effect } from "effect"

import {
  forkPromise,
  promiseEffect,
  recoverPromise,
} from "../../../effect/promise.js"
import { secureRemoteLookup } from "../../../source-policy.js"
import { s3ErrorDetail, signedBackupUrl } from "./index.js"

/**
 * Asks Hearth for one request to a repository in a bucket; null when no
 * Hearth answers.
 */
export type ResticRepositoryAccess = (
  request: BackupRepositoryAccessRequest
) => Promise<BackupRepositoryAccessReply | null>

type SignedReply = Extract<BackupRepositoryAccessReply, { status: "signed" }>

const HEARTH_TIMEOUT_MS = 15_000
// restic tries again for longer than this, and the Relay makes one backup at
// a time, so a Hearth that stays away would hold up every other backup.
const HEARTH_AWAY_LIMIT_MS = 2 * 60_000
// What Hearth signs is good for ten minutes. A download reads one file in as
// many ranges as it holds files.
const READ_LINK_TTL_MS = 5 * 60_000
const BUCKET_IDLE_TIMEOUT_MS = 60_000
const MAX_BUCKET_ERROR_BYTES = 64 * 1024

/** Asks every connected Hearth; the one whose repository it is signs. */
export async function askHearthForRepositoryAccess(
  requestClients: (
    operation: "backup.repository.access",
    payload: BackupRepositoryAccessRequest,
    timeoutMs: number
  ) => Promise<ReadonlyArray<{ payload: unknown }>>,
  request: BackupRepositoryAccessRequest
): Promise<BackupRepositoryAccessReply | null> {
  const replies = (
    await requestClients("backup.repository.access", request, HEARTH_TIMEOUT_MS)
  ).flatMap(({ payload }) => {
    const reply = backupRepositoryAccessReplySchema.safeParse(payload)
    return reply.success ? [reply.data] : []
  })
  return (
    replies.find(({ status }) => status !== "refused") ?? replies[0] ?? null
  )
}

/**
 * Runs `use` with the address of a restic REST server on the loopback that
 * stands in for a repository in a bucket. It sends each request restic makes
 * to the bucket as Hearth signs it, so neither restic nor the Relay holds a
 * key. The address has a secret path and lasts as long as `use`.
 *
 * restic reports the status line of a failed request and nothing else, so
 * that is where the bucket's or Hearth's reason goes. It tries again after a
 * 500, and gives up at once on a 403.
 */
export function withResticBridge<T>(
  access: ResticRepositoryAccess,
  repositoryId: string,
  use: (repositoryUrl: string) => Promise<T>
): Promise<T> {
  const token = randomBytes(32).toString("base64url")
  const bridge = new ResticBridge(access, repositoryId, `/${token}/`)
  return Effect.runPromise(
    Effect.acquireUseRelease(
      promiseEffect(() => bridge.listen()),
      (port) =>
        promiseEffect(() => use(`rest:http://127.0.0.1:${port}/${token}/`)),
      () => Effect.sync(() => bridge.close())
    )
  )
}

/** A request the bridge answers with a failure restic reads the reason of. */
class BridgeFailure extends Error {
  constructor(
    readonly status: number,
    reason: string
  ) {
    super(reason)
  }
}

class ResticBridge {
  readonly #access: ResticRepositoryAccess
  readonly #agent = new Agent({ keepAlive: true })
  readonly #links = new Map<
    string,
    { expires: number; link: Promise<SignedReply> }
  >()
  readonly #path: string
  readonly #repositoryId: string
  readonly #server: Server
  #awaySince: number | null = null

  constructor(
    access: ResticRepositoryAccess,
    repositoryId: string,
    path: string
  ) {
    this.#access = access
    this.#path = path
    this.#repositoryId = repositoryId
    this.#server = createServer((request, response) => {
      forkPromise(
        () => this.#handle(request, response),
        (cause) => {
          // What's left of an upload nothing takes.
          request.resume()
          if (response.headersSent) {
            response.destroy()
            return
          }
          response
            .writeHead(
              cause instanceof BridgeFailure ? cause.status : 500,
              statusText(cause instanceof Error ? cause.message : String(cause))
            )
            .end()
        }
      )
    })
    // Node's limits are for clients that aren't restic: a pack takes as long
    // as the line to the bucket does, and a connection waits while restic
    // reads files.
    this.#server.requestTimeout = 0
    this.#server.keepAliveTimeout = 0
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject)
      this.#server.listen(0, "127.0.0.1", () => {
        const address = this.#server.address()
        if (address === null || typeof address === "string") {
          reject(new Error("The restic bridge has no address"))
          return
        }
        resolve(address.port)
      })
    })
  }

  close(): void {
    this.#server.close()
    this.#server.closeAllConnections()
    this.#agent.destroy()
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1")
    const method = request.method ?? "GET"
    if (!pathname.startsWith(this.#path)) {
      throw new BridgeFailure(404, "Not Found")
    }
    const path = pathname.slice(this.#path.length)
    // Making the repository: a bucket has no folders to make.
    if (path === "" && method === "POST") {
      request.resume()
      response.writeHead(200).end()
      return
    }
    const folder = resticRepositoryFolderSchema.safeParse(path.slice(0, -1))
    if (path.endsWith("/") && folder.success && method === "GET") {
      const files = JSON.stringify(await this.#list(folder.data))
      response
        .writeHead(200, {
          "content-length": Buffer.byteLength(files),
          "content-type": "application/vnd.x.restic.rest.v2",
        })
        .end(files)
      return
    }
    const file = resticRepositoryFileSchema.safeParse(path)
    if (!file.success) throw new BridgeFailure(404, "Not Found")
    // restic giving up on a request ends the bucket's side of it too.
    const gone = new AbortController()
    response.once("close", () => gone.abort())
    switch (method) {
      case "GET":
      case "HEAD": {
        const answer = await this.#send(method, file.data, {
          headers: request.headers.range
            ? { range: request.headers.range }
            : {},
          signal: gone.signal,
        })
        response.writeHead(answer.statusCode ?? 200, {
          ...copied(answer, "content-length"),
          ...copied(answer, "content-range"),
        })
        await pipeline(answer, response)
        return
      }
      case "POST": {
        const length = request.headers["content-length"]
        if (length === undefined) throw new BridgeFailure(411, "No length")
        await drained(
          await this.#send("PUT", file.data, {
            body: request,
            headers: { "content-length": length },
            signal: gone.signal,
          })
        )
        response.writeHead(200).end()
        return
      }
      case "DELETE": {
        await drained(
          await this.#send("DELETE", file.data, {
            headers: {},
            signal: gone.signal,
          })
        )
        // A bucket answers 204, which restic takes for a failure.
        response.writeHead(200).end()
        return
      }
      default:
        throw new BridgeFailure(405, "Method Not Allowed")
    }
  }

  async #list(folder: "data" | "index" | "keys" | "locks" | "snapshots") {
    const files: Array<{ name: string; size: number }> = []
    let after: string | undefined
    do {
      const page = await this.#ask({
        ...(after ? { after } : {}),
        folder,
        method: "LIST",
        repositoryId: this.#repositoryId,
      })
      if (page.status !== "listed") {
        throw new BridgeFailure(500, "Hearth answered something else")
      }
      files.push(...page.files)
      after = page.next ?? undefined
    } while (after)
    return files
  }

  /** Sends the bucket one signed request, and fails unless it succeeds. */
  async #send(
    method: "DELETE" | "GET" | "HEAD" | "PUT",
    file: string,
    options: {
      body?: Readable
      headers: Record<string, string>
      signal: AbortSignal
    }
  ): Promise<IncomingMessage> {
    const link =
      method === "GET"
        ? await this.#readLink(file)
        : await this.#sign(method, file)
    const url = signedBackupUrl(link)
    const answer = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          agent: this.#agent,
          headers: options.headers,
          lookup: link.allowPrivateNetwork ? undefined : secureRemoteLookup,
          method,
          signal: options.signal,
        },
        resolve
      )
      request.setTimeout(BUCKET_IDLE_TIMEOUT_MS, () => {
        request.destroy(new Error("S3 backup request timed out"))
      })
      request.once("error", reject)
      if (options.body) options.body.pipe(request)
      else request.end()
    })
    const status = answer.statusCode ?? 0
    if (status >= 200 && status < 300) return answer
    const said = await errorSaid(answer)
    throw new BridgeFailure(
      // Anything restic can't make right by trying again goes through as it
      // is, as does a bucket with no room. The rest it tries again.
      (status >= 400 && status < 500) || status === 507 ? status : 500,
      said ?? answer.statusMessage ?? ""
    )
  }

  #readLink(file: string): Promise<SignedReply> {
    const known = this.#links.get(file)
    if (known && known.expires > Date.now()) return known.link
    const link = this.#sign("GET", file)
    this.#links.set(file, { expires: Date.now() + READ_LINK_TTL_MS, link })
    // One that wasn't given is asked for again.
    forkPromise(
      () => link,
      () => this.#links.delete(file)
    )
    return link
  }

  async #sign(
    method: "DELETE" | "GET" | "HEAD" | "PUT",
    file: string
  ): Promise<SignedReply> {
    const reply = await this.#ask({
      file,
      method,
      repositoryId: this.#repositoryId,
    })
    if (reply.status === "signed") return reply
    throw new BridgeFailure(500, "Hearth answered something else")
  }

  async #ask(request: BackupRepositoryAccessRequest) {
    const reply = await recoverPromise(
      () => this.#access(request),
      () => null
    )
    if (reply === null) {
      this.#awaySince ??= Date.now()
      throw new BridgeFailure(
        Date.now() - this.#awaySince > HEARTH_AWAY_LIMIT_MS ? 403 : 500,
        "Hearth couldn't be reached"
      )
    }
    this.#awaySince = null
    if (reply.status === "refused") {
      throw new BridgeFailure(403, `Hearth refused: ${reply.reason}`)
    }
    return reply
  }
}

function copied(
  answer: IncomingMessage,
  header: "content-length" | "content-range"
): Record<string, string> {
  const value = answer.headers[header]
  return value === undefined ? {} : { [header]: value }
}

async function drained(answer: IncomingMessage): Promise<void> {
  answer.resume()
  await finished(answer)
}

async function errorSaid(answer: IncomingMessage): Promise<string | null> {
  return recoverPromise(
    async () => {
      const chunks: Array<Buffer> = []
      let bytes = 0
      for await (const chunk of answer as AsyncIterable<Buffer>) {
        bytes += chunk.byteLength
        if (bytes > MAX_BUCKET_ERROR_BYTES) break
        chunks.push(chunk)
      }
      return s3ErrorDetail(Buffer.concat(chunks).toString("utf8"))
    },
    () => null
  )
}

/** A reason as an HTTP status line can carry it. */
function statusText(reason: string): string {
  return reason.replaceAll(/[^\x20-\x7e]+/gu, " ").slice(0, 600)
}
