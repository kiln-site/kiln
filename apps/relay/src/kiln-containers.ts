/**
 * Which containers on the Relay's host are Kiln's, and whose: the Relay's
 * own and its services, and each App's, database's, and game server's.
 * The security inventory scans what's Kiln's, and the Docker cleanup keeps
 * track of the images they run (docker-cleanup.ts).
 */
import { hostname } from "node:os"

import type { RelaySecurityContainer } from "@workspace/contracts"

import type { RelayConfig } from "./config.js"
import { containerName } from "./docker-engine.js"
import { PLATFORM_ROLE_LABEL } from "./platform.js"
import { relayOwnsLabels, relayResourceNames } from "./relay-resources.js"

export type KilnContainerOwner = Pick<
  RelaySecurityContainer,
  "component" | "resource"
>

export function kilnContainerOwner(
  config: Pick<
    RelayConfig,
    "mode" | "resourceNamespace" | "selfContainer" | "serverIdLabel"
  >,
  container: {
    readonly Id: string
    readonly Labels: Readonly<Record<string, string>> | null
    readonly Names: ReadonlyArray<string>
  }
): KilnContainerOwner | null {
  const name = containerName(container)
  const relay = (component: string) => ({
    component,
    resource: { id: "relay", type: "relay" as const },
  })
  const self = config.selfContainer ?? hostname()
  if (name === self || container.Id.startsWith(self)) return relay("Relay")
  const labels = container.Labels ?? {}
  if (!relayOwnsLabels(config, labels)) return null
  const appId = labels["kiln.app.id"]
  if (appId) {
    return {
      component: labels["kiln.app.service"] ?? null,
      resource: { id: appId, type: "app" },
    }
  }
  const databaseId = labels["kiln.database.id"]
  if (databaseId) {
    return { component: null, resource: { id: databaseId, type: "database" } }
  }
  const serverId = labels[config.serverIdLabel]
  if (serverId && labels["kiln.relay.managed"] === "true") {
    return {
      component: null,
      resource: { id: serverId.toLowerCase(), type: "instance" },
    }
  }
  const names = relayResourceNames(config)
  const service = new Map([
    [names.traefikContainer, "Traefik"],
    [names.coreDnsContainer, "CoreDNS"],
    [names.tailscaleContainer, "Tailscale"],
    [names.limboContainer, "Limbo"],
  ]).get(name)
  if (service) return relay(service)
  if (labels["kiln.relay.infrastructure"] === "desktop") return relay("Desktop")
  const role = labels[PLATFORM_ROLE_LABEL]
  if (config.mode === "platform" && role) {
    const platform = { cache: "Valkey", database: "MySQL", hearth: "Hearth" }
    const component = platform[role as keyof typeof platform]
    if (component) return relay(component)
  }
  return null
}
