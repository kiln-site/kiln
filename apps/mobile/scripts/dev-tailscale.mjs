import { execFileSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"

const projectRoot = fileURLToPath(new URL("../", import.meta.url))
const tailscale =
  process.env.TAILSCALE_BIN ||
  (existsSync("/Applications/Tailscale.app/Contents/MacOS/Tailscale")
    ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    : "tailscale")
const port = Number(process.env.METRO_PORT || 8082)
const httpsPort = Number(process.env.METRO_HTTPS_PORT || 8482)
for (const value of [port, httpsPort]) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("Metro ports must be integers between 1024 and 65535.")
  }
}
const ts = (...args) => execFileSync(tailscale, args, { encoding: "utf8" })
const status = JSON.parse(ts("status", "--json"))
if (status.BackendState !== "Running")
  throw new Error("Connect Tailscale first.")
const host = status.Self.DNSName.replace(/\.$/, "")
const origin = `https://${host}:${httpsPort}`
const target = `http://127.0.0.1:${port}`
const config = JSON.parse(ts("serve", "status", "--json"))
const existing = config.Web?.[`${host}:${httpsPort}`]?.Handlers?.["/"]?.Proxy
if (config.TCP?.[httpsPort] && existing !== target) {
  throw new Error(
    `Tailscale port ${httpsPort} belongs to another service. Set METRO_HTTPS_PORT to a free port.`
  )
}
await new Promise((resolve, reject) => {
  const probe = createServer()
  probe.once("error", reject)
  probe.listen(port, "127.0.0.1", () => probe.close(resolve))
})
const created = !config.TCP?.[httpsPort]
if (created) ts("serve", "--bg", `--https=${httpsPort}`, target)
console.log(`\nKiln Dev: ${origin}`)
console.log(
  `Open: kiln-dev://expo-development-client/?url=${encodeURIComponent(origin)}`
)
console.log(
  "Keep this command running. Both devices must be connected to Tailscale.\n"
)
// Prevent idle sleep only while this development command is running.
if (process.platform === "darwin") {
  spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], {
    stdio: "ignore",
  }).unref()
}
const child = spawn(
  "pnpm",
  [
    "exec",
    "expo",
    "start",
    "--dev-client",
    "--localhost",
    "--port",
    String(port),
    ...process.argv.slice(2),
  ],
  {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      APP_VARIANT: "development",
      EXPO_PACKAGER_PROXY_URL: origin,
    },
  }
)
// Keep the Serve listener reserved while Metro is stopped. Other shareable
// previews inspect Serve status and will leave this port alone.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal))
}
child.once("error", (error) => {
  console.error(error)
  process.exitCode = 1
})
child.once("exit", (code) => {
  process.exitCode = code ?? 0
})
