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

// Read at a glance, so no notes: full, partial, or none.
export type Level = "yes" | "partly" | "no"

export interface Row {
  label: string
  cells: Record<ProductId, Level>
  // Who does this best, highlighted in the chart. Kiln unless said otherwise.
  best?: Array<ProductId>
}

// Only rows where the projects differ. Anything that runs Docker can run a
// game server, so "partly" there means without game tooling.
export const rows: Array<Row> = [
  {
    label: "Game servers",
    cells: {
      kiln: "yes",
      pterodactyl: "yes",
      amp: "yes",
      coolify: "partly",
      dokploy: "partly",
      openship: "partly",
      portainer: "partly",
    },
  },
  {
    label: "Apps from Git",
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
    label: "1-click apps and servers",
    best: ["pterodactyl", "coolify"],
    cells: {
      kiln: "partly",
      pterodactyl: "yes",
      amp: "yes",
      coolify: "yes",
      dokploy: "yes",
      openship: "no",
      portainer: "partly",
    },
  },
  {
    label: "File editor",
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
    cells: {
      kiln: "yes",
      pterodactyl: "yes",
      amp: "yes",
      coolify: "partly",
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
    cells: {
      kiln: "yes",
      pterodactyl: "no",
      amp: "no",
      coolify: "partly",
      dokploy: "no",
      openship: "no",
      portainer: "partly",
    },
  },
  {
    label: "Swarm or Kubernetes",
    best: ["dokploy", "portainer"],
    cells: {
      kiln: "no",
      pterodactyl: "no",
      amp: "no",
      coolify: "partly",
      dokploy: "yes",
      openship: "no",
      portainer: "yes",
    },
  },
  {
    label: "Runs on Windows",
    best: ["amp"],
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

export interface Reason {
  id: "fast" | "one-panel" | "your-machines" | "open-source"
  title: string
  description: string
}

// Why to pick Kiln, said once rather than on every card.
export const reasons: Array<Reason> = [
  {
    id: "fast",
    title: "Fast and modern",
    description:
      "Built for speed and a smooth experience, from the console to the file editor.",
  },
  {
    id: "one-panel",
    title: "One panel for everything",
    description:
      "Game servers, apps, and databases, with the same console, files, backups, and access.",
  },
  {
    id: "your-machines",
    title: "Your machines",
    description:
      "Each instance runs on the machine you choose, even one behind NAT with no ports forwarded.",
  },
  {
    id: "open-source",
    title: "Free and open source",
    description:
      "AGPL-3.0, with no cap on instances or machines when you host it yourself.",
  },
]

const levelSuffix: Record<Level, string | null> = {
  yes: "",
  partly: " (partly)",
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
  questions.push({
    "@type": "Question",
    name: "When should I pick Kiln?",
    acceptedAnswer: {
      "@type": "Answer",
      text: reasons
        .map((reason) => `${reason.title}: ${reason.description}`)
        .join(" "),
    },
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
              return suffix === null ? [] : [`${row.label}${suffix}`]
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
