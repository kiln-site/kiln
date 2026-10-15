/**
 * Image references as Docker reads them (distribution/reference's
 * `ParseNormalizedNamed`): `nginx:1.27` is `docker.io/library/nginx:1.27`.
 * Pulls name the image this way, and registry credentials are found by the
 * reference's registry.
 */

export const DOCKER_HUB = "docker.io"

export interface ImageReference {
  /** Registry host, such as `docker.io` or `ghcr.io:443`. */
  readonly domain: string
  /** Repository within the registry, such as `library/nginx`. */
  readonly path: string
  readonly tag: string | undefined
  readonly digest: string | undefined
}

// One path component: lowercase alphanumerics with single separators.
const COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/u
const DOMAIN =
  /^(?:(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])(?:\.(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]))*|\[[a-fA-F0-9:]+\])(?::[0-9]+)?$/u
const TAG = /^[\w][\w.-]{0,127}$/u
const DIGEST = /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[a-zA-Z0-9=_-]{32,}$/u

export function parseImageReference(reference: string): ImageReference {
  const invalid = () =>
    new Error(`invalid reference format: ${JSON.stringify(reference)}`)
  const at = reference.indexOf("@")
  const named = at === -1 ? reference : reference.slice(0, at)
  const digest = at === -1 ? undefined : reference.slice(at + 1)
  if (digest !== undefined && !DIGEST.test(digest)) throw invalid()
  const colon = named.lastIndexOf(":")
  const hasTag = colon > named.lastIndexOf("/")
  const name = hasTag ? named.slice(0, colon) : named
  const tag = hasTag ? named.slice(colon + 1) : undefined
  if (tag !== undefined && !TAG.test(tag)) throw invalid()

  const slash = name.indexOf("/")
  const first = slash === -1 ? "" : name.slice(0, slash)
  const hasDomain =
    slash !== -1 &&
    (/[.:]/u.test(first) ||
      first === "localhost" ||
      first.toLowerCase() !== first)
  let domain = hasDomain ? first : DOCKER_HUB
  let path = hasDomain ? name.slice(slash + 1) : name
  if (domain === "index.docker.io") domain = DOCKER_HUB
  if (domain === DOCKER_HUB && !path.includes("/")) path = `library/${path}`
  if (!DOMAIN.test(domain)) throw invalid()
  if (!path || !path.split("/").every((part) => COMPONENT.test(part))) {
    throw invalid()
  }
  return { digest, domain, path, tag }
}

/** The repository's full name, such as `docker.io/library/nginx`. */
export function repositoryName(reference: ImageReference): string {
  return `${reference.domain}/${reference.path}`
}

/** The full reference, with `latest` when it names neither tag nor digest. */
export function normalizedReference(reference: ImageReference): string {
  const name = repositoryName(reference)
  if (reference.digest !== undefined) {
    return `${name}${reference.tag === undefined ? "" : `:${reference.tag}`}@${reference.digest}`
  }
  return `${name}:${reference.tag ?? "latest"}`
}
