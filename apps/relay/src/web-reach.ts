import { lookup } from "node:dns"
import { BlockList, connect, isIP, type LookupFunction } from "node:net"

const CONNECT_TIMEOUT_MS = 4_000
const WEB_PORTS = [80, 443] as const

// Anywhere the internet can't reach, so asking for a host never opens a
// connection into this Relay's own network.
const internal = (() => {
  const list = new BlockList()
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 3],
  ] as const) {
    list.addSubnet(network, prefix, "ipv4")
  }
  for (const [network, prefix] of [
    ["::", 127],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    list.addSubnet(network, prefix, "ipv6")
  }
  return list
})()

/** Whether an address is one the internet can reach. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  return (
    family !== 0 && !internal.check(address, family === 6 ? "ipv6" : "ipv4")
  )
}

// What was checked is what's connected to.
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (cause, addresses) => {
    const open = (addresses ?? []).filter(({ address }) =>
      isPublicAddress(address)
    )
    if (cause || open.length === 0) {
      callback(cause ?? new Error("No public address"), "")
    } else if (options.all) {
      callback(null, open)
    } else {
      callback(null, open[0]!.address, open[0]!.family)
    }
  })
}

/** Whether something answers at each of a public host's website ports. */
export async function webReachable(host: string): Promise<boolean> {
  if (isIP(host) !== 0 && !isPublicAddress(host)) return false
  const reached = await Promise.all(WEB_PORTS.map((port) => opens(host, port)))
  return reached.every(Boolean)
}

function opens(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, lookup: publicLookup, port })
    const done = (reached: boolean) => {
      socket.destroy()
      resolve(reached)
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false))
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}
