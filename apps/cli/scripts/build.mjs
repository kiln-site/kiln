import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  binaryName,
  defaultUrl,
  dist,
  gitRepository,
  root,
  version,
} from "./distribution.mjs"
import { packageMain, packagePlatform } from "./package.mjs"

await rm(dist, { force: true, recursive: true })
await mkdir(dist, { recursive: true })
const outfile = join(dist, binaryName)
const result = Bun.spawnSync([
  process.execPath,
  "build",
  join(root, "src", "main.ts"),
  "--target",
  "bun",
  "--outfile",
  outfile,
  "--external",
  "cpu-features",
  "--minify",
  "--sourcemap=linked",
  "--define",
  `process.env.KILN_VERSION=${JSON.stringify(version)}`,
  "--define",
  `process.env.KILN_CLI_DEFAULT_URL=${JSON.stringify(defaultUrl)}`,
  "--define",
  `process.env.KILN_GIT_REPO=${JSON.stringify(gitRepository)}`,
  "--compile",
])
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
if (!result.success) process.exit(result.exitCode)

if (process.platform === "darwin") {
  const signing = Bun.spawnSync([
    "codesign",
    "--entitlements",
    join(root, "entitlements.plist"),
    "--deep",
    "--sign",
    "-",
    outfile,
    "--force",
  ])
  if (!signing.success) {
    process.stderr.write(signing.stderr)
    process.exit(signing.exitCode)
  }
}
await packagePlatform()
await packageMain()
