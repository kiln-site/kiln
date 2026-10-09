export interface SystemUpdateActivity {
  name: string
  operationId: string
  phase?: string
  targetKey: string
}

export interface SystemUpdateActivityStore {
  getActivitiesSnapshot: () => ReadonlyArray<SystemUpdateActivity>
  getBusySnapshot: () => boolean
  getHearthReloadRequiredSnapshot: () => boolean
  getPhaseSnapshot: (operationId: string) => string | undefined
  getTargetActivitySnapshot: (
    targetKey: string
  ) => SystemUpdateActivity | undefined
  getTargetFailureSnapshot: (targetKey: string) => string | undefined
  setActivities: (activities: ReadonlyArray<SystemUpdateActivity>) => void
  setHearthReloadRequired: (required: boolean) => void
  setPhase: (operationId: string, phase: string) => void
  setTargetFailure: (targetKey: string, message: string | null) => void
  subscribeActivities: (listener: () => void) => () => void
  subscribeHearthReloadRequired: (listener: () => void) => () => void
  subscribePhase: (operationId: string, listener: () => void) => () => void
  subscribeTargetActivity: (
    targetKey: string,
    listener: () => void
  ) => () => void
  subscribeTargetFailure: (
    targetKey: string,
    listener: () => void
  ) => () => void
}

export function createSystemUpdateActivityStore(): SystemUpdateActivityStore {
  let activities: ReadonlyArray<SystemUpdateActivity> = []
  let hearthReloadRequired = false
  const phases = new Map<string, string>()
  const failures = new Map<string, string>()
  const activityListeners = new Set<() => void>()
  const hearthReloadRequiredListeners = new Set<() => void>()
  const phaseListeners = new Map<string, Set<() => void>>()
  const targetListeners = new Map<string, Set<() => void>>()
  const failureListeners = new Map<string, Set<() => void>>()

  const subscribeKeyed = (
    listeners: Map<string, Set<() => void>>,
    key: string,
    listener: () => void
  ) => {
    const keyListeners = listeners.get(key) ?? new Set()
    keyListeners.add(listener)
    listeners.set(key, keyListeners)
    return () => {
      keyListeners.delete(listener)
      if (keyListeners.size === 0) listeners.delete(key)
    }
  }

  return {
    getActivitiesSnapshot: () => activities,
    getBusySnapshot: () => activities.length > 0,
    getHearthReloadRequiredSnapshot: () => hearthReloadRequired,
    getPhaseSnapshot: (operationId) => phases.get(operationId),
    getTargetActivitySnapshot: (targetKey) =>
      activities.find((activity) => activity.targetKey === targetKey),
    getTargetFailureSnapshot: (targetKey) => failures.get(targetKey),
    setActivities: (nextActivities) => {
      const previousByTarget = new Map(
        activities.map((activity) => [activity.targetKey, activity])
      )
      const nextByTarget = new Map(
        nextActivities.map((activity) => [activity.targetKey, activity])
      )
      if (
        previousByTarget.size === nextByTarget.size &&
        [...previousByTarget].every(
          ([targetKey, activity]) =>
            nextByTarget.get(targetKey)?.operationId === activity.operationId
        )
      ) {
        return
      }
      activities = [...nextActivities]
      for (const listener of activityListeners) listener()
      const targetKeys = new Set([
        ...previousByTarget.keys(),
        ...nextByTarget.keys(),
      ])
      for (const targetKey of targetKeys) {
        if (
          previousByTarget.get(targetKey)?.operationId ===
          nextByTarget.get(targetKey)?.operationId
        ) {
          continue
        }
        for (const listener of targetListeners.get(targetKey) ?? []) listener()
      }
    },
    setHearthReloadRequired: (required) => {
      if (hearthReloadRequired === required) return
      hearthReloadRequired = required
      for (const listener of hearthReloadRequiredListeners) listener()
    },
    setPhase: (operationId, phase) => {
      if (phases.get(operationId) === phase) return
      phases.set(operationId, phase)
      for (const listener of phaseListeners.get(operationId) ?? []) listener()
    },
    setTargetFailure: (targetKey, message) => {
      if ((failures.get(targetKey) ?? null) === message) return
      if (message === null) failures.delete(targetKey)
      else failures.set(targetKey, message)
      for (const listener of failureListeners.get(targetKey) ?? []) listener()
    },
    subscribeActivities: (listener) => {
      activityListeners.add(listener)
      return () => activityListeners.delete(listener)
    },
    subscribeHearthReloadRequired: (listener) => {
      hearthReloadRequiredListeners.add(listener)
      return () => hearthReloadRequiredListeners.delete(listener)
    },
    subscribePhase: (operationId, listener) =>
      subscribeKeyed(phaseListeners, operationId, listener),
    subscribeTargetActivity: (targetKey, listener) =>
      subscribeKeyed(targetListeners, targetKey, listener),
    subscribeTargetFailure: (targetKey, listener) =>
      subscribeKeyed(failureListeners, targetKey, listener),
  }
}
