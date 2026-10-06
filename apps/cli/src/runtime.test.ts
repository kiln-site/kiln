import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { assert, describe, it } from "@effect/vitest"

// Run the CLI the way it ships: under Bun, receiving a real OS signal.
const bun = join(
  dirname(createRequire(import.meta.url).resolve("bun/package.json")),
  "bin",
  "bun.exe"
)
const main = fileURLToPath(new URL("./main.ts", import.meta.url))

describe("CLI runtime", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`${signal} interrupts an in-flight command, aborts its request, and exits 130`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "kiln-cli-runtime-"))
      // Hearth accepts the request and never answers.
      const server = createServer()
      const received = once(server, "request") as Promise<[IncomingMessage]>
      try {
        server.listen(0, "127.0.0.1")
        await once(server, "listening")
        const { port } = server.address() as AddressInfo
        const child = spawn(bun, [main, "whoami"], {
          env: {
            ...process.env,
            KILN_CONFIG: join(directory, "config.json"),
            KILN_TOKEN: "kiln_cli_runtime_test",
            KILN_URL: `http://127.0.0.1:${port}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        })
        let stderr = ""
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk
        })
        const exited = once(child, "exit")

        const [request] = await received
        // An aborted request may surface as a reset; either way it closes.
        request.socket.on("error", () => undefined)
        const aborted = new Promise((resolve) =>
          request.socket.once("close", resolve)
        )
        child.kill(signal)
        const [code, killedBy] = await exited
        await aborted

        assert.strictEqual(code, 130)
        assert.isNull(killedBy)
        assert.strictEqual(stderr, "")
      } finally {
        server.closeAllConnections()
        server.close()
        await rm(directory, { force: true, recursive: true })
      }
    })
  }
})
