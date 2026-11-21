const path = require("node:path")
const { getDefaultConfig } = require("expo/metro-config")
const { withUniwindConfig } = require("uniwind/metro")

/** @type {import("expo/metro-config").MetroConfig} */
const config = getDefaultConfig(__dirname)
const workspaceRoot = path.resolve(__dirname, "../..")
const packagesRoot = path.join(workspaceRoot, "packages") + path.sep

config.watchFolders = [
  ...new Set([...(config.watchFolders ?? []), workspaceRoot]),
]

// Workspace packages export their TypeScript sources under the "development"
// condition and unbuilt `dist` files otherwise. Point Metro at the sources
// for workspace packages only, so no third-party package switches to a
// development build.
const workspaceSources = {
  "@workspace/contracts/cli": path.join(
    workspaceRoot,
    "packages/contracts/src/cli.ts"
  ),
}
const upstreamResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const source = workspaceSources[moduleName]
  if (source) return { type: "sourceFile", filePath: source }
  const resolve = upstreamResolveRequest ?? context.resolveRequest
  // Workspace sources import siblings as `./name.js`, as Node ESM requires,
  // while the file on disk is `name.ts`.
  if (
    moduleName.startsWith(".") &&
    moduleName.endsWith(".js") &&
    context.originModulePath.startsWith(packagesRoot)
  )
    return resolve(context, moduleName.slice(0, -3), platform)
  return resolve(context, moduleName, platform)
}

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  dtsFile: "./uniwind-types.d.ts",
})
