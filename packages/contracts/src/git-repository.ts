// CI imports this module directly before installing dependencies. Keep it package-free.
export const DEFAULT_KILN_GIT_REPO = "https://github.com/kiln-site/kiln"
export const LEGACY_KILN_GIT_REPO = "https://github.com/kiln-site/hearth"

const repositorySegment = /^[A-Za-z\d_.-]+$/u

export function resolveKilnGitRepository(value?: string): string {
  const configured = value?.trim() || DEFAULT_KILN_GIT_REPO
  const candidate = configured.includes("://")
    ? configured
    : `https://github.com/${configured}`

  if (!URL.canParse(candidate)) throw invalidRepositoryError()
  const url = new URL(candidate)

  const segments = url.pathname.replace(/\/$/u, "").split("/").filter(Boolean)
  const owner = segments[0]
  const repository = segments[1]?.replace(/\.git$/u, "")
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    segments.length !== 2 ||
    !owner ||
    !repository ||
    !repositorySegment.test(owner) ||
    !repositorySegment.test(repository)
  ) {
    throw invalidRepositoryError()
  }

  return `https://github.com/${owner}/${repository}`
}

export function kilnGitRepositorySlug(value?: string): string {
  return new URL(resolveKilnGitRepository(value)).pathname.slice(1)
}

export function kilnGitRepositoryApiUrl(
  value: string | undefined,
  path: string
): string {
  return `https://api.github.com/repos/${kilnGitRepositorySlug(value)}/${path.replace(/^\/+/, "")}`
}

export function kilnGitRepositoryRawUrl(
  value: string | undefined,
  path: string
): string {
  return `https://raw.githubusercontent.com/${kilnGitRepositorySlug(value)}/main/${path.replace(/^\/+/, "")}`
}

export function isKilnGitRepositorySource(
  source: string | undefined,
  configuredRepository: string
): boolean {
  return (
    source === configuredRepository ||
    (configuredRepository === DEFAULT_KILN_GIT_REPO &&
      source === LEGACY_KILN_GIT_REPO)
  )
}

function invalidRepositoryError(): Error {
  return new Error(
    "KILN_GIT_REPO must be a GitHub repository URL or owner/repository"
  )
}

/** Forks use a repository-scoped namespace; official image names stay compatible. */
export function kilnImagePrefix(repository?: string): string {
  const resolved = resolveKilnGitRepository(repository)
  return resolved === DEFAULT_KILN_GIT_REPO
    ? "ghcr.io/kiln-site"
    : `ghcr.io/${kilnGitRepositorySlug(resolved).toLowerCase()}`
}

export function kilnImageRepository(
  component: string,
  repository?: string
): string {
  if (
    !["hearth", "relay", "bricks-java", "bricks-steamcmd"].includes(component)
  ) {
    throw new Error("Unknown Kiln image component")
  }
  return `${kilnImagePrefix(repository)}/${component}`
}

export function kilnImageSource(repository?: string): string {
  const resolved = resolveKilnGitRepository(repository)
  return resolved === DEFAULT_KILN_GIT_REPO ? LEGACY_KILN_GIT_REPO : resolved
}

export function kilnCliPackageName(
  value?: string,
  repository?: string
): string {
  const resolved = resolveKilnGitRepository(repository)
  const name =
    value?.trim() ||
    (resolved === DEFAULT_KILN_GIT_REPO
      ? "kiln-cli"
      : `@${kilnGitRepositorySlug(resolved).toLowerCase()}-cli`)
  // Also keeps the Windows updater's cmd.exe arguments free of shell metacharacters.
  if (
    name.length > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)
  ) {
    throw new Error(
      "KILN_CLI_PACKAGE must be a valid lowercase npm package name"
    )
  }
  return name
}

/** Only the distribution's default catalog remaps upstream Ember references. */
export function kilnDefaultEmberImage(
  image: string,
  repository?: string
): string {
  return image.replace(
    /^ghcr\.io\/kiln-site\/(bricks-java|bricks-steamcmd)(?=[:@])/u,
    (_match, component: string) => kilnImageRepository(component, repository)
  )
}
