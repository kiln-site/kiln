import { spawn } from "node:child_process"
import { resolve } from "node:path"

import { parseSecretKeyring } from "../keyring.mjs"

process.env.NODE_ENV = "production"
process.env.KILN_URL ||= "http://localhost:3000"
parseSecretKeyring(process.env.BETTER_AUTH_SECRETS)

const server = spawn(
  process.execPath,
  ["--import", resolve("instrument.server.mjs"), resolve("scripts/serve.mjs")],
  {
    env: process.env,
    stdio: "inherit",
  }
)

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal))
}

server.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
