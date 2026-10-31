export type SystemUpdateBatchState<Failure, HearthCompletion> = {
  active: boolean
  failures: ReadonlyArray<Failure>
  hearthCompletion: HearthCompletion | null
  // Updates whose Relay has no record of how they ended.
  unconfirmed: ReadonlyArray<Failure>
  versionName: string | null
}

export function inactiveSystemUpdateBatch<
  Failure,
  HearthCompletion,
>(): SystemUpdateBatchState<Failure, HearthCompletion> {
  return {
    active: false,
    failures: [],
    hearthCompletion: null,
    unconfirmed: [],
    versionName: null,
  }
}

export function beginSystemUpdateBatch<Failure, HearthCompletion>(
  state: SystemUpdateBatchState<Failure, HearthCompletion>,
  versionName: string
): SystemUpdateBatchState<Failure, HearthCompletion> {
  if (state.active) return state
  return {
    active: true,
    failures: [],
    hearthCompletion: null,
    unconfirmed: [],
    versionName,
  }
}

export function recordSystemUpdateFailure<Failure, HearthCompletion>(
  state: SystemUpdateBatchState<Failure, HearthCompletion>,
  failure: Failure
): SystemUpdateBatchState<Failure, HearthCompletion> {
  return { ...state, failures: [...state.failures, failure] }
}

export function recordSystemUpdateUnconfirmed<Failure, HearthCompletion>(
  state: SystemUpdateBatchState<Failure, HearthCompletion>,
  update: Failure
): SystemUpdateBatchState<Failure, HearthCompletion> {
  return { ...state, unconfirmed: [...state.unconfirmed, update] }
}

export function recordHearthUpdateCompletion<Failure, HearthCompletion>(
  state: SystemUpdateBatchState<Failure, HearthCompletion>,
  completion: HearthCompletion
): SystemUpdateBatchState<Failure, HearthCompletion> {
  return { ...state, hearthCompletion: completion }
}

export function isHearthUpdateLocked<Failure, HearthCompletion>(
  state: SystemUpdateBatchState<Failure, HearthCompletion>
): boolean {
  return state.active && state.hearthCompletion !== null
}

export function canStartSystemUpdate({
  hearthReloadRequired,
  mutationPending,
}: {
  hearthReloadRequired: boolean
  mutationPending: boolean
}): boolean {
  return !hearthReloadRequired && !mutationPending
}

export function systemUpdateCompletionDisposition(
  component: "hearth" | "relay",
  outcome: "failed" | "succeeded"
): { clearPresence: boolean; lockUntilReload: boolean } {
  const lockUntilReload = component === "hearth" && outcome === "succeeded"
  return {
    clearPresence: !lockUntilReload,
    lockUntilReload,
  }
}
