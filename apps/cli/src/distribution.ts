import {
  kilnCliPackageName,
  resolveKilnGitRepository,
} from "@workspace/contracts"

export const cliPackageName = kilnCliPackageName(process.env.KILN_CLI_PACKAGE)
export const cliDefaultUrl =
  process.env.KILN_CLI_DEFAULT_URL ?? "https://kiln.site"

export function cliReleasesUrl(): string {
  return `${resolveKilnGitRepository(process.env.KILN_GIT_REPO)}/releases`
}
