import { Result } from "effect"
import type { RelayInstance } from "./index.js"

/** Overview and resource streams never carry startup secrets. Configuration has its own guarded endpoint. */
export function projectRelayInstanceOverview<T extends RelayInstance>(
  instance: T
): Omit<T, "variables" | "brickSource"> & Pick<RelayInstance, "brickSource"> {
  const { variables: _variables, brickSource, ...overview } = instance
  const source = publicBrickSource(brickSource)
  return source === undefined ? overview : { ...overview, brickSource: source }
}

function publicBrickSource(source: string | undefined): string | undefined {
  if (!source) return undefined
  const parsed = Result.try(() => new URL(source))
  // Invalid source strings can contain credentials too.
  if (Result.isFailure(parsed)) return undefined
  const url = parsed.success
  url.username = ""
  url.password = ""
  url.search = ""
  url.hash = ""
  return url.href
}
