import { lookup } from "node:dns"
import { BlockList, isIP } from "node:net"
import type { LookupFunction } from "node:net"

import { Result } from "effect"

const MAX_SOURCE_CIDRS = 16
const BLOCKED_REMOTE_ADDRESSES = new BlockList()
const BLOCKED_IPV4_SUBNETS: ReadonlyArray<readonly [string, number]> = [
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
]
const BLOCKED_IPV6_SUBNETS: ReadonlyArray<readonly [string, number]> = [
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
]

for (const [network, prefix] of BLOCKED_IPV4_SUBNETS) {
  BLOCKED_REMOTE_ADDRESSES.addSubnet(network, prefix, "ipv4")
}
for (const [network, prefix] of BLOCKED_IPV6_SUBNETS) {
  BLOCKED_REMOTE_ADDRESSES.addSubnet(network, prefix, "ipv6")
}

export class BlockedRemoteAddressError
  extends Error
  implements NodeJS.ErrnoException
{
  readonly code = "EACCES"

  constructor(readonly address: string) {
    super(`Remote source resolves to blocked address ${address}`)
  }
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
        callback(new BlockedRemoteAddressError(blocked.address), "")
        return
      }
      const selected = addresses.at(0)
      if (!selected) {
        callback(new Error("Remote source did not resolve to an address"), "")
        return
      }
      if (options.all) callback(null, addresses)
      else callback(null, selected.address, selected.family)
    }
  )
}

export function isPublicRemoteAddress(address: string): boolean {
  const normalized = normalizePeerAddress(address)
  const family = isIP(normalized)
  if (!family) return false
  return !BLOCKED_REMOTE_ADDRESSES.check(
    normalized,
    family === 4 ? "ipv4" : "ipv6"
  )
}

export function normalizeSourceCidrs(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_CIDRS) {
    throw new Error(
      `sourceCidrs must contain at most ${MAX_SOURCE_CIDRS} entries`
    )
  }
  return [...new Set(value.map(normalizeSourceCidr))]
}

export function isSourceAllowed(
  address: string | undefined,
  sourceCidrs: ReadonlyArray<string>
): boolean {
  if (!sourceCidrs.length) return true
  if (!address) return false
  const peer = normalizePeerAddress(address)
  const peerFamily = isIP(peer)
  if (!peerFamily) return false

  return sourceCidrs.some((sourceCidr) => {
    const [network, prefixText] = sourceCidr.split("/")
    const family = isIP(network ?? "")
    if (!network || !prefixText || family !== peerFamily) return false
    const blockList = new BlockList()
    blockList.addSubnet(
      network,
      Number(prefixText),
      family === 4 ? "ipv4" : "ipv6"
    )
    return blockList.check(peer, family === 4 ? "ipv4" : "ipv6")
  })
}

function normalizeSourceCidr(value: unknown): string {
  if (typeof value !== "string") throw new Error("Source CIDRs must be strings")
  const trimmed = value.trim().toLowerCase()
  const separator = trimmed.lastIndexOf("/")
  const address = normalizePeerAddress(
    separator === -1 ? trimmed : trimmed.slice(0, separator)
  )
  const family = isIP(address)
  if (!family) throw new Error(`Invalid source address: ${trimmed}`)
  const maximumPrefix = family === 4 ? 32 : 128
  const prefix =
    separator === -1 ? maximumPrefix : Number(trimmed.slice(separator + 1))
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximumPrefix) {
    throw new Error(`Invalid source CIDR prefix: ${trimmed}`)
  }

  const blockList = new BlockList()
  blockList.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6")
  return `${address}/${prefix}`
}

function normalizePeerAddress(value: string): string {
  const withoutZone = value.split("%", 1)[0] ?? value
  const mappedIpv4 = withoutZone.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)
  if (mappedIpv4?.[1]) return mappedIpv4[1]
  if (isIP(withoutZone) !== 6) return withoutZone
  return Result.try(() => {
    const hostname = new URL(`http://[${withoutZone}]/`).hostname.slice(1, -1)
    const mappedHex = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/iu.exec(
      hostname
    )
    if (!mappedHex?.[1] || !mappedHex[2]) return withoutZone
    const high = Number.parseInt(mappedHex[1], 16)
    const low = Number.parseInt(mappedHex[2], 16)
    return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`
  }).pipe(Result.getOrElse(() => withoutZone))
}
