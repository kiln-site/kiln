// How Kiln lines up against the panels people ask about, for /compare.
// Claims come from each project's own site, docs, and repository; update
// `checkedOn` whenever a row is rechecked.

export const checkedOn = { label: "October 2026", iso: "2026-10-27" }

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
  url?: string
}

export const products: Array<Product> = [
  { id: "kiln", name: "Kiln" },
  { id: "pterodactyl", name: "Pterodactyl", url: "https://pterodactyl.io" },
  { id: "amp", name: "AMP", url: "https://cubecoders.com/AMP" },
  { id: "coolify", name: "Coolify", url: "https://coolify.io" },
  { id: "dokploy", name: "Dokploy", url: "https://dokploy.com" },
  { id: "openship", name: "Openship", url: "https://openship.io" },
  { id: "portainer", name: "Portainer", url: "https://www.portainer.io" },
]

// Read at a glance, so no notes: full, partial, barely, or none. "weak" is
// for support that exists but falls well short.
export type Level = "yes" | "partly" | "weak" | "no"

export interface Row {
  label: string
  cells: Record<ProductId, Level>
  // Who does this best, highlighted in the chart. Kiln unless said otherwise.
  best?: Array<ProductId>
  // Why a cell is only "partly" or "weak", shown when it's hovered or tapped.
  // Every partial cell needs one.
  notes?: Partial<Record<ProductId, string>>
}

const noGameTooling =
  "No game server tooling. It can run one as a plain Docker container, but you set up the image, ports, and updates yourself."

// Only rows where the projects differ. Anything that runs Docker can run a
// game server, so "partly" there means without game tooling.
export const rows: Array<Row> = [
  {
    label: "Game servers",
    notes: {
      coolify: noGameTooling,
      dokploy: noGameTooling,
      openship: noGameTooling,
      portainer: noGameTooling,
    },
    cells: {
      kiln: "yes",
      pterodactyl: "yes",
      amp: "yes",
      coolify: "weak",
      dokploy: "weak",
      openship: "weak",
      portainer: "weak",
    },
  },
  {
    label: "Apps from Git",
    notes: {
      portainer:
        "Redeploys Compose stacks from a Git repository, but doesn't build your code.",
    },
    cells: {
      kiln: "yes",
      pterodactyl: "no",
      amp: "no",
      coolify: "yes",
      dokploy: "yes",
      openship: "yes",
      portainer: "partly",
    },
  },
  {
    label: "Databases",
    notes: {
      pterodactyl:
        "Creates MySQL databases for game servers to use, not database servers of their own.",
      portainer:
        "Runs a database as a plain container, without backups or connection details set up for you.",
    },
    cells: {
      kiln: "yes",
      pterodactyl: "partly",
      amp: "no",
      coolify: "yes",
      dokploy: "yes",
      openship: "yes",
      portainer: "partly",
    },
  },
  {
    label: "Manage your VPS",
    notes: {
      coolify: "A terminal on each server, but no host files.",
      dokploy: "A terminal on each server, but no host files.",
      portainer: "Host details, but no terminal on the host itself.",
    },
    cells: {
      kiln: "yes",
      pterodactyl: "no",
      amp: "no",
      coolify: "partly",
      dokploy: "partly",
      openship: "no",
      portainer: "partly",
    },
  },
  {
    // How big the catalog is, not whether there is one.
    label: "1-click catalog",
    notes: {
      kiln: "Only a few so far.",
      openship: "About 40 templates so far.",
      portainer: "A short list of templates.",
    },
    best: ["pterodactyl", "coolify"],
    cells: {
      kiln: "partly",
      pterodactyl: "yes",
      amp: "yes",
      coolify: "yes",
      dokploy: "yes",
      openship: "partly",
      portainer: "partly",
    },
  },
  {
    label: "File editor",
    notes: {
      portainer:
        "Browses volumes through its agent, but isn't a full file editor.",
    },
    cells: {
      kiln: "yes",
      pterodactyl: "yes",
      amp: "yes",
      coolify: "yes",
      dokploy: "no",
      openship: "no",
      portainer: "partly",
    },
  },
  {
    label: "Scheduled backups",
    cells: {
      kiln: "yes",
      pterodactyl: "yes",
      amp: "yes",
      coolify: "yes",
      dokploy: "yes",
      openship: "yes",
      portainer: "no",
    },
  },
  {
    label: "Permissions",
    notes: {
      coolify:
        "Team-wide roles only, so you can't limit someone to one app or server.",
      dokploy:
        "Members can be limited to projects and services. Custom roles are a paid feature.",
      openship:
        "An organization shares its projects with its members, without finer roles.",
      portainer:
        "Teams can be given environments. Role-based access is in the paid Business Edition.",
    },
    cells: {
      kiln: "yes",
      pterodactyl: "yes",
      amp: "yes",
      coolify: "weak",
      dokploy: "partly",
      openship: "partly",
      portainer: "partly",
    },
  },
  {
    label: "Automatic DNS",
    cells: {
      kiln: "yes",
      pterodactyl: "no",
      amp: "no",
      coolify: "yes",
      dokploy: "no",
      openship: "no",
      portainer: "no",
    },
  },
  {
    label: "Updates from the panel",
    notes: {
      portainer: "Upgrading from the panel is in the paid Business Edition.",
    },
    cells: {
      kiln: "yes",
      pterodactyl: "no",
      amp: "yes",
      coolify: "yes",
      dokploy: "yes",
      openship: "no",
      portainer: "partly",
    },
  },
  {
    label: "Vulnerability scanning",
    notes: {
      coolify: "Limited checks, not a scan of every host and image you run.",
      portainer: "Image scanning is in the paid Business Edition.",
    },
    cells: {
      kiln: "yes",
      pterodactyl: "no",
      amp: "no",
      coolify: "weak",
      dokploy: "no",
      openship: "no",
      portainer: "partly",
    },
  },
  {
    label: "Swarm or Kubernetes",
    notes: {
      coolify:
        "Docker Swarm support is experimental, and there's no Kubernetes.",
    },
    best: ["dokploy", "portainer"],
    cells: {
      kiln: "no",
      pterodactyl: "no",
      amp: "no",
      coolify: "weak",
      dokploy: "yes",
      openship: "no",
      portainer: "yes",
    },
  },
  {
    label: "Runs on Windows",
    best: ["amp", "portainer"],
    cells: {
      kiln: "no",
      pterodactyl: "no",
      amp: "yes",
      coolify: "no",
      dokploy: "no",
      openship: "no",
      portainer: "yes",
    },
  },
  {
    label: "Free and open source",
    notes: {
      dokploy:
        "Apache-2.0, but SSO, audit logs, and custom roles need a paid license.",
      portainer:
        "The Community Edition is open source. The Business Edition is paid per node.",
    },
    cells: {
      kiln: "yes",
      pterodactyl: "yes",
      amp: "no",
      coolify: "yes",
      dokploy: "partly",
      openship: "yes",
      portainer: "partly",
    },
  },
]

export interface Alternative {
  id: Exclude<ProductId, "kiln">
  summary: string
  // When the other project is the better choice. Say it plainly.
  pickThem: string
}

// Only the projects there's a real reason to choose over Kiln. Coolify and
// Openship cover the same ground for apps, so they get no card.
export const alternatives: Array<Alternative> = [
  {
    id: "pterodactyl",
    summary:
      "The game server panel most hosts already know. It has been around for years, is widely adopted, and has a big community behind it.",
    pickThem:
      "You want the most proven option, with years of community answers and a large catalog of extensions, plugins, and eggs.",
  },
  {
    id: "amp",
    summary:
      "CubeCoders’ commercial game server panel, paid for once by how many instances you run.",
    pickThem:
      "Your servers run on Windows, and you want a simple, easy solution that works out of the box.",
  },
  {
    id: "dokploy",
    summary:
      "An app platform built on Docker Swarm, for spreading apps across a cluster.",
    pickThem: "You want to shard apps across a Docker Swarm cluster.",
  },
  {
    id: "portainer",
    summary:
      "A general-purpose interface for Docker, Swarm, and Kubernetes, at the level of containers, images, and volumes.",
    pickThem:
      "You run Kubernetes or Docker Swarm and want to manage it directly.",
  },
]

const levelSuffix: Record<Level, string | null> = {
  yes: "",
  partly: "partly",
  weak: "barely",
  no: null,
}

// The page's chart and cards as schema.org data, so search engines and AI
// assistants read the same comparison people see.
export function bestAt(row: Row): Array<ProductId> {
  return row.best ?? ["kiln"]
}

export function comparisonStructuredData({
  description,
  siteUrl,
  title,
}: {
  description: string
  siteUrl: string
  title: string
}) {
  const url = `${siteUrl}/compare`
  const productsById = new Map(products.map((product) => [product.id, product]))
  const questions = alternatives.flatMap((alternative) => {
    const name = productsById.get(alternative.id)?.name
    if (!name) return []
    return [
      {
        "@type": "Question",
        name: `When should I pick ${name} instead of Kiln?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `${alternative.summary} Pick ${name} if: ${alternative.pickThem}`,
        },
      },
    ]
  })

  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": url,
        about: { "@type": "SoftwareApplication", name: "Kiln", url: siteUrl },
        dateModified: checkedOn.iso,
        description,
        isPartOf: { "@id": `${siteUrl}/#website` },
        mainEntity: { "@id": `${url}#features` },
        name: title,
        url,
      },
      {
        "@type": "ItemList",
        "@id": `${url}#features`,
        name: "Features of Kiln and the panels it's compared with",
        itemListElement: products.map((product, index) => ({
          "@type": "ListItem",
          position: index + 1,
          item: {
            "@type": "SoftwareApplication",
            applicationCategory: "DeveloperApplication",
            featureList: rows.flatMap((row) => {
              const suffix = levelSuffix[row.cells[product.id]]
              if (suffix === null) return []
              if (!suffix) return [row.label]
              const note = row.notes?.[product.id]
              return [`${row.label} (${suffix}${note ? `: ${note}` : ""})`]
            }),
            name: product.name,
            url: product.url ?? siteUrl,
          },
        })),
      },
      {
        "@type": "FAQPage",
        "@id": `${url}#questions`,
        mainEntity: questions,
      },
    ],
  })
}
