import { randomBytes } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"
import type { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import {
  resticRepositoryObjectTypes,
  type BackupRepositoryAccessGrant,
  type BackupRepositoryAccessRequest,
  type BackupRepositoryListing,
} from "@workspace/contracts"

import { isPublicRemoteAddress, secureRemoteLookup } from "../source-policy.js"
import {
  ensuringPromise,
  forkPromise,
  recoverPromise,
} from "../effect/promise.js"
import { isHearthUnreachable } from "./storage-access.js"

/**
 * Asks Hearth for what restic needs of a repository in a bucket: one
 * signed request to a file of it, or, for `LIST`, a page of a folder.
 * Rejects when Hearth refuses or can't be asked.
 */
export type ResticRepositoryAccess = (
  request: Pick<
    BackupRepositoryAccessRequest,
    "continuationToken" | "method" | "name" | "type"
  >
) => Promise<BackupRepositoryAccessGrant | BackupRepositoryListing>

type ObjectType = (typeof resticRepositoryObjectTypes)[number]

const REST_V2 = "application/vnd.x.restic.rest.v2"
// A bucket that says nothing for this long has gone away.
const BUCKET_IDLE_TIMEOUT_MS = 60_000
// What Hearth signs is good for ten minutes. A read is asked for once and
// used for half that, since restic reads one pack in many ranges.
const READ_GRANT_TTL_MS = 5 * 60_000
const MAX_BUCKET_ERROR_BYTES = 8 * 1024
const FILE_NAME = /^[a-f0-9]{64}$/u

/**
 * Runs `use` with the address of a restic REST server on this machine's
 * loopback that stands in for a repository in a bucket. restic speaks its
 * REST protocol to it, and each request becomes one signed request to the
 * bucket, which `access` gets from Hearth. So restic, and the Relay, hold
 * no key to the bucket: only what Hearth signs, one file at a time.
 *
 * The address carries a secret path, so nothing else on the machine can
 * use it. `use` is told how asking Hearth went:
 *
 * - `refused` aborts when Hearth refuses a request. restic would otherwise
 *   retry for minutes what asking again can't change, and the refusal is
 *   what the run then fails with.
 * - `away()` is why Hearth couldn't be asked, while that is the last thing
 *   that happened. restic is told the repository is unavailable and tries
 *   again, as it does for a bucket, so a Hearth that restarts doesn't end a
 *   backup under way; if restic gives up, this is why.
 * - `turnedDown()` is what the bucket last said as it turned a request
 *   down, such as that its storage cap is reached. restic reports only the
 *   status it was answered with, so this is how the run's failure comes to
 *   say why.
 */
export async function withResticBridge<A>(
  access: ResticRepositoryAccess,
  use: (
    repositoryUrl: string,
    bridge: {
      away: () => unknown
      refused: AbortSignal
      turnedDown: () => string | null
    }
  ) => Promise<A>
): Promise<A> {
  const token = randomBytes(32).toString("base64url")
  const refusal = new AbortController()
  let away: unknown = null
  let turnedDown: string | null = null
  const reads = new Map<
    string,
    { expires: number; grant: ReturnType<ResticRepositoryAccess> }
  >()
  const unstored = new Set<string>()
  const ask = (request: Parameters<ResticRepositoryAccess>[0]) => {
    const fresh = () =>
      recoverPromise(
        async () => {
          const answer = await access(request)
          away = null
          return answer
        },
        (cause): never => {
          if (isHearthUnreachable(cause)) {
            away = cause
            throw new HearthAway()
          }
          // Hearth said no: restic gets no further, and the run ends with
          // why.
          refusal.abort(cause)
          throw cause
        }
      )
    if (request.method !== "GET") return fresh()
    const key = readKey(request)
    const known = reads.get(key)
    if (known && known.expires > Date.now()) return known.grant
    const grant = fresh()
    reads.set(key, { expires: Date.now() + READ_GRANT_TTL_MS, grant })
    // One that wasn't given is asked for again.
    forkPromise(
      () => grant,
      () => reads.delete(key)
    )
    return grant
  }
  const server = createServer((request, response) => {
    // The request restic made ended before it was answered: nothing more
    // is asked of Hearth or sent to the bucket for it.
    const gone = new AbortController()
    response.once("close", () => {
      if (!response.writableFinished) gone.abort()
    })
    forkPromise(
      () =>
        handle(request, response, token, {
          ask,
          // A read the bucket turned down is asked for again, not sent
          // again.
          forget: (read) => reads.delete(readKey(read)),
          gone: gone.signal,
          turnedDown: (said) => {
            turnedDown = said
          },
          unstored,
        }),
      (cause) => {
        if (response.headersSent) {
          response.destroy()
          return
        }
        // restic tries again what comes back unavailable.
        response.writeHead(cause instanceof HearthAway ? 503 : 502, {
          "content-type": "text/plain",
        })
        response.end(cause instanceof Error ? cause.message : "Bridge failed")
      }
    )
  })
  // No limit on how long one request may take, which Node sets at five
  // minutes: a pack sent over a slow line is still arriving after that,
  // and restic would send it again to be cut off again. A request that
  // stalls is ended by the bucket's side going idle, and the task by its
  // deadline.
  server.requestTimeout = 0
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    server.close()
    throw new Error("The restic bridge has no address")
  }
  // The address is no use once restic has exited.
  return ensuringPromise(
    () =>
      use(`http://127.0.0.1:${address.port}/${token}/`, {
        away: () => away,
        refused: refusal.signal,
        turnedDown: () => turnedDown,
      }),
    () => {
      server.close()
      server.closeAllConnections()
    }
  )
}

const readKey = (request: Parameters<ResticRepositoryAccess>[0]) =>
  `${request.type}/${request.name ?? ""}`

class HearthAway extends Error {
  constructor() {
    super("Hearth couldn't be asked for access to the repository")
  }
}

type Bridge = {
  ask: ResticRepositoryAccess
  /**
   * Files restic sent that the bucket didn't store. restic clears up after
   * a write that failed by removing the file before it tries again, though
   * a bucket stores a file whole or not at all: that removal is answered
   * here, with nothing asked of Hearth, which lets a backup remove no data
   * and would end the run for asking.
   */
  unstored: Set<string>
  forget: (read: Parameters<ResticRepositoryAccess>[0]) => void
  /** Aborts when restic's request ends before it is answered. */
  gone: AbortSignal
  turnedDown: (said: string) => void
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  { ask, forget, gone, turnedDown, unstored }: Bridge
): Promise<void> {
  // One signed request to a file.
  const grantFor = async (
    request: Parameters<ResticRepositoryAccess>[0]
  ): Promise<BackupRepositoryAccessGrant> => {
    const answer = await ask(request)
    if (answer.status !== "granted") {
      throw new Error("Hearth answered a file's request with a listing")
    }
    // Asked for by a request that has since ended: it isn't used.
    gone.throwIfAborted()
    return answer
  }
  // What restic is answered when the bucket turns a request down. A
  // refusal goes back as one, which restic doesn't try again; anything
  // else as the bucket being unavailable, which it does.
  const refusedBy = async (answer: IncomingMessage) => {
    const status = answer.statusCode ?? 502
    const said = await bucketError(answer)
    if (status >= 400 && status < 500 && status !== 404) {
      turnedDown(`The bucket answered HTTP ${status}${said ? `: ${said}` : ""}`)
    } else if (status === 507) {
      turnedDown(`The bucket answered HTTP 507${said ? `: ${said}` : ""}`)
    }
    return status === 401 || status === 403
      ? 403
      : // Not there, no such range, or no room: answers restic takes as
        // final. Trying a write again won't make room for it.
        status === 404 || status === 416 || status === 507
        ? status
        : 502
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  const prefix = `/${token}/`
  if (!url.pathname.startsWith(prefix)) {
    request.resume()
    response.writeHead(404).end()
    return
  }
  const path = url.pathname.slice(prefix.length)
  const method = request.method ?? "GET"
  // Making the repository: there is nothing to make in a bucket.
  if (path === "") {
    request.resume()
    response.writeHead(method === "POST" ? 200 : 405).end()
    return
  }
  const [type, name, ...rest] = path.split("/")
  if (
    rest.length > 0 ||
    !resticRepositoryObjectTypes.includes(type as ObjectType)
  ) {
    request.resume()
    response.writeHead(404).end()
    return
  }
  const objectType = type as ObjectType
  if (objectType !== "config" && name === "" && path.endsWith("/")) {
    request.resume()
    if (method !== "GET") {
      response.writeHead(405).end()
      return
    }
    return list(response, objectType, ask, gone)
  }
  const file =
    objectType === "config" && name === undefined
      ? null
      : name !== undefined && FILE_NAME.test(name)
        ? name
        : undefined
  if (file === undefined || (objectType === "config") !== (file === null)) {
    request.resume()
    response.writeHead(404).end()
    return
  }
  switch (method) {
    case "GET":
    case "HEAD": {
      request.resume()
      const grant = await grantFor({ method, name: file, type: objectType })
      const range = request.headers.range
      const answer = await bucketRequest(grant, {
        ...(range ? { headers: { range } } : {}),
        signal: gone,
      })
      const status = answer.statusCode ?? 502
      if (status !== 200 && status !== 206) {
        if (status !== 404) forget({ method, name: file, type: objectType })
        response.writeHead(await refusedBy(answer)).end()
        return
      }
      response.writeHead(status, {
        ...(answer.headers["content-length"]
          ? { "content-length": answer.headers["content-length"] }
          : {}),
        ...(answer.headers["content-range"]
          ? { "content-range": answer.headers["content-range"] }
          : {}),
        "content-type": "application/octet-stream",
      })
      if (method === "HEAD") {
        answer.resume()
        response.end()
        return
      }
      // Ends both when either does: a read restic gives up on stops
      // taking the bucket's time too.
      await pipeline(answer, response)
      return
    }
    case "POST": {
      const length = request.headers["content-length"]
      if (length === undefined) {
        request.resume()
        response.writeHead(411).end()
        return
      }
      const sent = `${objectType}/${file}`
      // Not stored until the bucket says so, however this ends.
      unstored.add(sent)
      const grant = await grantFor({
        method: "PUT",
        name: file,
        type: objectType,
      })
      const answer = await bucketRequest(grant, {
        body: request,
        headers: { "content-length": length },
        signal: gone,
      })
      if (!succeeded(answer)) {
        response.writeHead(await refusedBy(answer)).end()
        return
      }
      answer.resume()
      await ended(answer)
      unstored.delete(sent)
      response.writeHead(200).end()
      return
    }
    case "DELETE": {
      request.resume()
      if (unstored.delete(`${objectType}/${file}`)) {
        response.writeHead(200).end()
        return
      }
      const grant = await grantFor({
        method: "DELETE",
        name: file,
        type: objectType,
      })
      const answer = await bucketRequest(grant, { signal: gone })
      // A file already gone is deleted.
      if (!succeeded(answer) && answer.statusCode !== 404) {
        response.writeHead(await refusedBy(answer)).end()
        return
      }
      answer.resume()
      await ended(answer)
      response.writeHead(200).end()
      return
    }
    default:
      request.resume()
      response.writeHead(405).end()
  }
}

// A folder's files, as restic's REST protocol lists them. Hearth reads the
// bucket's listing itself, a page at a time: a listing is of the bucket,
// not of one file, and not every bucket takes a signed request for one.
async function list(
  response: ServerResponse,
  type: ObjectType,
  ask: ResticRepositoryAccess,
  gone: AbortSignal
): Promise<void> {
  const files: BackupRepositoryListing["files"] = []
  let continuationToken: string | undefined
  do {
    // A listing restic has given up on asks Hearth for no more pages.
    gone.throwIfAborted()
    const page = await ask({
      ...(continuationToken ? { continuationToken } : {}),
      method: "LIST",
      name: null,
      type,
    })
    if (page.status !== "listed") {
      throw new Error("Hearth answered a listing with a file's request")
    }
    files.push(...page.files)
    continuationToken = page.next ?? undefined
  } while (continuationToken)
  gone.throwIfAborted()
  const body = Buffer.from(JSON.stringify(files))
  response.writeHead(200, {
    "content-length": String(body.byteLength),
    "content-type": REST_V2,
  })
  response.end(body)
}

// What a bucket said as it turned a request down: its error's code and
// message, which name such things as a storage cap. Read to a limit, and
// only those two fields, so nothing else of the answer is kept.
async function bucketError(answer: IncomingMessage): Promise<string> {
  const body = await recoverPromise(
    async () => {
      const chunks: Array<Buffer> = []
      let bytes = 0
      for await (const chunk of answer as AsyncIterable<Buffer>) {
        bytes += chunk.byteLength
        if (bytes > MAX_BUCKET_ERROR_BYTES) break
        chunks.push(chunk)
      }
      return Buffer.concat(chunks).toString("utf8")
    },
    () => ""
  )
  answer.destroy()
  return ["Code", "Message"]
    .flatMap((field) => {
      const value = new RegExp(`<${field}>([^<]{1,200})</${field}>`, "u").exec(
        body
      )?.[1]
      return value ? [value.trim()] : []
    })
    .join(": ")
}

function succeeded(answer: IncomingMessage): boolean {
  const status = answer.statusCode ?? 0
  return status >= 200 && status < 300
}

function ended(stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("end", resolve)
    stream.once("close", resolve)
    stream.once("error", reject)
  })
}

// One signed request to the bucket, by the same rules as any signed backup
// request: HTTPS only, and no private address unless the destination's
// owner allowed one.
function bucketRequest(
  grant: BackupRepositoryAccessGrant,
  options: {
    body?: Readable
    headers?: Readonly<Record<string, string>>
    /** Ends the request, and what it was answered with, when it aborts. */
    signal: AbortSignal
  }
): Promise<IncomingMessage> {
  const url = new URL(grant.url)
  if (url.protocol !== "https:" || url.username || url.password) {
    return Promise.reject(new Error("Signed backup URLs must use HTTPS"))
  }
  const literal = url.hostname.replace(/^\[|\]$/gu, "")
  if (
    !grant.allowPrivateNetwork &&
    isIP(literal) !== 0 &&
    !isPublicRemoteAddress(literal)
  ) {
    return Promise.reject(
      new Error("Signed backup URL resolves to a private or reserved address")
    )
  }
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        headers: { ...grant.headers, ...options.headers },
        lookup: grant.allowPrivateNetwork ? undefined : secureRemoteLookup,
        method: grant.method,
        signal: options.signal,
      },
      resolve
    )
    request.setTimeout(BUCKET_IDLE_TIMEOUT_MS, () =>
      request.destroy(new Error("The bucket stopped answering"))
    )
    request.once("error", reject)
    if (options.body) {
      options.body.once("error", (cause) => request.destroy(cause))
      options.body.pipe(request)
    } else {
      request.end()
    }
  })
}
