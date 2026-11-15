import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { migratedTunnelId } from "@workspace/contracts"
import { Effect } from "effect"

import type { RelayConfig } from "./config.js"
import { writeFileAtomic } from "./effect/atomic-file.js"
import type { RelayStateStore } from "./effect/state.js"
import { recoverPromise } from "./effect/promise.js"
import { useInstanceLegacyIds } from "./instance-keys.js"

export interface TunnelIdMigrationInput {
  readonly config: RelayConfig
  /** This Relay's own ID, which each tunnel's is worked out from. */
  readonly relayId: string
  readonly state: RelayStateStore["Service"]
}

/**
 * Gives each Tailscale network's stack on this Relay an ID of its own: a
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
    if (!entry.isDirectory() || !/^(?:[a-f0-9]{40}|[a-f0-9]{12})$/u.test(entry.name))
      continue
    const directory = join(config.rootDirectory, entry.name)
    const stack = await readJson(join(directory, "stack.json"))
    if (!stack || typeof stack.id !== "string") continue
    const known = tunnelsByKey.get(entry.name)
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
    console.info(`Gave ${moved} Tailscale network stacks tunnel IDs`)
  }
  return moved
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
