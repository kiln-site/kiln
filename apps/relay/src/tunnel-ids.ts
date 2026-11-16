import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { migratedTunnelId } from "@workspace/contracts"
import type { TunnelBrickRecord } from "@workspace/contracts"
import { Effect } from "effect"

import type { RelayConfig } from "./config.js"
import { writeFileAtomic } from "./effect/atomic-file.js"
import type { RelayStateStore } from "./effect/state.js"
import { recoverPromise } from "./effect/promise.js"
import { useInstanceLegacyIds } from "./instance-keys.js"
import { tunnelCoreDnsRecords } from "./private-network.js"

export interface TunnelIdMigrationInput {
  readonly config: RelayConfig
  /** This Relay's own ID, which each tunnel's is worked out from. */
  readonly relayId: string
  readonly state: RelayStateStore["Service"]
}

/**
 * Gives each tailnet's stack on this Relay an ID of its own: a
 * tunnel's, worked out from the network's ID and this Relay's
 * (`migratedTunnelId`), as Hearth works it out on its side. Nothing physical
 * moves. The tunnel takes the key the network's folder, containers and
 * Docker network are named by, so its Tailscale identity, state, subnet and
 * members stay as they were, and its saved files are rewritten to its ID.
 * The containers are made again with a tunnel's labels later
 * (`LifecycleDriver.relabelTunnels`).
 *
 * Runs at startup, after the move to 12-character IDs and before anything
 * reads a stack. Safe to repeat and to interrupt: a stack whose files still
 * name the network finishes moving on the next start.
 */
export async function migrateTunnelIds(
  input: TunnelIdMigrationInput
): Promise<number> {
  const { config, relayId, state } = input
  const entries = await recoverPromise(
    () =>
      readdir(config.rootDirectory, { encoding: "utf8", withFileTypes: true }),
    (cause) => {
      if (hasErrorCode(cause, "ENOENT")) return []
      throw cause
    }
  )
  const tunnelsByKey = new Map(
    (await Effect.runPromise(state.instanceIds.list()))
      .filter((entry) => entry.kind === "tunnel")
      .map((entry) => [entry.legacyId, entry.id])
  )
  let moved = 0
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{12})$/u.test(entry.name)
    )
      continue
    const directory = join(config.rootDirectory, entry.name)
    const stack = await readJson(join(directory, "stack.json"))
    if (!stack || typeof stack.id !== "string") continue
    const known = tunnelsByKey.get(entry.name)
    // A stack that names its tailnet is a tunnel's: one made as a tunnel
    // has no old key to find it by. A network's never named one, and one
    // moving names it only once it has moved.
    if (!known && typeof stack.tailnetId === "string") continue
    if (known && stack.id === known) {
      // Moved; only a pending removal's snapshot may still read as before.
      const tailnetId =
        typeof stack.tailnetId === "string" ? stack.tailnetId : null
      await rewrite(join(directory, ".removing-stack.json"), known, tailnetId)
      continue
    }
    // Its tailnet is the network it was a stack of.
    const tailnetId = stack.id
    const tunnelId = known ?? (await migratedTunnelId(stack.id, relayId))
    if (!known) {
      await Effect.runPromise(
        state.instanceIds.moveToTunnel({
          legacyId: entry.name,
          networkId: stack.id,
          tunnelId,
        })
      )
      tunnelsByKey.set(entry.name, tunnelId)
    }
    // The stack itself last, as what says it has moved.
    await rewrite(join(directory, ".removing-stack.json"), tunnelId, tailnetId)
    await rewrite(join(directory, "dns-records.json"), tunnelId, null)
    await rewrite(join(directory, "stack.json"), tunnelId, tailnetId)
    moved += 1
  }
  useInstanceLegacyIds(await Effect.runPromise(state.instanceIds.list()))
  if (moved > 0) {
    console.info(`Gave ${moved} tailnet stacks tunnel IDs`)
  }
  return moved
}

/**
 * Moves each tunnel's saved files to whole names: its stack names its
 * tailnet's TLDs (`domains`) rather than one domain, its members no longer
 * carry a hostname (Hearth keeps every name), and its records are whole
 * names. A tunnel whose records were still inline in its Corefile has them
 * saved as a records file. Runs at startup, after the IDs move and before
 * anything reads a stack. Safe to repeat and to interrupt: each file moves
 * on its own, its records last, as they need the stack's domain.
 */
export async function migrateTunnelNames(config: RelayConfig): Promise<number> {
  const entries = await recoverPromise(
    () =>
      readdir(config.rootDirectory, { encoding: "utf8", withFileTypes: true }),
    (cause) => {
      if (hasErrorCode(cause, "ENOENT")) return []
      throw cause
    }
  )
  let moved = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = join(config.rootDirectory, entry.name)
    const stack = await readJson(join(directory, "stack.json"))
    if (!stack) continue
    const domain =
      typeof stack.domain === "string"
        ? stack.domain
        : Array.isArray(stack.domains) && typeof stack.domains[0] === "string"
          ? stack.domains[0]
          : null
    if (!domain) continue
    await rewriteRecords(directory, domain)
    const snapshotMoved = await rewriteNames(
      join(directory, ".removing-stack.json")
    )
    const stackMoved = await rewriteNames(join(directory, "stack.json"))
    if (snapshotMoved || stackMoved) moved += 1
  }
  return moved
}

/**
 * What a tunnel made before tunnels ran Bricks runs: Kiln's `tailscale`
 * Brick, at the images every stack ran then. Frozen: it describes
 * containers that already exist, so it never follows what the official
 * Brick comes to pin. It has no source, as a database from then has none.
 */
const PRE_BRICK_TUNNEL: TunnelBrickRecord = {
  id: "tailscale",
  images: {
    dns: "coredns/coredns:1.14.7",
    tailscale: "tailscale/tailscale:stable",
  },
  revision: 1,
  source: null,
}

/**
 * Gives each stack saved before tunnels ran Bricks the Brick it runs, and
 * its removal snapshot with it, so nothing about its containers changes.
 * Says how many it gave one.
 */
export async function migrateTunnelBricks(
  config: RelayConfig
): Promise<number> {
  const entries = await recoverPromise(
    () =>
      readdir(config.rootDirectory, { encoding: "utf8", withFileTypes: true }),
    (cause) => {
      if (hasErrorCode(cause, "ENOENT")) return []
      throw cause
    }
  )
  let moved = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = join(config.rootDirectory, entry.name)
    const snapshotMoved = await recordBrick(
      join(directory, ".removing-stack.json")
    )
    const stackMoved = await recordBrick(join(directory, "stack.json"))
    if (snapshotMoved || stackMoved) moved += 1
  }
  return moved
}

// A stack or a removal's snapshot with the Brick it runs. Says whether it
// changed.
async function recordBrick(path: string): Promise<boolean> {
  const saved = await readJson(path)
  if (!saved || "brick" in saved) return false
  await Effect.runPromise(
    writeFileAtomic(
      path,
      `${JSON.stringify({ ...saved, brick: PRE_BRICK_TUNNEL }, null, 2)}\n`,
      0o600
    )
  )
  return true
}

// A stack, or a removal's snapshot of one, with its TLDs and members as
// they are now kept. Says whether it changed.
async function rewriteNames(path: string): Promise<boolean> {
  const saved = await readJson(path)
  if (!saved) return false
  const { domain, ...rest } = saved
  const next: Record<string, unknown> = {
    ...rest,
    ...(typeof domain === "string" && !("domains" in rest)
      ? { domains: [domain] }
      : {}),
    bindings: Array.isArray(rest.bindings)
      ? rest.bindings.map((binding: unknown) => {
          if (typeof binding !== "object" || binding === null) return binding
          const { hostname: _hostname, ...kept } = binding as Record<
            string,
            unknown
          >
          return kept
        })
      : rest.bindings,
  }
  if (JSON.stringify(next) === JSON.stringify(saved)) return false
  await Effect.runPromise(
    writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, 0o600)
  )
  return true
}

// Its records as whole names, from its records file or, without one, from
// the records its Corefile held inline.
async function rewriteRecords(directory: string, domain: string) {
  const path = join(directory, "dns-records.json")
  const saved = await readJson(path)
  const records = saved
    ? Array.isArray(saved.records)
      ? saved.records
      : []
    : tunnelCoreDnsRecords(
        domain,
        (await recoverPromise(
          () => readFile(join(directory, "Corefile"), "utf8"),
          () => null
        )) ?? ""
      )
  const named = records.map((record: unknown) => {
    if (typeof record !== "object" || record === null) return record
    const { hostname, ...rest } = record as Record<string, unknown>
    return typeof hostname === "string" && !("name" in rest)
      ? { ...rest, name: `${hostname.replace(/\.$/u, "")}.${domain}` }
      : rest
  })
  const id = saved?.id ?? (await readJson(join(directory, "stack.json")))?.id
  const next = { id, records: named }
  if (saved && JSON.stringify(next) === JSON.stringify(saved)) return
  if (!saved && named.length === 0) return
  await Effect.runPromise(
    writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, 0o600)
  )
}

// A saved file as the tunnel's: its ID and, for its stack and a pending
// removal's snapshot of it, its tailnet's, and the snapshot's state in
// place of the game server it read as.
async function rewrite(
  path: string,
  tunnelId: string,
  tailnetId: string | null
) {
  const saved = await readJson(path)
  if (!saved) return
  const { instance: _instance, ...rest } = saved
  const next = {
    ...rest,
    id: tunnelId,
    ...(tailnetId && !("tailnetId" in rest) ? { tailnetId } : {}),
    ...("components" in rest && !("observedState" in rest)
      ? { observedState: "stopped" }
      : {}),
  }
  if (JSON.stringify(next) === JSON.stringify(saved)) return
  await Effect.runPromise(
    writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, 0o600)
  )
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const text = await recoverPromise(
    () => readFile(path, "utf8"),
    (cause) => {
      if (hasErrorCode(cause, "ENOENT")) return null
      throw cause
    }
  )
  if (text === null) return null
  const parsed: unknown = JSON.parse(text)
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null
}

function hasErrorCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code: unknown }).code === code
  )
}
