import { getRouteApi } from "@tanstack/react-router"
import { kilnBrickNamespace, kilnGitRepositorySlug } from "@workspace/contracts"

const rootRouteApi = getRouteApi("__root__")

export function useKilnGitRepository(): string {
  return rootRouteApi.useLoaderData().gitRepository
}

export function useKilnGitRepositorySlug(): string {
  return kilnGitRepositorySlug(useKilnGitRepository())
}

/** The namespace of Kiln's own Bricks, which go by their ID alone. */
export function useKilnBrickNamespace(): string {
  return kilnBrickNamespace(useKilnGitRepository())
}
