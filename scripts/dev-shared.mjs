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

// For a name read back from the server: test users can create any name under
// their prefix, and root runs what's built from it.
export function sqlIdentifier(value) {
  return `\`${String(value).replaceAll("`", "``")}\``
}

// `_` and `%` are wildcards in a GRANT's database name, even in backticks, so
// `s_abc` unescaped also grants `sXabc`.
export function grantPattern(value) {
  return value.replaceAll(/[\\_%]/gu, "\\$&")
}

const BOX_LOCK_PORT = 29871
const STACK_LOCK_PORTS = 1000
const STACK_LOCK_BASE = 28000
const STACK_LOCK_WAIT_MS = 15 * 60_000

// Compose projects of the box's own services. A stack can't take either name:
// tearing it down would delete what every other stack uses.
const RESERVED_PROJECTS = new Set(["kiln-dev-shared", "kiln-dev-s3"])

export function isReservedProject(name) {
  return RESERVED_PROJECTS.has(name)
}

/**
 * Runs `work` holding the box's one lock, serializing what changes its shared
 * services across checkouts. A listening socket, so the kernel releases it
 * when this process ends, however it ends, and there's nothing stale to
 * judge. Below the Relay's game ports.
 */
export async function withBoxLock(
  work,
  { port = BOX_LOCK_PORT, timeoutMs = 180_000 } = {}
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

/**
 * Runs `work` as the only command changing `stack`, for as long as it takes,
 * so a destroy can't act on what a start has since rebuilt. Stacks sharing a
 * port only wait for each other. Take this before the box lock.
 */
export function withStackLock(stack, work) {
  const hash = createHash("sha256").update(stack).digest()
  return withBoxLock(work, {
    port: STACK_LOCK_BASE + (hash.readUInt32BE(0) % STACK_LOCK_PORTS),
    timeoutMs: STACK_LOCK_WAIT_MS,
  })
}
