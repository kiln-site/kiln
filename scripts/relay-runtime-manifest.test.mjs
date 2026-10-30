import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "vite-plus/test"

const workspaceRoot = new URL("../", import.meta.url)

test("Relay runtime manifest includes every external dependency", async () => {
  const [relayPackage, runtimePackage] = await Promise.all([
    readPackage("apps/relay/package.json"),
    readPackage("apps/relay/package.runtime.json"),
  ])
  const bundledDependencies = new Set([
    "@workspace/contracts",
    "@workspace/operations",
    "@workspace/telemetry",
  ])
  const expected = Object.keys(relayPackage.dependencies)
    .filter((dependency) => !bundledDependencies.has(dependency))
    .sort()
  const actual = Object.keys(runtimePackage.dependencies).sort()

  assert.deepEqual(
    actual,
    expected,
    "Keep package.runtime.json aligned with Relay's external dependencies"
  )
})

test("Relay runtime lock matches the runtime manifest", async () => {
  const [runtimePackage, runtimeLock] = await Promise.all([
    readPackage("apps/relay/package.runtime.json"),
    readFile(
      new URL("apps/relay/pnpm-lock.runtime.yaml", workspaceRoot),
      "utf8"
    ),
  ])

  assert.deepEqual(
    runtimeLockSpecifiers(runtimeLock),
    Object.fromEntries(Object.entries(runtimePackage.dependencies).sort()),
    "Regenerate pnpm-lock.runtime.yaml after changing Relay runtime dependencies"
  )
})

// Images install runtime manifests apart from the workspace, so a pin left
// behind ships a different library than the one the bundle was built against.
test("Runtime manifests pin the versions the apps build with", async () => {
  const rootPackage = await readPackage("package.json")
  for (const app of ["relay", "web", "marketing"]) {
    const [appPackage, runtimePackage] = await Promise.all([
      readPackage(`apps/${app}/package.json`),
      readPackage(`apps/${app}/package.runtime.json`),
    ])
    for (const [name, version] of Object.entries(
      runtimePackage.dependencies
    )) {
      const built =
        appPackage.dependencies?.[name] ?? rootPackage.devDependencies?.[name]
      // Ranges resolve through the workspace lockfile; only exact pins compare.
      if (!built || !/^\d/u.test(built)) continue
      assert.equal(
        version,
        built,
        `apps/${app}/package.runtime.json pins ${name} ${version}, but the app builds with ${built}`
      )
    }
  }
})

async function readPackage(path) {
  return JSON.parse(await readFile(new URL(path, workspaceRoot), "utf8"))
}

function runtimeLockSpecifiers(lockfile) {
  const marker = "\n  .:\n    dependencies:\n"
  const start = lockfile.indexOf(marker)
  const end = lockfile.indexOf("\n\npackages:", start)
  assert.notEqual(start, -1, "Runtime lockfile importer is missing")
  assert.notEqual(end, -1, "Runtime lockfile packages section is missing")

  const dependencies = {}
  const lines = lockfile.slice(start + marker.length, end).split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const nameMatch = /^      (.+):$/u.exec(lines[index] ?? "")
    const specifierMatch = /^        specifier: (.+)$/u.exec(
      lines[index + 1] ?? ""
    )
    if (!nameMatch || !specifierMatch) continue
    const name = nameMatch[1].replace(/^'|'$/gu, "")
    dependencies[name] = specifierMatch[1].replace(/^'|'$/gu, "")
  }
  return Object.fromEntries(Object.entries(dependencies).sort())
}
