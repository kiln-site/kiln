import { createHash } from "node:crypto"

import type { TunnelConfig } from "@workspace/contracts"
import { tunnelConfigSchema } from "@workspace/contracts"

/**
 * Tunnels' private networking: subnet and address allocation, the
 * forwarding allowlist, and their DNS files.
 */

export const TUNNEL_FORWARD_CHAIN = "KILN-TAILSCALE"
const TUNNEL_SUBNET_COUNT = 64 * 256

export function tunnelFirewallRules(
  bindings: ReadonlyArray<Pick<TunnelConfig["bindings"][number], "address">>
): Array<Array<string>> {
  return [
    ...bindings.map(({ address }) => [
      "-A",
      TUNNEL_FORWARD_CHAIN,
      "-d",
      `${address}/32`,
      "-j",
      // Continue through Tailscale's own forwarding chain so it can mark the
      // packet for masquerading. ACCEPT here would bypass that return path.
      "RETURN",
    ]),
    ["-A", TUNNEL_FORWARD_CHAIN, "-j", "DROP"],
  ]
}

export function tunnelFirewallIsCurrent(
  hookExists: boolean,
  specification: string,
  bindings: ReadonlyArray<Pick<TunnelConfig["bindings"][number], "address">>
): boolean {
  if (!hookExists) return false
  const current = specification
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`-A ${TUNNEL_FORWARD_CHAIN} `))
  const expected = tunnelFirewallRules(bindings).map((rule) => rule.join(" "))
  return (
    current.length === expected.length &&
    current.every((line, index) => line === expected[index])
  )
}

export function allocateTunnelSubnet(
  stackId: string,
  nodeId: string,
  reserved: ReadonlySet<string>
): string {
  const digest = createHash("sha256").update(`${stackId}:${nodeId}`).digest()
  const start =
    (((digest[0] ?? 0) << 8) | (digest[1] ?? 0)) % TUNNEL_SUBNET_COUNT
  const stepSeed = ((digest[2] ?? 0) << 8) | (digest[3] ?? 0)
  const step = (stepSeed % (TUNNEL_SUBNET_COUNT / 2)) * 2 + 1
  for (let offset = 0; offset < TUNNEL_SUBNET_COUNT; offset += 1) {
    const index = (start + offset * step) % TUNNEL_SUBNET_COUNT
    const subnet = `10.${128 + Math.floor(index / 256)}.${index % 256}.0/24`
    if (!reserved.has(subnet)) return subnet
  }
  throw new Error("No private Tailscale subnets remain on this Relay")
}

export function tunnelServiceAddress(subnet: string): string {
  const prefix = subnet.replace(/\.0\/24$/u, "")
  if (prefix === subnet) throw new Error(`Invalid Tailscale subnet ${subnet}`)
  return `${prefix}.2`
}

function allocateTailscaleBindingAddress(
  subnet: string,
  reserved: Set<string>
): string {
  const prefix = subnet.replace(/\.0\/24$/u, "")
  if (prefix === subnet) throw new Error(`Invalid Tailscale subnet ${subnet}`)
  for (let host = 10; host <= 254; host += 1) {
    const address = `${prefix}.${host}`
    if (reserved.has(address)) continue
    reserved.add(address)
    return address
  }
  throw new Error(
    `Tailscale subnet ${subnet} has no available server addresses`
  )
}

export function assignTailscaleBindingAddresses(
  subnet: string,
  existing: ReadonlyArray<{
    address: string
    enabled?: boolean
    memberId: string
  }>,
  desired: ReadonlyArray<{
    enabled?: boolean
    memberId: string
  }>
): Array<{
  address: string
  enabled: boolean
  memberId: string
}> {
  const desiredMemberIds = new Set(desired.map(({ memberId }) => memberId))
  const previousByMember = new Map(
    existing.map((binding) => [binding.memberId, binding])
  )
  const reserved = new Set(
    existing
      .filter(({ memberId }) => desiredMemberIds.has(memberId))
      .map(({ address }) => address)
  )

  return desired.map((binding) => {
    const previous = previousByMember.get(binding.memberId)
    return {
      ...binding,
      address:
        previous?.address ?? allocateTailscaleBindingAddress(subnet, reserved),
      enabled: binding.enabled ?? true,
    }
  })
}

export function activeTunnelBindings<TBinding extends { enabled: boolean }>(
  bindings: ReadonlyArray<TBinding>
): Array<TBinding> {
  return bindings.filter((binding) => binding.enabled)
}

// The stack without the members that match. Their DNS records are Hearth's
// to drop, with every node's.
export function tunnelWithoutMembers(
  config: TunnelConfig,
  matches: (memberId: string) => boolean
): TunnelConfig {
  return tunnelConfigSchema.parse({
    ...config,
    bindings: config.bindings.filter((binding) => !matches(binding.memberId)),
  })
}

/**
 * A tunnel's Corefile: its tailnet's TLDs, answered from its hosts file,
 * which CoreDNS reads again by itself as it changes. CoreDNS also watches
 * the Corefile and reloads it gracefully, keeping the old one if the new one
 * fails, so a change to either never restarts it.
 */
export function tunnelCorefile(domains: ReadonlyArray<string>): string {
  const zones = domains.map((domain) => `${domain}:53`).join(" ")
  return `${zones} {\n    errors\n    cache 30\n    hosts ${TUNNEL_DNS_MOUNT}/hosts {\n        ttl 60\n    }\n    reload 4s 1s\n}\n`
}

/** A tunnel's records, as the hosts file its CoreDNS answers from. */
export function tunnelHostsFile(
  records: ReadonlyArray<{ address: string; name: string }>
): string {
  return [...records]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ address, name }) => `${address} ${name}\n`)
    .join("")
}

/** Where a tunnel's CoreDNS finds its Corefile and hosts file. */
export const TUNNEL_DNS_MOUNT = "/etc/coredns"

// A tunnel's Corefile from before it answered from a hosts file, with its
// records inline under one domain: read once, as its tunnel moves on.
export function tunnelCoreDnsRecords(
  domain: string,
  configuration: string
): Array<{ address: string; hostname: string }> {
  const suffix = `.${domain}`
  return configuration
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .flatMap(([address, name]) =>
      address && name?.endsWith(suffix) && /^\d+\.\d+\.\d+\.\d+$/u.test(address)
        ? [{ address, hostname: name.slice(0, -suffix.length) }]
        : []
    )
}
