import { lookup } from "node:dns"
import { BlockList, isIP } from "node:net"
import type { LookupFunction } from "node:net"

import { Result } from "effect"

// Hearth fetches some documents and images from addresses people give it,
// such as a Brick catalog or an icon's URL. Those may only reach public
// addresses, never Hearth's own host, its private network, or a cloud's
// metadata service.

const blockedAddresses = new BlockList()
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4")
}
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6")
}

export function isPublicRemoteAddress(address: string): boolean {
  const normalized = normalizeRemoteAddress(address)
  const family = isIP(normalized)
  return (
    family !== 0 &&
    !blockedAddresses.check(normalized, family === 4 ? "ipv4" : "ipv6")
  )
}

function normalizeRemoteAddress(value: string): string {
  const withoutZone = value.split("%", 1)[0] ?? value
  const mappedIpv4 = withoutZone.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)
  if (mappedIpv4?.[1]) return mappedIpv4[1]
  if (isIP(withoutZone) !== 6) return withoutZone
  return Result.try(() => {
    const hostname = new URL(`http://[${withoutZone}]/`).hostname.slice(1, -1)
    const mappedHex = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/iu.exec(hostname)
    if (!mappedHex?.[1] || !mappedHex[2]) return withoutZone
    const high = Number.parseInt(mappedHex[1], 16)
    const low = Number.parseInt(mappedHex[2], 16)
    return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`
  }).pipe(Result.getOrElse(() => withoutZone))
}

export const secureRemoteLookup: LookupFunction = (
  hostname,
  options,
  callback
) => {
  lookup(
    hostname,
    {
      all: true,
      family: options.family,
      hints: options.hints,
      order: options.order ?? "verbatim",
    },
    (error, addresses) => {
      if (error) {
        callback(error, "")
        return
      }
      const blocked = addresses.find(
        ({ address }) => !isPublicRemoteAddress(address)
      )
      if (blocked) {
        callback(new Error("Remote source resolved to a blocked address"), "")
        return
      }
      const selected = addresses[0]
      if (!selected) {
        callback(new Error("Remote source did not resolve"), "")
        return
      }
      if (options.all) callback(null, addresses)
      else callback(null, selected.address, selected.family)
    }
  )
}
