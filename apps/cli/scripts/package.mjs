import { chmod, cp, copyFile, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  binaryName,
  dist,
  packageName,
  platform,
  platforms,
  publishedManifest,
  repositoryRoot,
  root,
  version,
} from "./distribution.mjs"

async function prepare(directory, manifest) {
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  await Promise.all([
    copyFile(join(root, "README.md"), join(directory, "README.md")),
    copyFile(join(repositoryRoot, "LICENSE"), join(directory, "LICENSE")),
    copyFile(
      join(repositoryRoot, "COMMERCIAL_LICENSE.md"),
      join(directory, "COMMERCIAL_LICENSE.md")
    ),
    writeFile(
      join(directory, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    ),
  ])
}

export async function packageMain() {
  const directory = join(dist, "npm")
  await prepare(directory, {
    ...publishedManifest(),
    bin: { kiln: "kiln.cjs" },
    engines: { node: ">=20" },
    files: ["kiln.cjs", "install.cjs", "skills", "COMMERCIAL_LICENSE.md"],
    scripts: { postinstall: "node install.cjs" },
    optionalDependencies: Object.fromEntries(
      platforms.map((entry) => [`${packageName}-${entry.name}`, version])
    ),
  })
  await Promise.all([
    copyFile(join(root, "npm", "kiln.cjs"), join(directory, "kiln.cjs")),
    copyFile(join(root, "npm", "install.cjs"), join(directory, "install.cjs")),
    cp(
      join(repositoryRoot, ".agents", "skills", "kiln-cli"),
      join(directory, "skills", "kiln-cli"),
      { recursive: true }
    ),
  ])
  await chmod(join(directory, "kiln.cjs"), 0o755)
}

export async function packagePlatform() {
  if (!platform)
    throw new Error(
      `Unsupported CLI platform: ${process.platform}/${process.arch}`
    )
  const directory = join(dist, "npm-platform")
  await prepare(directory, {
    ...publishedManifest(),
    name: `${packageName}-${platform.name}`,
    os: [platform.os],
    cpu: [platform.cpu],
    files: ["bin", "COMMERCIAL_LICENSE.md"],
  })
  await mkdir(join(directory, "bin"))
  await copyFile(join(dist, binaryName), join(directory, "bin", binaryName))
  await chmod(join(directory, "bin", binaryName), 0o755)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await packageMain()
