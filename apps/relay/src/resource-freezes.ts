import { Effect } from "effect"

import type { LaneLock } from "./operation-lanes.js"
import type {
  RelayResourceFreezeRecord,
  RelayStateStore,
} from "./effect/state.js"

type FrozenKind = RelayResourceFreezeRecord["kind"]

// What still runs on a frozen resource: its final backup, which only reads
// it, and its deletion. Freezing and letting go again take its locks too.
const allowed: Record<FrozenKind, ReadonlySet<string>> = {
  app: new Set(["app.delete"]),
  database: new Set(["database.delete"]),
  instance: new Set(["instance.delete"]),
  volume: new Set(["relay.volumes.delete"]),
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
  volume: "This volume is being deleted",
}

/**
 * The resources frozen for their deletion, as the lanes see them. Read from
 * the Relay's state before any work is admitted, and kept in step with it.
 */
export class ResourceFreezes {
  readonly #frozen = new Map<string, string>()

  readonly #state: RelayStateStore["Service"]

  private constructor(
    state: RelayStateStore["Service"],
    freezes: ReadonlyArray<RelayResourceFreezeRecord>
  ) {
    this.#state = state
    for (const freeze of freezes) {
      this.#frozen.set(`${freeze.kind}:${freeze.id}`, freeze.deletionId)
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
   * Freezes a resource for a deletion, then stops it with `stop`, inside an
   * operation holding the resource whole. Freezing again for the same
   * deletion stops it again; another deletion's freeze is refused.
   */
  async freeze(
    freeze: RelayResourceFreezeRecord,
    stop: () => Promise<void>
  ): Promise<void> {
    const holder = await Effect.runPromise(
      this.#state.freezeResource(freeze, Date.now())
    )
    if (holder !== freeze.deletionId) {
      throw new Error("Another deletion of it is already under way")
    }
    this.#frozen.set(`${freeze.kind}:${freeze.id}`, freeze.deletionId)
    // Stopped too, so nothing writes between its final backup and its
    // deletion. Starting it again is refused while it's frozen.
    await stop()
  }

  /** Lets a resource go, if the deletion still holds it. */
  async unfreeze(freeze: RelayResourceFreezeRecord): Promise<void> {
    await Effect.runPromise(this.#state.unfreezeResource(freeze))
    const key = `${freeze.kind}:${freeze.id}`
    if (this.#frozen.get(key) === freeze.deletionId) this.#frozen.delete(key)
  }

  /** Drops the freeze of a resource the Relay has deleted. */
  async forget(kind: FrozenKind, id: string): Promise<void> {
    await Effect.runPromise(this.#state.forgetResourceFreeze(kind, id))
    this.#frozen.delete(`${kind}:${id}`)
  }

  has(kind: FrozenKind, id: string): boolean {
    return this.#frozen.has(`${kind}:${id}`)
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
      const kind = resource.slice(0, resource.indexOf(":")) as FrozenKind
      if (!allowed[kind]?.has(label)) return refusals[kind]
    }
    return null
  }
}
