import type { BrickRecipe } from "./brick-recipe.js"

/**
 * What Kiln relies on to run a tunnel of each type: the images its two
 * containers come from, each at whatever tag its Brick pins. A tunnel's
 * login, routes, firewall and DNS are Kiln's, made for these images, so a
 * tunnel Brick of a type runs them and nothing else.
 */
export const tunnelTypeRuntimes = {
  tailscale: { dns: "coredns/coredns", image: "tailscale/tailscale" },
} as const satisfies Readonly<Record<string, { dns: string; image: string }>>

export type TunnelType = keyof typeof tunnelTypeRuntimes

/** The images a tunnel's two containers run, as its Brick pins them. */
export interface TunnelBrickImages {
  /** Its CoreDNS container's. */
  dns: string
  /** Its Tailscale container's. */
  tailscale: string
}

// A tag as Docker takes one, so nothing after the colon can name another
// registry, repository or digest.
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u

const runsImage = (repository: string, image: string) =>
  image.startsWith(`${repository}:`) &&
  IMAGE_TAG.test(image.slice(repository.length + 1))

const isTunnelType = (type: string | undefined): type is TunnelType =>
  type !== undefined && Object.hasOwn(tunnelTypeRuntimes, type)

/**
 * Why a recipe can't run as a tunnel of its type, or null when it can. A
 * tunnel Brick pins its two images and says nothing else: Kiln makes the
 * rest of both containers.
 */
export function tunnelBrickProblem(recipe: BrickRecipe): string | null {
  if (recipe.kind !== "tunnel") return `A ${recipe.kind} Brick isn't a tunnel`
  const type = recipe.type
  if (!isTunnelType(type)) return "Kiln runs a tunnel of a type it knows"
  const runtime = tunnelTypeRuntimes[type]
  if ((recipe.inputs ?? []).length > 0) {
    return "A tunnel Brick asks nothing at install yet"
  }
  const deploy = recipe.deploy
  if (deploy?.type !== "image") return "A tunnel Brick runs from an image"
  if (!runsImage(runtime.image, deploy.image)) {
    return `A ${type} tunnel runs the ${runtime.image} image, at a tag`
  }
  const extra = Object.keys(deploy).filter(
    (field) => field !== "type" && field !== "image"
  )
  if (extra.length > 0) {
    return `A tunnel Brick can't set ${extra.join(", ")}; Kiln makes its containers`
  }
  const dns = recipe.tunnel?.dns.image
  if (dns === undefined || !runsImage(runtime.dns, dns)) {
    return `A ${type} tunnel answers its names with the ${runtime.dns} image, at a tag`
  }
  return null
}

/** The images a tunnel Brick runs. Throws what `tunnelBrickProblem` says. */
export function tunnelBrickImages(recipe: BrickRecipe): TunnelBrickImages {
  const problem = tunnelBrickProblem(recipe)
  if (problem) throw new Error(problem)
  // `tunnelBrickProblem` refused anything else.
  if (recipe.deploy?.type !== "image" || !recipe.tunnel) {
    throw new Error("Not a tunnel Brick")
  }
  return { dns: recipe.tunnel.dns.image, tailscale: recipe.deploy.image }
}
