import type { RelaySystemUpdate } from "@workspace/contracts"

/** One Relay's reported updates, as `getSystemUpdates` returns them. */
export type SystemUpdateReport = {
  name: string
  relayId: string
  state: "reporting" | "unavailable" | "unsupported"
  updates: ReadonlyArray<RelaySystemUpdate>
}

/**
 * What the reports say about an update the browser follows:
 *
 * - `running`, at the phase the Relay reported.
 * - `away`: Hearth or the Relay can't say now, as while either replaces
 *   itself, so the update is waited for.
 * - `absent`: the Relay reports, but not this update.
 * - `unsupported`: the Relay predates reporting updates.
 * - `finished`, with its outcome.
 */
export type ReportedUpdateObservation =
  | { kind: "absent" | "away" | "unsupported" }
  | { kind: "running"; phase: string | null }
  | {
      error: string | null
      kind: "finished"
      status: "failed" | "succeeded"
      version: string
    }

/**
 * Observes one update in the reports, or in none when Hearth couldn't be
 * reached for them.
 */
export function observeReportedUpdate(
  reports: ReadonlyArray<SystemUpdateReport> | null,
  update: { component: "hearth" | "relay"; operationId: string; relayId: string }
): ReportedUpdateObservation {
  if (reports === null) return { kind: "away" }
  const report = reports.find(({ relayId }) => relayId === update.relayId)
  if (!report) return { kind: "absent" }
  if (report.state === "unsupported") return { kind: "unsupported" }
  const reported = report.updates.find(
    ({ component, id }) =>
      id === update.operationId && component === update.component
  )
  // An outcome stays true after the Relay goes away; progress doesn't.
  if (reported && reported.status !== "running") {
    return {
      error: reported.error,
      kind: "finished",
      status: reported.status,
      version: reported.version,
    }
  }
  if (report.state === "unavailable") return { kind: "away" }
  if (!reported) return { kind: "absent" }
  return { kind: "running", phase: reported.phase ?? null }
}

/**
 * The running updates the reports name that the browser doesn't follow yet,
 * as when they were started in another tab or by a reply it lost.
 */
export function unfollowedRunningUpdates(
  reports: ReadonlyArray<SystemUpdateReport>,
  followed: (operationId: string) => boolean
): Array<{ report: SystemUpdateReport; update: RelaySystemUpdate }> {
  return reports.flatMap((report) =>
    report.state === "reporting"
      ? report.updates.flatMap((update) =>
          update.status === "running" && !followed(update.id)
            ? [{ report, update }]
            : []
        )
      : []
  )
}
