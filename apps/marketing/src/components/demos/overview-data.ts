import {
  resourceKey,
  type InfraMapData,
  type InfraMapRelay,
  type InfraMapResource,
} from "@/lib/infra-map-model"

// A small fleet for Hearth's infrastructure map: three machines, each a
// Relay, running a mix of game servers, apps, and databases.

const relays: Array<InfraMapRelay> = [
  {
    id: "home-lab",
    name: "home-lab",
    enabled: true,
    address: "https://10.0.0.20:8443",
    nodeArch: "amd64",
  },
  {
    id: "fsn1-dedicated",
    name: "fsn1-dedicated",
    enabled: true,
    address: "https://fsn1.kiln.site",
    nodeArch: "amd64",
  },
  {
    id: "garage-nuc",
    name: "garage-nuc",
    enabled: true,
    address: "https://192.168.1.40:8443",
    nodeArch: "arm64",
  },
]

const relayNames = new Map(relays.map((relay) => [relay.id, relay.name]))

function resource(
  kind: InfraMapResource["kind"],
  relayId: string,
  id: string,
  name: string,
  meta: string,
  implementation?: string
): InfraMapResource {
  return {
    key: resourceKey(kind, relayId, id),
    kind,
    id,
    relayId,
    relayName: relayNames.get(relayId) ?? relayId,
    name,
    meta,
    routeId: id,
    implementation,
  }
}

const resources = [
  resource(
    "server",
    "home-lab",
    "survival-smp",
    "survival-smp",
    "play.kiln.site",
    "Paper"
  ),
  resource(
    "server",
    "home-lab",
    "creative",
    "creative",
    "play.kiln.site:25566",
    "Paper"
  ),
  resource(
    "database",
    "home-lab",
    "luckperms-db",
    "luckperms-db",
    "MariaDB · 4be1c0d2"
  ),
  resource(
    "server",
    "fsn1-dedicated",
    "velocity-proxy",
    "velocity-proxy",
    "mc.kiln.site",
    "Velocity"
  ),
  resource(
    "app",
    "fsn1-dedicated",
    "community-site",
    "community-site",
    "a81f3e09"
  ),
  resource("app", "fsn1-dedicated", "status-page", "status-page", "6c02d7b4"),
  resource(
    "database",
    "fsn1-dedicated",
    "postgres",
    "postgres",
    "PostgreSQL · 0d9a33f1"
  ),
  resource(
    "server",
    "garage-nuc",
    "palworld",
    "palworld",
    "pal.kiln.site:8211",
    "Palworld"
  ),
  resource("app", "garage-nuc", "discord-bot", "discord-bot", "f4471a6e"),
  resource("database", "garage-nuc", "redis", "redis", "Redis · 93ce12a7"),
]

export const demoFleet: InfraMapData = {
  hearthHost: "panel.kiln.site",
  provider: null,
  relays,
  resources,
  domains: null,
  proxyModes: new Map([["fsn1-dedicated", "traefik"]]),
  databaseLinks: [
    {
      relayId: "home-lab",
      consumer: { kind: "server", id: "survival-smp" },
      databaseId: "luckperms-db",
    },
    {
      relayId: "home-lab",
      consumer: { kind: "server", id: "creative" },
      databaseId: "luckperms-db",
    },
    {
      relayId: "fsn1-dedicated",
      consumer: { kind: "app", id: "community-site" },
      databaseId: "postgres",
    },
    {
      relayId: "garage-nuc",
      consumer: { kind: "app", id: "discord-bot" },
      databaseId: "redis",
    },
  ],
  webRoutes: new Map([
    [
      "fsn1-dedicated",
      [
        {
          hostname: "kiln.site",
          path: null,
          owner: { kind: "app", id: "community-site", service: "web" },
        },
        {
          hostname: "status.kiln.site",
          path: null,
          owner: { kind: "app", id: "status-page" },
        },
      ],
    ],
  ]),
  appServices: new Map([
    [
      resourceKey("app", "fsn1-dedicated", "community-site"),
      [
        {
          name: "web",
          image: "ghcr.io/smp/site:latest",
          running: 2,
          containers: 2,
          databaseIds: ["postgres"],
        },
        {
          name: "worker",
          image: "ghcr.io/smp/site:latest",
          running: 1,
          containers: 1,
          databaseIds: ["postgres"],
        },
      ],
    ],
  ]),
}

// What each Relay's machine reports, as Hearth's map shows it.
export const relayReadings: Record<
  string,
  { cpu: number; memory: number; disk: number }
> = {
  "home-lab": { cpu: 34, memory: 71, disk: 46 },
  "fsn1-dedicated": { cpu: 18, memory: 52, disk: 29 },
  "garage-nuc": { cpu: 61, memory: 83, disk: 64 },
}

// The game servers that aren't running.
export const stoppedResources = new Set(["creative"])
