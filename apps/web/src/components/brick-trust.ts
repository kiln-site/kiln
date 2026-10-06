import type { Brick } from "@workspace/contracts"
import { Result } from "effect"

// Only the recipe's source URL decides trust; catalog metadata such as the
// author is controlled by whoever publishes the catalog.
export function isVerifiedBrick(
  brick: Brick,
  gitRepositorySlug: string
): boolean {
  return Result.getOrElse(
    Result.try(() => {
      const url = new URL(brick.source)
      const [owner, repository, reference, ...path] = url.pathname
        .split("/")
        .filter(Boolean)
      return (
        url.hostname.toLowerCase() === "raw.githubusercontent.com" &&
        `${owner}/${repository}`.toLowerCase() ===
          gitRepositorySlug.toLowerCase() &&
        (reference === "main" || /^[a-f0-9]{40}$/u.test(reference ?? "")) &&
        path.join("/").startsWith("apps/bricks/")
      )
    }),
    () => false
  )
}
