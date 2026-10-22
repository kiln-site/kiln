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
import { fileURLToPath } from "node:url"
import {
  dist,
  gitRepository,
  publishedManifest,
  repositoryRoot,
  root,
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
  const { version } = JSON.parse(
    await readFile(join(root, "npm", "version.json"), "utf8")
  )
  if (!/^\d+\.\d+\.\d+$/u.test(version))
    throw new Error("Invalid npm bootstrap version")
  await prepare(directory, {
    ...publishedManifest(),
    version,
    kilnBootstrap: {
      repository: gitRepository.slice("https://github.com/".length),
    },
    bin: { kiln: "kiln.cjs" },
    engines: { node: ">=20" },
    files: ["kiln.cjs", "install.cjs", "skills", "COMMERCIAL_LICENSE.md"],
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await packageMain()
