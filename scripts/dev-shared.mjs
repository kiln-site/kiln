import { createHash } from "node:crypto"
import { createServer } from "node:net"

// What a development stack owns on the box's shared MySQL and Valkey. Hashed
// so no stack's name can equal or prefix another's: `kiln-a-test-1` would
// otherwise name a test database of `kiln-a`. Fixed length, so every test
// suffix fits MySQL's 64 characters.
export function stackResources(stack) {
  const id = createHash("sha256").update(stack).digest("hex").slice(0, 12)
  return {
    database: `s_${id}`,
    testDatabase: `t_${id}_test`,
    user: `u_${id}`,
  }
}

// Hearth's own derivation, in apps/web/src/lib/cache-config.ts.
export function cacheNamespace({ database, host, port, tablePrefix }) {
  const digest = createHash("sha256")
    .update(`${host}:${port}/${database}/${tablePrefix}`)
    .digest("hex")
    .slice(0, 16)
  return `kiln:hearth:v1:${digest}`
}

export function sqlString(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "''")}'`
}

// `_` and `%` are wildcards in a GRANT's database name, even in backticks, so
// `s_abc` unescaped also grants `sXabc`.
export function grantPattern(value) {
  return value.replaceAll(/[\\_%]/gu, "\\$&")
}

const LOCK_PORT = 29871

/**
 * Runs `work` holding the box's one lock, serializing what changes its shared
 * services across checkouts. A listening socket, so the kernel releases it
 * when this process ends, however it ends, and there's nothing stale to
 * judge. Below the Relay's game ports.
 */
export async function withBoxLock(
  work,
  { port = LOCK_PORT, timeoutMs = 180_000 } = {}
) {
  const server = createServer()
  server.unref()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const failure = await new Promise((settle) => {
      server.once("error", settle)
      server.listen({ exclusive: true, host: "127.0.0.1", port }, () => {
        server.off("error", settle)
        settle(null)
      })
    })
    if (!failure) break
    if (failure.code !== "EADDRINUSE") throw failure
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for another development command to release 127.0.0.1:${port}.`
      )
    }
    await new Promise((settle) => setTimeout(settle, 250))
  }
  try {
    return await work()
  } finally {
    await new Promise((settle) => server.close(settle))
  }
}
