import type { PowerResourceKind } from "./operation-plans.js"

/**
 * Counts the power changes someone asked for on each game server, App, and
 * database, outside a schedule: a power action from Hearth or a stop typed
 * into a game server's console. A schedule notes the count, with how often
 * the resource has been replaced (`OperationLanes.exclusiveGeneration`), when
 * an occurrence begins. Its later power steps don't run once either has
 * moved, so a schedule's Start can't undo a person's Stop made during its
 * Wait.
 *
 * A change counts once the work making it starts. Conflicting work runs in
 * order, so a schedule step waiting behind it sees the new count.
 */
export class PowerIntents {
  readonly #generations = new Map<string, number>()

  current(kind: PowerResourceKind, id: string): number {
    return this.#generations.get(`${kind}:${id}`) ?? 0
  }

  advance(kind: PowerResourceKind, id: string): void {
    this.#generations.set(`${kind}:${id}`, this.current(kind, id) + 1)
  }
}
