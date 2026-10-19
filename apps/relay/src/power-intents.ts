/**
 * Counts the power changes someone asked for on each game server, outside a
 * schedule: a power action from Hearth or a stop typed into a console. A
 * schedule notes the count, with how often the server has been replaced
 * (`OperationLanes.exclusiveGeneration`), when an occurrence begins. Its
 * later power steps don't run once either has moved, so a schedule's Start
 * can't undo a person's Stop made during its Wait.
 *
 * A change counts once the work making it starts. Conflicting work runs in
 * order, so a schedule step waiting behind it sees the new count.
 */
export class PowerIntents {
  readonly #generations = new Map<string, number>()

  current(instanceId: string): number {
    return this.#generations.get(instanceId) ?? 0
  }

  advance(instanceId: string): void {
    this.#generations.set(instanceId, this.current(instanceId) + 1)
  }
}
