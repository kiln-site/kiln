// How Kiln lines up against the panels people ask about, for /compare.
// Claims come from each project's own site, docs, and repository; update
// `checkedOn` whenever a row is rechecked.

export const checkedOn = "October 2026"

export type ProductId =
  | "kiln"
  | "pterodactyl"
  | "amp"
  | "coolify"
  | "dokploy"
  | "openship"
  | "portainer"

export interface Product {
  id: ProductId
  name: string
  // What it is, in a few words, under its name in the table.
  kind: string
  url?: string
}

export const products: Array<Product> = [
  { id: "kiln", name: "Kiln", kind: "All of it" },
  {
    id: "pterodactyl",
    name: "Pterodactyl",
    kind: "Game server panel",
    url: "https://pterodactyl.io",
  },
  {
    id: "amp",
    name: "AMP",
    kind: "Game server panel",
    url: "https://cubecoders.com/AMP",
  },
  {
    id: "coolify",
    name: "Coolify",
    kind: "App platform",
    url: "https://coolify.io",
  },
  {
    id: "dokploy",
    name: "Dokploy",
    kind: "App platform",
    url: "https://dokploy.com",
  },
  {
    id: "openship",
    name: "Openship",
    kind: "App platform",
    url: "https://openship.io",
  },
  {
    id: "portainer",
    name: "Portainer",
    kind: "Container manager",
    url: "https://www.portainer.io",
  },
]

export interface Cell {
  level: "yes" | "partly" | "no"
  note?: string
}

export interface Row {
  label: string
  cells: Record<ProductId, Cell>
}

const yes = (note?: string): Cell => ({ level: "yes", note })
const partly = (note: string): Cell => ({ level: "partly", note })
const no = (note?: string): Cell => ({ level: "no", note })

export const rows: Array<Row> = [
  {
    label: "Game servers",
    cells: {
      kiln: yes("Minecraft and Palworld Bricks, or write your own"),
      pterodactyl: yes("Hundreds of community eggs"),
      amp: yes("A long list of games built in"),
      coolify: no("Not built for them"),
      dokploy: no("Not built for them"),
      openship: no("Not built for them"),
      portainer: no("Any container, with no game tooling"),
    },
  },
  {
    label: "Apps from Git, rebuilt on push",
    cells: {
      kiln: yes("Switches over once healthy"),
      pterodactyl: no(),
      amp: no(),
      coolify: yes(),
      dokploy: yes(),
      openship: yes("Detects the stack for you"),
      portainer: partly("Redeploys Compose stacks from Git"),
    },
  },
  {
    label: "Docker images and Compose",
    cells: {
      kiln: yes(),
      pterodactyl: no("Images come from eggs"),
      amp: no(),
      coolify: yes(),
      dokploy: yes(),
      openship: yes(),
      portainer: yes("Plus Swarm and Kubernetes"),
    },
  },
  {
    label: "Databases",
    cells: {
      kiln: yes("MySQL, MariaDB, Postgres, Redis, Valkey"),
      pterodactyl: partly("MySQL databases for game servers"),
      amp: no(),
      coolify: yes(),
      dokploy: yes(),
      openship: yes(),
      portainer: partly("As plain containers"),
    },
  },
  {
    label: "File editor in the browser",
    cells: {
      kiln: yes("With NBT and SQLite editing"),
      pterodactyl: yes(),
      amp: yes(),
      coolify: no(),
      dokploy: no(),
      openship: no(),
      portainer: partly("Browses volumes through its agent"),
    },
  },
  {
    label: "Scheduled backups",
    cells: {
      kiln: yes("To S3-compatible storage"),
      pterodactyl: yes("Local or S3"),
      amp: yes(),
      coolify: partly("Databases"),
      dokploy: yes(),
      openship: yes("Databases and volumes"),
      portainer: no("Backs up only its own settings"),
    },
  },
  {
    label: "Many machines, one panel",
    cells: {
      kiln: yes("Relays can sit behind NAT"),
      pterodactyl: yes("Each node runs Wings"),
      amp: partly("Professional licence and up"),
      coolify: yes("Over SSH"),
      dokploy: yes("Over SSH"),
      openship: yes("Over SSH"),
      portainer: yes("Edge agents can sit behind NAT"),
    },
  },
  {
    label: "Open source",
    cells: {
      kiln: yes("AGPL-3.0"),
      pterodactyl: yes("MIT"),
      amp: no("Proprietary"),
      coolify: yes("Apache-2.0"),
      dokploy: yes("Apache-2.0, with paid parts"),
      openship: yes("Apache-2.0"),
      portainer: partly("Community Edition, zlib"),
    },
  },
  {
    label: "Free to self-host",
    cells: {
      kiln: yes("No limits"),
      pterodactyl: yes(),
      amp: no("One-time licence, priced by instances"),
      coolify: yes(),
      dokploy: partly("SSO, audit logs, and custom roles are paid"),
      openship: yes(),
      portainer: partly("Business Edition is priced by node"),
    },
  },
]

export interface Alternative {
  id: Exclude<ProductId, "kiln">
  summary: string
  // When the other project is the better choice. Say it plainly.
  pickThem: string
  pickKiln: string
}

export const alternatives: Array<Alternative> = [
  {
    id: "pterodactyl",
    summary:
      "The best-known open-source game server panel: a PHP panel and a Go daemon, Wings, on each node, running every server in its own Docker container.",
    pickThem:
      "You only host game servers, and you need a game that already has a community egg but no Brick yet.",
    pickKiln:
      "You also run the website, bot, or database next to the server. Kiln puts them in the same panel, with the same console, files, backups, and access.",
  },
  {
    id: "amp",
    summary:
      "CubeCoders’ commercial game server panel. It runs on Windows or Linux and supports a long list of games, paid for once by how many instances you run.",
    pickThem:
      "Your servers run on Windows, or you need a game Kiln has no Brick for.",
    pickKiln:
      "You want it free and open source, with no cap on instances, and apps and databases in the same panel.",
  },
  {
    id: "coolify",
    summary:
      "A popular open-source alternative to Heroku and Vercel, with hundreds of one-click services and a hosted control plane.",
    pickThem:
      "You only deploy web apps and want the biggest catalog of one-click services.",
    pickKiln:
      "You run game servers too, or want a file editor and console for everything you run.",
  },
  {
    id: "dokploy",
    summary:
      "An open-source platform for deploying apps and databases, with Docker Swarm for clusters and paid enterprise features.",
    pickThem: "You want to spread one app across a Docker Swarm cluster.",
    pickKiln:
      "You run game servers next to your apps, and want every feature without a licence key.",
  },
  {
    id: "openship",
    summary:
      "A newer Apache-2.0 deployment platform that detects your stack and builds it, with a desktop app, CLI, and MCP server.",
    pickThem:
      "You deploy apps and want it to work out the build with no configuration.",
    pickKiln:
      "You run game servers, databases, and apps together, with backups and access for each one.",
  },
  {
    id: "portainer",
    summary:
      "A general-purpose interface for Docker, Swarm, and Kubernetes. It shows you containers, images, networks, and volumes.",
    pickThem:
      "You want direct control of containers and Kubernetes, at the level Docker sees them.",
    pickKiln:
      "You think in game servers, apps, and databases, and want Kiln to handle the containers, ports, and domains.",
  },
]
