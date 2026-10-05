const {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} = require("node:fs")
const { join } = require("node:path")
const manifest = require("./package.json")

function installBinary(force = false) {
  const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
  const packageName = `${manifest.name}-${platform}`
  if (!manifest.optionalDependencies[packageName]) {
    throw new Error(`Kiln does not publish a binary for ${platform}.`)
  }
  const filename = process.platform === "win32" ? "kiln.exe" : "kiln"
  const destination = join(__dirname, "native", filename)
  if (!force && existsSync(destination)) return destination

  let source
  try {
    source = require.resolve(`${packageName}/bin/${filename}`)
  } catch {
    throw new Error(
      `Missing ${packageName}. Reinstall ${manifest.name} with optional dependencies enabled.`
    )
  }
  mkdirSync(join(__dirname, "native"), { recursive: true })
  const temporary = `${destination}.${process.pid}.tmp`
  try {
    // Copy, never hard-link: self-updates must not mutate the package manager's store.
    copyFileSync(source, temporary)
    chmodSync(temporary, 0o755)
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
  return destination
}

module.exports = { installBinary }
if (require.main === module) installBinary(true)
