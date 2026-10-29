import { Effect } from "effect"

import type { FrozenResources, LaneLock } from "./operation-lanes.js"
import type {
  RelayResourceFreezeRecord,
  RelayResourceFreezeUndo,
  RelayStateStore,
} from "./effect/state.js"

type FrozenKind = RelayResourceFreezeRecord["kind"]

// What still runs on a frozen resource: its final backup, which only reads
// it, and its deletion. Freezing and letting go again take its locks too.
const allowed: Record<FrozenKind, ReadonlySet<string>> = {
  app: new Set(["app.delete"]),
  database: new Set(["database.delete"]),
  instance: new Set(["instance.delete"]),
}
const allowedForEvery = new Set([
  "backup.create",
  "resource.freeze",
  "resource.unfreeze",
])

const refusals: Record<FrozenKind, string> = {
  app: "This App is being deleted",
  database: "This database is being deleted",
  instance: "This game server is being deleted",
}
// A Tailscale network's change is refused for one of its members, so it
// says which.
const memberNouns: Record<FrozenKind, string> = {
  app: "App",
  database: "Database",
  instance: "Game server",
}

interface Frozen {
  readonly deletionId: string
  undo: RelayResourceFreezeUndo
}

/**
 * The resources frozen for their deletion, as the lanes see them. Read from
 * the Relay's state before any work is admitted, and kept in step with it.
 *
 * Freezing makes sure nothing Kiln starts writes to a resource but its
 * final backup: the lanes refuse every other change to it, and `apply`
 * quiets what could write on its own. A database keeps running for its live
 * dump, so what's connected to it can still write. What `apply` changes is recorded first, so letting it go
 * puts that back.
 */
export class ResourceFreezes implements FrozenResources {
  readonly #frozen = new Map<string, Frozen>()
  readonly #state: RelayStateStore["Service"]

  private constructor(
    state: RelayStateStore["Service"],
    freezes: ReadonlyArray<
      RelayResourceFreezeRecord & { readonly undo: RelayResourceFreezeUndo }
    >
  ) {
    this.#state = state
    for (const freeze of freezes) {
      this.#frozen.set(key(freeze.kind, freeze.id), {
        deletionId: freeze.deletionId,
        undo: freeze.undo,
      })
    }
  }

  /** The freezes the Relay's state holds, read before any work is admitted. */
  static load(state: RelayStateStore["Service"]) {
    return Effect.map(
      state.listResourceFreezes(),
      (freezes) => new ResourceFreezes(state, freezes)
    )
  }

  /**
   * Freezes a resource for a deletion, then quiets it with `apply`, inside
   * an operation holding the resource whole. Freezing again for the same
   * deletion applies it again; another deletion's freeze is refused.
   */
  async freeze(freeze: RelayResourceFreezeRecord, apply: Quiet): Promise<void> {
    const holder = await Effect.runPromise(
      this.#state.freezeResource(freeze, Date.now())
    )
    if (holder !== freeze.deletionId) {
      throw new Error("Another deletion of it is already under way")
    }
    const frozen = this.#frozen.get(key(freeze.kind, freeze.id)) ?? {
      deletionId: freeze.deletionId,
      undo: {},
    }
    this.#frozen.set(key(freeze.kind, freeze.id), frozen)
    await this.#apply(freeze, frozen, apply)
  }

  /**
   * Quiets every frozen resource again as the Relay starts, before any work
   * runs: Docker may have started one, or the Relay may have stopped
   * between freezing one and quieting it.
   */
  async reapply(
    apply: (
      freeze: RelayResourceFreezeRecord,
      record: (undo: RelayResourceFreezeUndo) => Promise<void>
    ) => Promise<void>
  ): Promise<void> {
    for (const [resource, frozen] of this.#frozen) {
      const [kind, id] = resource.split(":") as [FrozenKind, string]
      const freeze = { deletionId: frozen.deletionId, id, kind }
      await this.#apply(freeze, frozen, (record) => apply(freeze, record))
    }
  }

  /**
   * Lets a resource go, if the deletion still holds it, once `restore` has
   * put back what freezing changed. A restore that fails leaves it frozen,
   * for letting it go again.
   */
  async unfreeze(
    freeze: RelayResourceFreezeRecord,
    restore: (undo: RelayResourceFreezeUndo) => Promise<void>
  ): Promise<void> {
    const resource = key(freeze.kind, freeze.id)
    const frozen = this.#frozen.get(resource)
    if (frozen?.deletionId !== freeze.deletionId) return
    await restore(frozen.undo)
    await Effect.runPromise(this.#state.unfreezeResource(freeze))
    this.#frozen.delete(resource)
  }

  /** Drops the freeze of a resource the Relay has deleted. */
  async forget(kind: FrozenKind, id: string): Promise<void> {
    await Effect.runPromise(this.#state.forgetResourceFreeze(kind, id))
    this.#frozen.delete(key(kind, id))
  }

  has(kind: FrozenKind, id: string): boolean {
    return this.#frozen.has(key(kind, id))
  }

  /**
   * Why an operation may not run: it touches a frozen resource and isn't
   * one of the few that still may. Lock keys name the resource first, as
   * `instance:<id>` or a part of it, `instance:<id>/files`.
   */
  refusal(label: string, locks: ReadonlyArray<LaneLock>): string | null {
    if (this.#frozen.size === 0 || allowedForEvery.has(label)) return null
    for (const lock of locks) {
      const resource = lock.key.split("/", 1)[0]!
      if (!this.#frozen.has(resource)) continue
      const separator = resource.indexOf(":")
      const kind = resource.slice(0, separator) as FrozenKind
      if (allowed[kind]?.has(label)) continue
      return label.startsWith("relay.tailscale.stack.")
        ? `${memberNouns[kind]} ${resource.slice(separator + 1, separator + 9)} on this network is being deleted`
        : refusals[kind]
    }
    return null
  }

  // Each change is recorded before it's made, and what was recorded first
  // wins: an App's restart policy is the one it had before the first freeze
  // set it to "no", even if a freeze stopped partway and ran again.
  async #apply(
    freeze: RelayResourceFreezeRecord,
    frozen: Frozen,
    apply: Quiet
  ) {
    await apply(async (changed) => {
      frozen.undo = {
        restartPolicies: {
          ...changed.restartPolicies,
          ...frozen.undo.restartPolicies,
        },
      }
      await Effect.runPromise(
        this.#state.setResourceFreezeUndo(freeze, frozen.undo)
      )
    })
  }
}

/** Quiets a frozen resource, passing each change to `record` before it. */
type Quiet = (
  record: (undo: RelayResourceFreezeUndo) => Promise<void>
) => Promise<void>

function key(kind: FrozenKind, id: string) {
  return `${kind}:${id}`
}
