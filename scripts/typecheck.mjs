import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const tsrs = availableTsrs()
const result = tsrs
  ? spawnSync(process.execPath, [tsrs, "--noEmit", "--checkers", "2"], {
      stdio: "inherit",
    })
  : checkWithVitePlus()

if (result.error) console.error(result.error.message)
if (result.signal) process.kill(process.pid, result.signal)
process.exitCode = result.status ?? 1

function availableTsrs() {
  try {
    const cli = fileURLToPath(
      new URL("bin/tsrs", import.meta.resolve("tsrs/package.json"))
    )
    // Probe startup only. A subsequent typecheck failure must never fall back.
    const probe = spawnSync(process.execPath, [cli, "--version"], {
      stdio: "ignore",
    })
    return probe.status === 0 ? cli : undefined
  } catch {
    return undefined
  }
}

function checkWithVitePlus() {
  console.warn("tsrs is unavailable; using Vite+ type checking.")
  const cli = fileURLToPath(import.meta.resolve("vite-plus/bin"))
  return spawnSync(process.execPath, [cli, "check", "--no-fmt", "--no-lint"], {
    stdio: "inherit",
    env: {
      ...process.env,
      KILN_TYPECHECK_FALLBACK: "1",
      GOMAXPROCS: "2",
    },
  })
}
