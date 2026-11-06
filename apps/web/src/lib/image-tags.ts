// Which newer version of an image to suggest, from what its registry says.
// Only a tag that spells out a version can be compared, against tags that
// have the same shape: `1.21.0-alpine` moves to `1.21.6-alpine`, never to
// `1.22-alpine` or `1.21.6`, which are other things to run.

export type ImageTagUpdate = "major" | "minor" | "patch"

export interface ImageTagSuggestion {
  image: string
  kind: ImageTagUpdate
  tag: string
}

export interface ImageReference {
  /** The image as Kiln was given it, without its tag. */
  name: string
  registry: "docker.io" | "ghcr.io"
  repository: string
  tag: string
}

const REPOSITORY =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u
const TAG = /^[\w][\w.-]{0,127}$/u
const VERSION = /^(v?)(\d+(?:\.\d+){0,3})(-[\w.-]+)?$/u

/**
 * Reads an image name, for a registry Kiln knows how to ask, so the name
 * itself can never send Hearth anywhere else. One pinned to a digest, or
 * without a tag, has no version to move from.
 */
export function parseImageReference(image: string): ImageReference | null {
  if (image.includes("@")) return null
  const slash = image.indexOf("/")
  const first = slash === -1 ? "" : image.slice(0, slash)
  const hasRegistry =
    first.includes(".") || first.includes(":") || first === "localhost"
  const registry = hasRegistry ? first : "docker.io"
  const path = hasRegistry ? image.slice(slash + 1) : image
  const colon = path.lastIndexOf(":")
  if (colon === -1) return null
  const repository = path.slice(0, colon)
  const tag = path.slice(colon + 1)
  if (!REPOSITORY.test(repository) || !TAG.test(tag)) return null
  if (registry === "ghcr.io") {
    return { name: `ghcr.io/${repository}`, registry, repository, tag }
  }
  if (registry !== "docker.io" && registry !== "index.docker.io") return null
  return {
    name: repository,
    registry: "docker.io",
    repository: repository.includes("/") ? repository : `library/${repository}`,
    tag,
  }
}

interface Version {
  numbers: ReadonlyArray<number>
  prefix: string
  suffix: string
  tag: string
}

function readVersion(tag: string): Version | null {
  const match = VERSION.exec(tag)
  if (!match) return null
  return {
    numbers: (match[2] ?? "").split(".").map(Number),
    prefix: match[1] ?? "",
    suffix: match[3] ?? "",
    tag,
  }
}

function compare(left: Version, right: Version): number {
  for (const [index, number] of left.numbers.entries()) {
    const difference = number - (right.numbers[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * The newest tag in the current one's patch line, its major version, and of
 * all, whichever exist and are newer, nearest first.
 */
export function suggestImageTags(
  reference: Pick<ImageReference, "name" | "tag">,
  tags: ReadonlyArray<string>
): Array<ImageTagSuggestion> {
  const current = readVersion(reference.tag)
  if (!current) return []
  const candidates = tags
    .flatMap((tag) => {
      const version = readVersion(tag)
      return version &&
        version.prefix === current.prefix &&
        version.suffix === current.suffix &&
        version.numbers.length === current.numbers.length &&
        compare(version, current) > 0
        ? [version]
        : []
    })
    .sort((left, right) => compare(right, left))
  const sameLeading = (version: Version, count: number) =>
    current.numbers
      .slice(0, count)
      .every((number, index) => version.numbers[index] === number)
  const depth = current.numbers.length
  const tiers: ReadonlyArray<readonly [ImageTagUpdate, Version | undefined]> = [
    [
      "patch",
      depth >= 3
        ? candidates.find((version) => sameLeading(version, depth - 1))
        : undefined,
    ],
    [
      "minor",
      depth >= 2
        ? candidates.find((version) => sameLeading(version, 1))
        : undefined,
    ],
    ["major", candidates[0]],
  ]
  const suggestions = new Map<string, ImageTagSuggestion>()
  for (const [kind, version] of tiers) {
    if (!version || suggestions.has(version.tag)) continue
    suggestions.set(version.tag, {
      image: `${reference.name}:${version.tag}`,
      kind,
      tag: version.tag,
    })
  }
  return [...suggestions.values()]
}
