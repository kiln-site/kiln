import {
  chmod,
  cp,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"

import {
  DEFAULT_KILN_GIT_REPO,
  kilnCliPackageName,
  resolveKilnGitRepository,
} from "../../../packages/contracts/src/git-repository.ts"
import { resolveCliVersion } from "./version.mjs"

const root = join(import.meta.dir, "..")
const repositoryRoot = join(root, "../..")
const dist = join(root, "dist")
const npmDist = join(dist, "npm")
const version = await resolveCliVersion({ repositoryRoot })
const gitRepository = resolveKilnGitRepository(process.env.KILN_GIT_REPO)
const packageName = kilnCliPackageName(
  process.env.KILN_CLI_PACKAGE,
  gitRepository
)
const defaultUrl =
  process.env.KILN_CLI_DEFAULT_URL?.trim() ||
  (gitRepository === DEFAULT_KILN_GIT_REPO ? "https://kiln.site" : "")
if (defaultUrl && !/^https?:\/\//u.test(defaultUrl))
  throw new Error("KILN_CLI_DEFAULT_URL must be an HTTP(S) URL")
const npmOnly = process.argv.includes("--npm-only")

await rm(dist, { force: true, recursive: true })
await mkdir(npmDist, { recursive: true })

if (!npmOnly) await buildBunBinary()
await buildNpmPackage()

async function buildBunBinary() {
  const outfile = join(dist, "kiln")
  buildBunExecutable(outfile)

  if (process.platform !== "darwin") return
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

async function buildNpmPackage() {
  const executable = join(npmDist, "kiln.mjs")
  const result = await Bun.build({
    entrypoints: [join(root, "src", "main.ts")],
    external: ["cpu-features"],
    minify: true,
    target: "node",
    define: {
      "process.env.KILN_VERSION": JSON.stringify(version),
      "process.env.KILN_CLI_PACKAGE": JSON.stringify(packageName),
      "process.env.KILN_CLI_DEFAULT_URL": JSON.stringify(defaultUrl),
      "process.env.KILN_GIT_REPO": JSON.stringify(gitRepository),
    },
  })
  if (!result.success) {
    for (const message of result.logs) console.error(message)
    process.exit(1)
  }
  const output = result.outputs.find(
    (candidate) => candidate.kind === "entry-point"
  )
  if (!output) throw new Error("The npm bundle did not produce an entry point")
  await writeFile(executable, await output.arrayBuffer())

  const bundled = await readFile(executable, "utf8")
  if (!bundled.startsWith("#!/usr/bin/env bun")) {
    throw new Error("The npm bundle did not preserve the expected CLI shebang")
  }
  await writeFile(
    executable,
    bundled.replace("#!/usr/bin/env bun", "#!/usr/bin/env node")
  )
  await chmod(executable, 0o755)

  await mkdir(join(npmDist, "skills"), { recursive: true })
  await Promise.all([
    cp(
      join(repositoryRoot, ".agents", "skills", "kiln-cli"),
      join(npmDist, "skills", "kiln-cli"),
      { recursive: true }
    ),
    copyFile(join(root, "README.md"), join(npmDist, "README.md")),
    copyFile(join(repositoryRoot, "LICENSE"), join(npmDist, "LICENSE")),
    copyFile(
      join(repositoryRoot, "COMMERCIAL_LICENSE.md"),
      join(npmDist, "COMMERCIAL_LICENSE.md")
    ),
    writeFile(
      join(npmDist, "package.json"),
      `${JSON.stringify(publishedManifest(), null, 2)}\n`
    ),
  ])
}

function buildBunExecutable(outfile) {
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
    `process.env.KILN_CLI_PACKAGE=${JSON.stringify(packageName)}`,
    "--define",
    `process.env.KILN_CLI_DEFAULT_URL=${JSON.stringify(defaultUrl)}`,
    "--define",
    `process.env.KILN_GIT_REPO=${JSON.stringify(gitRepository)}`,
    "--compile",
  ])

  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (!result.success) process.exit(result.exitCode)
}

function publishedManifest() {
  return {
    name: packageName,
    version,
    description:
      "Command-line access to Kiln and self-hosted Hearth instances.",
    type: "module",
    bin: { kiln: "kiln.mjs" },
    engines: { node: ">=20" },
    repository: {
      type: "git",
      url: `git+${gitRepository}.git`,
      directory: "apps/cli",
    },
    homepage: defaultUrl || gitRepository,
    bugs: `${gitRepository}/issues`,
    license: "SEE LICENSE IN LICENSE",
    keywords: ["kiln", "hearth", "server", "cli"],
    publishConfig: { access: "public" },
  }
}
