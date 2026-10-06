import type { LookupAddress } from "node:dns"
import { once } from "node:events"
import { createServer, connect, type Server, type Socket } from "node:net"

import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import { resticS3ProxyAllowedHosts, withResticS3Proxy } from "./proxy.js"

// DNS is the external system here: hostnames listed in `dnsAnswers` resolve
// to fixed addresses, everything else (IP literals) uses the real resolver.
const dnsAnswers = vi.hoisted(() => new Map<string, Array<LookupAddress>>())

vi.mock("node:dns", async (importOriginal) => {
  const dns = await importOriginal<typeof import("node:dns")>()
  const lookup = ((
    hostname: string,
    options: unknown,
    callback: (error: Error | null, addresses: Array<LookupAddress>) => void
  ) => {
    const answers = dnsAnswers.get(hostname)
    if (!answers) {
      return (dns.lookup as (...args: Array<unknown>) => void)(
        hostname,
        options,
        callback
      )
    }
    queueMicrotask(() => callback(null, answers))
  }) as typeof dns.lookup
  return { ...dns, lookup }
})

const token = "proxy-token"

afterEach(() => {
  dnsAnswers.clear()
})

describe("restic S3 CONNECT proxy", () => {
  it("allows the endpoint, virtual-hosted bucket, and AWS regional hosts", () => {
    expect(
      [
        ...resticS3ProxyAllowedHosts({
          bucket: "kiln-backups",
          endpoint: "https://s3.us-east-1.amazonaws.com",
          region: "us-east-1",
        }),
      ].sort()
    ).toEqual([
      "kiln-backups.s3.dualstack.us-east-1.amazonaws.com",
      "kiln-backups.s3.us-east-1.amazonaws.com",
      "s3.dualstack.us-east-1.amazonaws.com",
      "s3.us-east-1.amazonaws.com",
    ])
    expect(
      resticS3ProxyAllowedHosts({
        bucket: "kiln-backups",
        endpoint: "https://s3.cn-north-1.amazonaws.com.cn",
        region: "cn-north-1",
      }).has("s3.cn-north-1.amazonaws.com.cn")
    ).toBe(true)
    expect(
      resticS3ProxyAllowedHosts({
        bucket: "kiln-backups",
        endpoint: "https://minio:9000",
        region: "us-east-1",
      }).has("s3.us-east-1.amazonaws.com")
    ).toBe(false)
  })

  it("only tunnels well-formed CONNECT requests that carry the proxy token", async () => {
    const upstream = await upstreamServer()
    const authority = `127.0.0.1:${upstream.port}`
    try {
      const statuses = await withResticS3Proxy(
        proxyOptions({ endpointPort: upstream.port }),
        async (proxyUrl) => ({
          authorized: await proxyStatus(
            proxyUrl,
            connectRequest(authority, token)
          ),
          wrongToken: await proxyStatus(
            proxyUrl,
            connectRequest(authority, "wrong")
          ),
          missingToken: await proxyStatus(
            proxyUrl,
            `CONNECT ${authority} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`
          ),
          otherPort: await proxyStatus(
            proxyUrl,
            connectRequest("127.0.0.1:1", token)
          ),
          path: await proxyStatus(
            proxyUrl,
            connectRequest(`${authority}/evil`, token)
          ),
          userinfo: await proxyStatus(
            proxyUrl,
            connectRequest(`user:pass@${authority}`, token)
          ),
          malformed: await proxyStatus(proxyUrl, connectRequest("[", token)),
          notConnect: await proxyStatus(
            proxyUrl,
            connectRequest(authority, token).replace("CONNECT", "GET")
          ),
        })
      )
      expect(statuses).toEqual({
        authorized: 200,
        wrongToken: 403,
        missingToken: 403,
        otherPort: 403,
        path: 403,
        userinfo: 403,
        malformed: 403,
        notConnect: 403,
      })
    } finally {
      await upstream.close()
    }
  })

  it("rejects CONNECT to a host outside the allowlist", async () => {
    const upstream = await upstreamServer()
    dnsAnswers.set("evil.example.com", [{ address: "127.0.0.1", family: 4 }])
    try {
      const status = await withResticS3Proxy(
        proxyOptions({ endpointPort: upstream.port }),
        (proxyUrl) =>
          proxyStatus(
            proxyUrl,
            connectRequest(`evil.example.com:${upstream.port}`, token)
          )
      )
      expect(status).toBe(403)
    } finally {
      await upstream.close()
    }
  })

  it("rejects private DNS answers unless allowPrivateNetwork is set", async () => {
    const upstream = await upstreamServer()
    dnsAnswers.set("minio", [{ address: "127.0.0.1", family: 4 }])
    const request = connectRequest(`minio:${upstream.port}`, token)
    try {
      const denied = await withResticS3Proxy(
        proxyOptions({
          allowPrivateNetwork: false,
          endpointPort: upstream.port,
        }),
        (proxyUrl) => proxyStatus(proxyUrl, request)
      )
      expect(denied).toBe(403)

      const allowed = await withResticS3Proxy(
        proxyOptions({
          allowPrivateNetwork: true,
          endpointPort: upstream.port,
        }),
        (proxyUrl) => proxyStatus(proxyUrl, request)
      )
      expect(allowed).toBe(200)
    } finally {
      await upstream.close()
    }
  })

  it("falls back to the next DNS answer when the first is unreachable", async () => {
    // The upstream listens on IPv4 loopback only, so the IPv6 answer is
    // refused (or unroutable) immediately.
    const upstream = await upstreamServer()
    dnsAnswers.set("minio", [
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ])
    try {
      const status = await withResticS3Proxy(
        proxyOptions({ endpointPort: upstream.port }),
        (proxyUrl) =>
          proxyStatus(proxyUrl, connectRequest(`minio:${upstream.port}`, token))
      )
      expect(status).toBe(200)
    } finally {
      await upstream.close()
    }
  })

  it("closes an established tunnel when the proxy scope ends", async () => {
    const upstream = await upstreamServer()
    let client: Socket | undefined
    try {
      await withResticS3Proxy(
        proxyOptions({ endpointPort: upstream.port }),
        async (proxyUrl) => {
          client = await openProxyClient(proxyUrl)
          client.write(connectRequest(`127.0.0.1:${upstream.port}`, token))
          expect(await readStatus(client)).toBe(200)
        }
      )
      if (client && !client.destroyed) await once(client, "close")
      expect(client?.destroyed).toBe(true)
    } finally {
      await upstream.close()
    }
  })
})

function proxyOptions(input: {
  allowPrivateNetwork?: boolean
  endpointPort: number
}) {
  return {
    allowPrivateNetwork: input.allowPrivateNetwork ?? true,
    allowedHosts: new Set(["127.0.0.1", "minio", "s3.example.com"]),
    endpointPort: input.endpointPort,
    token,
  }
}

function connectRequest(authority: string, proxyToken: string) {
  const expected = Buffer.from(`user:${proxyToken}`).toString("base64")
  return [
    `CONNECT ${authority} HTTP/1.1`,
    `Proxy-Authorization: Basic ${expected}`,
    "Host: 127.0.0.1",
    "",
    "",
  ].join("\r\n")
}

async function openProxyClient(proxyUrl: string): Promise<Socket> {
  const parsed = new URL(proxyUrl)
  const client = connect({ host: parsed.hostname, port: Number(parsed.port) })
  client.on("error", () => {})
  await once(client, "connect")
  return client
}

async function readStatus(client: Socket): Promise<number> {
  const [chunk] = (await once(client, "data")) as [Buffer]
  return Number(chunk.toString("latin1").split(" ")[1])
}

async function proxyStatus(proxyUrl: string, request: string) {
  const client = await openProxyClient(proxyUrl)
  try {
    client.write(request)
    return await readStatus(client)
  } finally {
    client.destroy()
  }
}

/** A loopback TCP server that accepts and holds connections. */
async function upstreamServer(): Promise<{
  close: () => Promise<void>
  port: number
}> {
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("upstream test server did not bind")
  }
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy()
      server.close()
      await once(server, "close")
    },
    port: address.port,
  }
}
