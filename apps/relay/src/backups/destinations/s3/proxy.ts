import { randomBytes } from "node:crypto"
import { lookup as dnsLookup } from "node:dns"
import { connect, createServer, isIP, type Server, type Socket } from "node:net"

import { Effect, Result } from "effect"

import {
  isPublicRemoteAddress,
  secureRemoteLookup,
} from "../../../source-policy.js"

const MAX_CONNECT_HEADER_BYTES = 8_192
const MAX_CONNECT_ADDRESSES = 8
const AWS_SUFFIXES = [".amazonaws.com.cn", ".amazonaws.com"] as const
const CONNECT_TIMEOUT_MS = 10_000
const PROXY_CLOSE_TIMEOUT_MS = 2_000

type ResticS3Proxy = {
  server: Server
  state: ResticS3ProxyState
}

type ResticS3ProxyState = {
  closing: boolean
  sockets: Set<Socket>
}

export type ResticS3ProxyOptions = {
  allowPrivateNetwork: boolean
  allowedHosts: ReadonlySet<string>
  endpointPort: number
  token: string
}

export function resticS3ProxyToken(): string {
  return randomBytes(32).toString("base64url")
}

export function resticS3ProxyAllowedHosts(input: {
  bucket: string
  endpoint: string
  region: string
}): Set<string> {
  const endpointHost = canonicalizeHostname(new URL(input.endpoint).hostname)
  const hosts = new Set([endpointHost, `${input.bucket}.${endpointHost}`])
  const awsSuffix = AWS_SUFFIXES.find((suffix) => endpointHost.endsWith(suffix))
  if (!awsSuffix) return hosts
  const regional = `s3.${input.region}.${awsSuffix.slice(1)}`
  const dualstack = `s3.dualstack.${input.region}.${awsSuffix.slice(1)}`
  for (const host of [regional, dualstack]) {
    hosts.add(host)
    hosts.add(`${input.bucket}.${host}`)
  }
  return hosts
}

function parseResticS3ConnectTarget(authority: string): {
  hostname: string
  port: number
} | null {
  if (
    authority.includes("/") ||
    authority.includes("?") ||
    authority.includes("#") ||
    authority.includes("@") ||
    authority.includes(" ")
  ) {
    return null
  }
  const parsed = parseAuthorityUrl(authority)
  if (!parsed) return null
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    return null
  }
  if (!parsed.port) return null
  const ipv6 = isIP(parsed.hostname.replace(/^\[|\]$/gu, "")) === 6
  if (ipv6 && !authority.startsWith("[")) return null
  const formatted = parsed.host
  const canonicalAuthority = canonicalizeConnectAuthority(authority)
  if (!canonicalAuthority || formatted !== canonicalAuthority) return null
  const hostname = canonicalizeHostname(parsed.hostname)
  const port = Number(parsed.port)
  if (!hostname || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return null
  }
  return { hostname, port }
}

function parseResticS3ConnectRequest(
  raw: string,
  options: Pick<ResticS3ProxyOptions, "endpointPort" | "token">
): { hostname: string; port: number } | null {
  const [head, ...rest] = raw.split("\r\n")
  const requestLine = head?.split(" ")
  if (
    requestLine?.length !== 3 ||
    requestLine[0] !== "CONNECT" ||
    !requestLine[2]?.startsWith("HTTP/")
  ) {
    return null
  }
  const expected = Buffer.from(`user:${options.token}`).toString("base64")
  const authorized = rest.some((header) => {
    const separator = header.indexOf(":")
    if (separator === -1) return false
    const name = header.slice(0, separator).trim().toLowerCase()
    const value = header.slice(separator + 1).trim()
    return name === "proxy-authorization" && value === `Basic ${expected}`
  })
  if (!authorized) return null
  const target = parseResticS3ConnectTarget(requestLine[1] ?? "")
  if (!target || target.port !== options.endpointPort) return null
  return target
}

export function withResticS3Proxy<T>(
  options: ResticS3ProxyOptions,
  use: (proxyUrl: string) => Promise<T>
): Promise<T> {
  return Effect.runPromise(
    Effect.acquireUseRelease(
      listenResticS3Proxy(options),
      (proxy) =>
        Effect.tryPromise({
          try: () => use(resticS3ProxyUrl(proxy.server, options.token)),
          catch: (cause) =>
            cause instanceof Error
              ? cause
              : new Error("The restic S3 proxy failed", { cause }),
        }),
      (proxy) =>
        Effect.tryPromise({
          try: () => closeResticS3Proxy(proxy),
          catch: (cause) =>
            cause instanceof Error
              ? cause
              : new Error("The restic S3 proxy could not close", { cause }),
        })
    )
  )
}

function listenResticS3Proxy(options: ResticS3ProxyOptions) {
  return Effect.tryPromise({
    try: () =>
      new Promise<ResticS3Proxy>((resolve, reject) => {
        const state: ResticS3ProxyState = {
          closing: false,
          sockets: new Set<Socket>(),
        }
        const server = createServer((client) => {
          if (state.closing) {
            client.destroy()
            return
          }
          state.sockets.add(client)
          client.once("close", () => state.sockets.delete(client))
          void handleConnectClient(client, options, state)
        })
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject)
          resolve({ server, state })
        })
      }),
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error("The restic S3 proxy could not listen", { cause }),
  })
}

function resticS3ProxyUrl(server: Server, token: string): string {
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("The restic S3 proxy did not bind a local port")
  }
  return `http://user:${token}@127.0.0.1:${address.port}`
}

function handleConnectClient(
  client: Socket,
  options: ResticS3ProxyOptions,
  state: ResticS3ProxyState
): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise({
        try: () => readHttpHead(client, CONNECT_TIMEOUT_MS),
        catch: (cause) =>
          cause instanceof Error
            ? cause
            : new Error("CONNECT headers failed", { cause }),
      })
      const target = parseResticS3ConnectRequest(raw, options)
      if (!target) {
        rejectConnect(client)
        return
      }
      if (!options.allowedHosts.has(target.hostname)) {
        console.error(
          `Rejected restic S3 CONNECT to disallowed host ${target.hostname}`
        )
        rejectConnect(client)
        return
      }
      const addresses = yield* Effect.promise(() =>
        resolveConnectAddresses(target.hostname, options, CONNECT_TIMEOUT_MS)
      )
      if (addresses.length === 0) {
        rejectConnect(client)
        return
      }
      const upstream = yield* connectFirstUpstream(
        addresses,
        target.port,
        CONNECT_TIMEOUT_MS
      )
      if (state.closing || client.destroyed) {
        upstream.destroy()
        return
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      client.pipe(upstream)
      upstream.pipe(client)
      const close = () => {
        client.destroy()
        upstream.destroy()
      }
      client.on("error", close)
      upstream.on("error", close)
      client.on("close", close)
      upstream.on("close", close)
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          rejectConnect(client)
        })
      )
    )
  )
}

function closeResticS3Proxy(proxy: ResticS3Proxy): Promise<void> {
  proxy.state.closing = true
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      for (const socket of proxy.state.sockets) socket.destroy()
      finish(new Error("The restic S3 proxy timed out while closing"))
    }, PROXY_CLOSE_TIMEOUT_MS)
    proxy.server.close((error) => finish(error))
    for (const socket of proxy.state.sockets) socket.destroy()
  })
}

function readHttpHead(client: Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("CONNECT headers timed out"))
    }, timeoutMs)
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.byteLength > MAX_CONNECT_HEADER_BYTES) {
        cleanup()
        reject(new Error("CONNECT headers exceeded the maximum size"))
        return
      }
      const separator = buffer.indexOf("\r\n\r\n")
      if (separator === -1) return
      cleanup()
      resolve(buffer.subarray(0, separator).toString("latin1"))
    }
    const onEnd = () => {
      cleanup()
      reject(new Error("CONNECT headers ended before completion"))
    }
    const cleanup = () => {
      clearTimeout(timer)
      client.off("data", onData)
      client.off("end", onEnd)
      client.off("error", onEnd)
    }
    client.on("data", onData)
    client.on("end", onEnd)
    client.on("error", onEnd)
  })
}

function rejectConnect(client: Socket): void {
  client.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
  client.destroy()
}

function resolveConnectAddresses(
  hostname: string,
  options: ResticS3ProxyOptions,
  timeoutMs: number
): Promise<Array<string>> {
  const lookup = options.allowPrivateNetwork ? dnsLookup : secureRemoteLookup
  return new Promise((resolve) => {
    let settled = false
    const finish = (addresses: Array<string>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(addresses)
    }
    const timer = setTimeout(() => finish([]), timeoutMs)
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error || !Array.isArray(addresses) || addresses.length === 0) {
        if (error && !options.allowPrivateNetwork) {
          console.error(
            `Rejected restic S3 CONNECT to ${hostname}: ${error.message}`
          )
        }
        finish([])
        return
      }
      const selected = addresses.flatMap((entry) => {
        if (
          options.allowPrivateNetwork ||
          isPublicRemoteAddress(entry.address)
        ) {
          return [entry.address]
        }
        return []
      })
      if (selected.length === 0) {
        console.error(
          `Rejected restic S3 CONNECT to ${hostname}: private address`
        )
      }
      finish(selected.slice(0, MAX_CONNECT_ADDRESSES))
    })
  })
}

function connectFirstUpstream(
  addresses: ReadonlyArray<string>,
  port: number,
  timeoutMs: number
) {
  return Effect.gen(function* () {
    let lastError: Error | null = null
    const attemptTimeoutMs = Math.max(
      1,
      Math.floor(timeoutMs / Math.max(1, addresses.length))
    )
    for (const address of addresses) {
      const connected = yield* Effect.result(
        Effect.tryPromise({
          try: () => connectUpstream(address, port, attemptTimeoutMs),
          catch: (cause) =>
            cause instanceof Error
              ? cause
              : new Error("Upstream CONNECT failed", { cause }),
        })
      )
      if (Result.isSuccess(connected)) return connected.success
      lastError = connected.failure
    }
    return yield* Effect.fail(lastError ?? new Error("Upstream CONNECT failed"))
  })
}

function connectUpstream(
  address: string,
  port: number,
  timeoutMs: number
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("Upstream CONNECT timed out"))
    }, timeoutMs)
    const fail = (cause: Error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(cause)
    }
    socket.once("error", fail)
    socket.once("connect", () => {
      clearTimeout(timer)
      socket.off("error", fail)
      resolve(socket)
    })
  })
}

function parseAuthorityUrl(authority: string): URL | null {
  return Result.getOrNull(Result.try(() => new URL(`http://${authority}`)))
}

function canonicalizeConnectAuthority(authority: string): string | null {
  const parsed = parseAuthorityUrl(authority.toLowerCase())
  if (!parsed?.port) return null
  const hostname = canonicalizeHostname(parsed.hostname)
  if (!hostname) return null
  const ipv6 = isIP(hostname) === 6
  return ipv6 ? `[${hostname}]:${parsed.port}` : `${hostname}:${parsed.port}`
}

function canonicalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/gu, "")
    .toLowerCase()
    .replace(/\.$/u, "")
}
