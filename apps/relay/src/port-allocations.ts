import {
  relayInstanceCustomRouteLabelSchema,
  relayInstancePortIdSchema,
  relayInstancePortMetadataListSchema,
} from "@workspace/contracts"
import { Option, Schema } from "effect"
import type {
  RelayInstancePortAllocation,
  RelayInstancePortMetadata,
  RelayInstancePortProtocol,
} from "@workspace/contracts"

export const INSTANCE_CUSTOM_ROUTE_LABEL_PREFIX = "kiln.instance.custom-routes."
export const PRIMARY_PORT_LABEL = "kiln.brick.primary-port"

const LEGACY_INSTANCE_PORT_ALLOCATIONS_LABEL = "kiln.instance.ports"
const LEGACY_PRIMARY_PORT_PROTOCOL_LABEL = "kiln.brick.primary-port-protocol"
const decodeJsonOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown)
)

type PortBindings = Readonly<
  Record<
    string,
    ReadonlyArray<{ HostIp?: string; HostPort?: string }> | null | undefined
  >
>

interface RecoverablePortMetadata extends RelayInstancePortMetadata {
  labelledPublicPort?: number
}

export function portProtocols(
  protocol: RelayInstancePortProtocol
): ReadonlyArray<"tcp" | "udp"> {
  return protocol === "both" ? ["tcp", "udp"] : [protocol]
}

export function portAllocationContainerLabels(
  allocations: ReadonlyArray<RelayInstancePortAllocation>
): Record<string, string> {
  const primary = allocations.find(
    (allocation) => allocation.kind === "primary"
  )
  if (!primary) throw new Error("The primary game port is required")

  return Object.fromEntries([
    [
      PRIMARY_PORT_LABEL,
      primary.protocol === "both"
        ? String(primary.internalPort)
        : `${primary.internalPort}/${primary.protocol}`,
    ],
    ...allocations
      .filter((allocation) => allocation.kind !== "primary")
      .map((allocation): [string, string] => [
        `${INSTANCE_CUSTOM_ROUTE_LABEL_PREFIX}${allocation.id}`,
        JSON.stringify({
          internal: allocation.internalPort,
          name: allocation.name,
          protocol: allocation.protocol,
          public: allocation.externalPort,
        }),
      ]),
  ])
}

export function portLabelsRequireRestart(
  current: Readonly<Record<string, string>>,
  desired: Readonly<Record<string, string>>
): boolean {
  const currentManaged = Object.fromEntries(
    Object.entries(current).filter(([label]) => isManagedPortLabel(label))
  )
  return (
    JSON.stringify(sortedEntries(currentManaged)) !==
    JSON.stringify(sortedEntries(desired))
  )
}

export function dockerPortBindingsForAllocations(
  allocations: ReadonlyArray<RelayInstancePortAllocation>
): Record<string, Array<{ HostIp: string; HostPort: string }>> {
  return Object.fromEntries(
    allocations.flatMap((allocation) =>
      portProtocols(allocation.protocol).map((protocol) => [
        `${allocation.internalPort}/${protocol}`,
        [
          {
            HostIp: "",
            HostPort: String(allocation.externalPort),
          },
        ],
      ])
    )
  )
}

export function discoverPortAllocations(input: {
  bindings: PortBindings | undefined
  labels: Readonly<Record<string, string | undefined>>
}): Array<RelayInstancePortAllocation> {
  const configured = recoverablePortMetadata(input.labels)
  if (configured.length === 0) return []

  return configured
    .flatMap((allocation): Array<RelayInstancePortAllocation> => {
      const externalPort =
        discoverPublishedPort(
          input.bindings,
          allocation.internalPort,
          allocation.protocol
        ) ?? allocation.labelledPublicPort
      if (!externalPort) return []
      const { labelledPublicPort: _labelledPublicPort, ...metadata } =
        allocation
      return [{ ...metadata, externalPort }]
    })
    .sort((left, right) => {
      if (left.kind === "primary") return -1
      if (right.kind === "primary") return 1
      return left.id.localeCompare(right.id)
    })
}

export function isManagedPortLabel(label: string): boolean {
  return (
    label === PRIMARY_PORT_LABEL ||
    label === LEGACY_INSTANCE_PORT_ALLOCATIONS_LABEL ||
    label === LEGACY_PRIMARY_PORT_PROTOCOL_LABEL ||
    label.startsWith(INSTANCE_CUSTOM_ROUTE_LABEL_PREFIX)
  )
}

function recoverablePortMetadata(
  labels: Readonly<Record<string, string | undefined>>
): Array<RecoverablePortMetadata> {
  const legacy = parseLegacyPortMetadata(
    labels[LEGACY_INSTANCE_PORT_ALLOCATIONS_LABEL]
  )
  if (
    legacy.length > 0 &&
    labels[LEGACY_PRIMARY_PORT_PROTOCOL_LABEL] !== undefined
  ) {
    return legacy
  }

  const primary = parsePrimaryPortLabel(
    labels[PRIMARY_PORT_LABEL],
    labels[LEGACY_PRIMARY_PORT_PROTOCOL_LABEL]
  )
  const routes = Object.entries(labels)
    .filter(([label]) => label.startsWith(INSTANCE_CUSTOM_ROUTE_LABEL_PREFIX))
    .flatMap(([label, value]): Array<RecoverablePortMetadata> => {
      const id = relayInstancePortIdSchema.safeParse(
        label.slice(INSTANCE_CUSTOM_ROUTE_LABEL_PREFIX.length)
      )
      if (!id.success || id.data === "primary" || value === undefined) return []
      const decoded = Option.getOrUndefined(decodeJsonOption(value))
      const route = relayInstanceCustomRouteLabelSchema.safeParse(decoded)
      if (!route.success) return []
      return [
        {
          id: id.data,
          internalPort: route.data.internal,
          kind: id.data.startsWith("brick-") ? "brick" : "custom",
          labelledPublicPort: route.data.public,
          name: route.data.name,
          protocol: route.data.protocol,
        },
      ]
    })

  if (primary || routes.length > 0) {
    return [...(primary ? [primary] : []), ...routes]
  }
  return legacy
}

function parsePrimaryPortLabel(
  label: string | undefined,
  legacyProtocolLabel: string | undefined
): RecoverablePortMetadata | undefined {
  const match = label?.match(/^(\d{1,5})(?:\/(tcp|udp))?$/u)
  if (!match) return undefined
  const internalPort = Number(match[1])
  if (
    !Number.isInteger(internalPort) ||
    internalPort < 1 ||
    internalPort > 65_535
  ) {
    return undefined
  }
  return {
    id: "primary",
    internalPort,
    kind: "primary",
    name: "Default Server",
    protocol:
      match[2] === "tcp" || match[2] === "udp"
        ? match[2]
        : legacyProtocolLabel === "tcp" || legacyProtocolLabel === "udp"
          ? legacyProtocolLabel
          : "both",
  }
}

function parseLegacyPortMetadata(
  label: string | undefined
): Array<RecoverablePortMetadata> {
  if (!label) return []
  const value = Option.getOrUndefined(decodeJsonOption(label))
  const parsed = relayInstancePortMetadataListSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}

function discoverPublishedPort(
  bindings: PortBindings | undefined,
  internalPort: number,
  protocol: RelayInstancePortProtocol
): number | undefined {
  const published = portProtocols(protocol).map((candidate) =>
    bindingPublicPort(bindings?.[`${internalPort}/${candidate}`])
  )
  if (published.some((port) => port === undefined)) return undefined
  const first = published[0]
  return first && published.every((port) => port === first) ? first : undefined
}

function bindingPublicPort(
  candidates:
    | ReadonlyArray<{ HostIp?: string; HostPort?: string }>
    | null
    | undefined
): number | undefined {
  return candidates
    ?.map((candidate) => Number(candidate.HostPort))
    .find(
      (candidate) =>
        Number.isInteger(candidate) && candidate >= 1 && candidate <= 65_535
    )
}

function sortedEntries(
  labels: Readonly<Record<string, string>>
): Array<[string, string]> {
  return Object.entries(labels).sort(([left], [right]) =>
    left.localeCompare(right)
  )
}
