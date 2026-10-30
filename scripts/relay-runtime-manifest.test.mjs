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
