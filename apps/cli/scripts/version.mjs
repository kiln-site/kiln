import { readFile } from "node:fs/promises"
import { join } from "node:path"

const kilnVersionPattern =
  /^\d+\.\d+\.\d+(?:-(?:nightly|test)\.\d{8}\.\d{6})?$/u

export async function resolveCliVersion({
  repositoryRoot,
  environment = process.env,
}) {
  const configured = environment.KILN_VERSION?.trim()
  const release = JSON.parse(
    await readFile(join(repositoryRoot, "release.json"), "utf8")
  )
  const version = configured || release.releaseLine

  if (typeof version !== "string" || !kilnVersionPattern.test(version)) {
    throw new Error(`Invalid Kiln CLI version: ${String(version)}`)
  }
  return version
}
