import type { IdentityStatusPresentation } from "@/components/identity-name"
import type {
  AppDeploymentStatus,
  AppDeploymentTrigger,
} from "@/effect/app-deployments"

// How a recorded deployment reads, on the Deployments page and an app's
// rail.

export function deploymentStatusPresentation(deployment: {
  error: string | null
  rolling: boolean | null
  status: AppDeploymentStatus
}): IdentityStatusPresentation {
  switch (deployment.status) {
    case "running":
      return { label: "Deploying", pulse: true, tone: "info" }
    case "failed":
      return {
        ...(deployment.error && { detail: deployment.error }),
        label: "Failed",
        tone: "danger",
      }
    case "unknown":
      return {
        ...(deployment.error && { detail: deployment.error }),
        label: "Unknown",
        tone: "warning",
      }
    case "succeeded":
      return {
        ...(deployment.rolling !== null && {
          detail: deployment.rolling
            ? "Switched over once the new containers were healthy"
            : "Replaced the running containers",
        }),
        label: "Deployed",
        tone: "success",
      }
  }
}

export const deploymentTriggerLabels: Record<AppDeploymentTrigger, string> = {
  manual: "Manual",
  poll: "New commit",
  push: "Push",
  redeploy: "Redeploy",
}

/** How long it took, as in 1m 12s; null while it runs. */
export function deploymentDuration(deployment: {
  finishedAt: string | null
  startedAt: string
}): string | null {
  if (!deployment.finishedAt) return null
  const seconds = Math.max(
    0,
    Math.round(
      (Date.parse(deployment.finishedAt) - Date.parse(deployment.startedAt)) /
        1_000
    )
  )
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

export function shortCommit(sha: string): string {
  return sha.slice(0, 7)
}
