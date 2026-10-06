import { createHash } from "node:crypto"

import type {
  RelayNetworking,
  RelayTailscaleSettings,
  RelayTailscaleStackConfig,
} from "@workspace/contracts"
import {
  relayTailscaleStackConfigSchema,
  relayTailscaleStackDnsSchema,
} from "@workspace/contracts"

/**
 * Private networking for Relay servers: CoreDNS zones, Tailscale stack subnet
 * and address allocation, the stack forwarding allowlist, and its DNS records.
 */

export const TAILSCALE_STACK_FORWARD_CHAIN = "KILN-TAILSCALE"
const TAILSCALE_STACK_SUBNET_COUNT = 64 * 256

export function tailscaleStackFirewallRules(
  bindings: ReadonlyArray<
    Pick<RelayTailscaleStackConfig["bindings"][number], "address">
  >
): Array<Array<string>> {
  return [
    ...bindings.map(({ address }) => [
      "-A",
      TAILSCALE_STACK_FORWARD_CHAIN,
      "-d",
      `${address}/32`,
      "-j",
      // Continue through Tailscale's own forwarding chain so it can mark the
      // packet for masquerading. ACCEPT here would bypass that return path.
      "RETURN",
    ]),
    ["-A", TAILSCALE_STACK_FORWARD_CHAIN, "-j", "DROP"],
  ]
}

export function tailscaleStackFirewallIsCurrent(
  hookExists: boolean,
  specification: string,
  bindings: ReadonlyArray<
    Pick<RelayTailscaleStackConfig["bindings"][number], "address">
  >
): boolean {
  if (!hookExists) return false
  const current = specification
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`-A ${TAILSCALE_STACK_FORWARD_CHAIN} `))
  const expected = tailscaleStackFirewallRules(bindings).map((rule) =>
    rule.join(" ")
  )
  return (
    current.length === expected.length &&
    current.every((line, index) => line === expected[index])
  )
}

function coreDnsHostnamePattern(
  domain: string,
  hostnames: ReadonlyArray<string>
): string {
  const suffix = `.${domain}`
  const names = Array.from(
    new Set(
      hostnames
        .map((hostname) => hostname.toLowerCase().replace(/\.$/u, ""))
        .filter((hostname) => hostname.endsWith(suffix))
    )
  ).sort()
  return names.length === 0
    ? "^$"
    : `(?i)^(?:${names.map(escapeRegex).join("|")})[.]$`
}

export function coreDnsConfiguration(
  networking: RelayNetworking,
  hostnames: ReadonlyArray<string>
): string {
  const pattern = coreDnsHostnamePattern(networking.domain, hostnames)
  return `${networking.domain}:${networking.dnsPort} {\n    errors\n    template IN A {\n        match "${pattern}"\n        answer "{{ .Name }} 60 IN A {$KILN_NODE_ADDRESS}"\n    }\n    template IN AAAA {\n        match "${pattern}"\n        rcode NOERROR\n    }\n}\n`
}

export function tailscaleCoreDnsConfiguration(
  settings: RelayTailscaleSettings,
  address: string,
  hostnames: ReadonlyArray<string>
): string {
  const pattern = coreDnsHostnamePattern(settings.domain, hostnames)
  return `${settings.domain}:${settings.dnsPort} {\n    bind ${address}\n    errors\n    template IN A {\n        match "${pattern}"\n        answer "{{ .Name }} 60 IN A ${address}"\n    }\n    template IN AAAA {\n        match "${pattern}"\n        rcode NOERROR\n    }\n}\n`
}

export function allocateTailscaleStackSubnet(
  stackId: string,
  nodeId: string,
  reserved: ReadonlySet<string>
): string {
  const digest = createHash("sha256").update(`${stackId}:${nodeId}`).digest()
  const start =
    (((digest[0] ?? 0) << 8) | (digest[1] ?? 0)) % TAILSCALE_STACK_SUBNET_COUNT
  const stepSeed = ((digest[2] ?? 0) << 8) | (digest[3] ?? 0)
  const step = (stepSeed % (TAILSCALE_STACK_SUBNET_COUNT / 2)) * 2 + 1
  for (let offset = 0; offset < TAILSCALE_STACK_SUBNET_COUNT; offset += 1) {
    const index = (start + offset * step) % TAILSCALE_STACK_SUBNET_COUNT
    const subnet = `10.${128 + Math.floor(index / 256)}.${index % 256}.0/24`
    if (!reserved.has(subnet)) return subnet
  }
  throw new Error("No private Tailscale subnets remain on this Relay")
}

export function tailscaleStackServiceAddress(subnet: string): string {
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
    hostname: string
    instanceId: string
  }>,
  desired: ReadonlyArray<{
    enabled?: boolean
    hostname: string
    instanceId: string
  }>
): Array<{
  address: string
  enabled: boolean
  hostname: string
  instanceId: string
}> {
  const desiredInstanceIds = new Set(
    desired.map(({ instanceId }) => instanceId)
  )
  const previousByInstance = new Map(
    existing.map((binding) => [binding.instanceId, binding])
  )
  const reserved = new Set(
    existing
      .filter(({ instanceId }) => desiredInstanceIds.has(instanceId))
      .map(({ address }) => address)
  )

  return desired.map((binding) => {
    const previous = previousByInstance.get(binding.instanceId)
    return {
      ...binding,
      address:
        previous?.address ?? allocateTailscaleBindingAddress(subnet, reserved),
      enabled: binding.enabled ?? true,
    }
  })
}

export function activeTailscaleStackBindings<
  TBinding extends { enabled: boolean },
>(bindings: ReadonlyArray<TBinding>): Array<TBinding> {
  return bindings.filter((binding) => binding.enabled)
}

export function tailscaleStackWithoutInstance(
  config: RelayTailscaleStackConfig,
  records: ReadonlyArray<{ address: string; hostname: string }>,
  instanceId: string
): {
  config: RelayTailscaleStackConfig
  records: Array<{ address: string; hostname: string }>
} {
  const removedAddresses = new Set(
    config.bindings
      .filter((binding) => binding.instanceId === instanceId)
      .map(({ address }) => address)
  )
  return {
    config: relayTailscaleStackConfigSchema.parse({
      ...config,
      bindings: config.bindings.filter(
        (binding) => binding.instanceId !== instanceId
      ),
    }),
    records: records.filter((record) => !removedAddresses.has(record.address)),
  }
}

export function tailscaleStackCoreDnsConfiguration(
  domain: string,
  records: ReadonlyArray<{ address: string; hostname: string }>
): string {
  const entries = [...records]
    .sort((left, right) => left.hostname.localeCompare(right.hostname))
    .map(
      ({ address, hostname }) =>
        `        ${address} ${hostname.replace(/\.$/u, "")}.${domain}`
    )
    .join("\n")
  return `${domain}:53 {\n    errors\n    cache 30\n    hosts {\n${entries}${entries ? "\n" : ""}        ttl 60\n    }\n}\n`
}

export function tailscaleStackCoreDnsRecords(
  domain: string,
  configuration: string
): Array<{ address: string; hostname: string }> {
  const suffix = `.${domain}`
  const records = configuration
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .flatMap(([address, name]) => {
      if (!address || !name || !name.endsWith(suffix)) return []
      return [
        {
          address,
          hostname: name.slice(0, -suffix.length),
        },
      ]
    })
  return relayTailscaleStackDnsSchema.parse({
    id: "0".repeat(40),
    records,
  }).records
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}
