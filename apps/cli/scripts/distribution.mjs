import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  DEFAULT_KILN_GIT_REPO,
  kilnCliPackageName,
  resolveKilnGitRepository,
} from "../../../packages/contracts/src/git-repository.ts"
import { resolveCliVersion } from "./version.mjs"

export const root = join(dirname(fileURLToPath(import.meta.url)), "..")
export const repositoryRoot = join(root, "../..")
export const dist = join(root, "dist")
export const version = await resolveCliVersion({ repositoryRoot })
export const gitRepository = resolveKilnGitRepository(process.env.KILN_GIT_REPO)
export const packageName = kilnCliPackageName(
  process.env.KILN_CLI_PACKAGE,
  gitRepository
)
export const defaultUrl =
  process.env.KILN_CLI_DEFAULT_URL?.trim() ||
  (gitRepository === DEFAULT_KILN_GIT_REPO ? "https://kiln.site" : "")
if (defaultUrl && !/^https?:\/\//u.test(defaultUrl))
  throw new Error("KILN_CLI_DEFAULT_URL must be an HTTP(S) URL")
export const platforms = [
  { name: "linux-x64", os: "linux", cpu: "x64" },
  { name: "linux-arm64", os: "linux", cpu: "arm64" },
  { name: "darwin-x64", os: "darwin", cpu: "x64" },
  { name: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { name: "windows-x64", os: "win32", cpu: "x64" },
]
export const binaryName = process.platform === "win32" ? "kiln.exe" : "kiln"
export const platform = platforms.find(
  (entry) => entry.os === process.platform && entry.cpu === process.arch
)

export function publishedManifest() {
  return {
    name: packageName,
    version,
    description:
      "Command-line access to Kiln and self-hosted Hearth instances.",
    repository: {
      type: "git",
      url: `git+${gitRepository}.git`,
      directory: "apps/cli",
    },
    homepage: defaultUrl || gitRepository,
    bugs: `${gitRepository}/issues`,
    license: "SEE LICENSE IN LICENSE",
    publishConfig: { access: "public" },
  }
}
