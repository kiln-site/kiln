import { resolveKilnGitRepository } from "@workspace/contracts"
import release from "../../../release.json" with { type: "json" }

export const cliVersion =
  process.env.KILN_VERSION?.trim() || release.releaseLine
export const cliGitRepository = resolveKilnGitRepository(
  process.env.KILN_GIT_REPO
)
export const cliDefaultUrl =
  process.env.KILN_CLI_DEFAULT_URL ?? "https://kiln.site"
