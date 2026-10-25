// Runs in the short-lived helper `SecurityInventory` starts, within its CPU
// and memory caps: Syft inventories the target, then this slims what it
// found to what Hearth needs, so the Relay itself only reads the bounded,
// gzipped result.
import { spawn } from "node:child_process"
import { once } from "node:events"
import { readFile, rm, writeFile } from "node:fs/promises"
import { release } from "node:os"
import { promisify } from "node:util"
import { gzip as gzipCallback } from "node:zlib"

const gzip = promisify(gzipCallback)
const environment = (name: string) => process.env[name]?.trim() ?? ""
const output = environment("KILN_SECURITY_OUTPUT")
const raw = `${output}.syft.json`
const maxBytes = Number(environment("KILN_SECURITY_MAX_BYTES"))
const host = environment("KILN_SECURITY_HOST") === "1"

const syft = spawn(
  environment("KILN_SECURITY_SYFT"),
  [...process.argv.slice(2), "-o", `syft-json=${raw}`, "-q"],
  { stdio: ["ignore", "inherit", "inherit"] }
)
const [code] = (await once(syft, "exit")) as [number | null]
if (code !== 0) {
  process.exitCode = code ?? 1
} else {
  const document = Buffer.from(
    JSON.stringify(
      slimInventory(
        JSON.parse(await readFile(raw, "utf8")) as SyftDocument,
        host ? release() : null
      )
    )
  )
  await rm(raw, { force: true })
  if (document.length > maxBytes) {
    console.error("The inventory is too large to send")
    process.exitCode = 1
  } else {
    await writeFile(output, await gzip(document))
  }
}

interface SyftArtifact {
  id?: unknown
  metadata?: { files?: unknown }
  name?: unknown
  type?: unknown
  version?: unknown
}

interface SyftDocument {
  artifactRelationships?: Array<{
    child?: unknown
    parent?: unknown
    type?: unknown
  }>
  artifacts?: Array<SyftArtifact>
  files?: unknown
}

/**
 * Syft's inventory as Hearth needs it: without the files each package
 * installed and their containment, which Grype doesn't read and which make
 * up most of a host's inventory. A host's kernels other than the running
 * one are left out: package managers keep old ones installed, each with
 * thousands of findings for a kernel that isn't running.
 */
function slimInventory(
  document: SyftDocument,
  kernel: string | null
): SyftDocument {
  const artifacts = document.artifacts ?? []
  const idle = new Set(
    kernel === null
      ? []
      : artifacts.flatMap((artifact) =>
          idleKernelPackage(artifact, kernel) ? [artifact.id] : []
        )
  )
  delete document.files
  document.artifacts = artifacts.filter((artifact) => !idle.has(artifact.id))
  document.artifactRelationships = (
    document.artifactRelationships ?? []
  ).filter(
    (relationship) =>
      relationship.type !== "contains" &&
      !idle.has(relationship.parent) &&
      !idle.has(relationship.child)
  )
  for (const artifact of document.artifacts) {
    if (artifact.metadata && typeof artifact.metadata === "object") {
      delete artifact.metadata.files
    }
  }
  return document
}

// Whether a package is a kernel the host isn't running, from the release it
// reports, such as `6.8.0-147-generic`: Debian's and Ubuntu's
// `linux-image-6.8.0-137-generic`, or an RPM `kernel-core` of another version.
function idleKernelPackage(artifact: SyftArtifact, kernel: string): boolean {
  if (typeof artifact.name !== "string") return false
  if (artifact.type === "deb") {
    const release = artifact.name.match(
      /^linux-(?:[a-z]+-)+?(\d+\.\d+\.\d+-\d+)(?:-[a-z0-9]+)*$/u
    )?.[1]
    const running = kernel.match(/^(\d+\.\d+\.\d+-\d+)/u)?.[1]
    return release !== undefined && running !== undefined && release !== running
  }
  if (
    artifact.type === "rpm" &&
    /^kernel(?:-core|-modules(?:-core|-extra)?)?$/u.test(artifact.name)
  ) {
    const version =
      typeof artifact.version === "string"
        ? artifact.version.replace(/^\d+:/u, "")
        : ""
    return version !== "" && !kernel.startsWith(version)
  }
  return false
}
