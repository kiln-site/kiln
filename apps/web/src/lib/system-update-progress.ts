export type SystemUpdateProgress = {
  label: string
  percent: number
  /** Index into systemUpdateSteps; equals its length once the update finishes. */
  step: number
}

export const systemUpdateSteps = [
  "Prepare",
  "Swap",
  "Start",
  "Health",
  "Clean up",
] as const

const progressByPhase: Readonly<Record<string, SystemUpdateProgress>> = {
  Preparing: { label: "Preparing update", percent: 5, step: 0 },
  awaitingReload: { label: "Update complete", percent: 100, step: 5 },
  completed: { label: "Update complete", percent: 100, step: 5 },
  reconnecting: { label: "Reconnecting to Kiln", percent: 88, step: 3 },
  "replace.inspectContainer": {
    label: "Checking container",
    percent: 10,
    step: 0,
  },
  "replace.inspectImage": { label: "Checking image", percent: 10, step: 0 },
  "replace.tagTarget": { label: "Preparing image", percent: 20, step: 0 },
  "replace.stopCurrent": { label: "Stopping container", percent: 32, step: 1 },
  "replace.renameCurrent": {
    label: "Swapping containers",
    percent: 44,
    step: 1,
  },
  "replace.createTarget": { label: "Creating container", percent: 56, step: 1 },
  "replace.connectNetwork": {
    label: "Connecting network",
    percent: 64,
    step: 1,
  },
  "replace.startTarget": { label: "Starting container", percent: 76, step: 2 },
  "replace.waitUntilHealthy": {
    label: "Waiting for health check",
    percent: 90,
    step: 3,
  },
  "replace.removeBackup": {
    label: "Removing old container",
    percent: 96,
    step: 4,
  },
}

export function systemUpdateProgress(
  phase: string | undefined,
  reconnecting: boolean
): SystemUpdateProgress {
  if (reconnecting) return progressByPhase.reconnecting
  return progressByPhase[phase ?? "Preparing"] ?? progressByPhase.Preparing
}
