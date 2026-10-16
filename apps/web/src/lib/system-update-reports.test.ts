import type { RelaySystemUpdate } from "@workspace/contracts"
import { describe, expect, it } from "vite-plus/test"

import {
  observeReportedUpdate,
  unfollowedRunningUpdates,
  type SystemUpdateReport,
} from "./system-update-reports"

const operationId = "6f1c1f39-4d8b-4a1e-9a43-6a0b8c6f2d11"
const relayUpdate = { component: "relay", operationId, relayId: "relay-a" } as const

function update(overrides: Partial<RelaySystemUpdate> = {}): RelaySystemUpdate {
  return {
    component: "relay",
    error: null,
    finishedAt: null,
    id: operationId,
    phase: "replace.startTarget",
    startedAt: "2026-10-16T10:00:00.000Z",
    status: "running",
    version: "0.1.0-nightly.20261016.120000",
    ...overrides,
  }
}

function report(
  state: SystemUpdateReport["state"],
  updates: Array<RelaySystemUpdate>
): Array<SystemUpdateReport> {
  return [{ name: "Relay A", relayId: "relay-a", state, updates }]
}

describe("system update reports", () => {
  it("waits for a Relay or Hearth that's away mid-update instead of failing it", () => {
    // The Relay restarted into its new version and hasn't reported again.
    expect(
      observeReportedUpdate(report("unavailable", [update()]), relayUpdate)
    ).toEqual({ kind: "away" })
    // Hearth itself couldn't be reached, as while it's replaced.
    expect(observeReportedUpdate(null, relayUpdate)).toEqual({ kind: "away" })
    // Back, and reporting how it went.
    expect(
      observeReportedUpdate(
        report("reporting", [
          update({ finishedAt: "2026-10-16T10:01:00.000Z", status: "succeeded" }),
        ]),
        relayUpdate
      )
    ).toEqual({
      error: null,
      kind: "finished",
      status: "succeeded",
      version: "0.1.0-nightly.20261016.120000",
    })
  })

  it("keeps an outcome reported before the Relay went away", () => {
    expect(
      observeReportedUpdate(
        report("unavailable", [
          update({ error: "Health check timed out", status: "failed" }),
        ]),
        relayUpdate
      )
    ).toMatchObject({ error: "Health check timed out", kind: "finished" })
  })

  it("tells a Relay with no record of the update from one that can't report", () => {
    expect(
      observeReportedUpdate(report("reporting", []), relayUpdate)
    ).toEqual({ kind: "absent" })
    // Another component's update with the same ID isn't this one.
    expect(
      observeReportedUpdate(
        report("reporting", [update({ component: "hearth" })]),
        relayUpdate
      )
    ).toEqual({ kind: "absent" })
    expect(
      observeReportedUpdate(report("unsupported", []), relayUpdate)
    ).toEqual({ kind: "unsupported" })
  })

  it("finds running updates the browser doesn't follow from current reports only", () => {
    const hearthId = "0d3c2b1a-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
    const reports: Array<SystemUpdateReport> = [
      ...report("reporting", [
        update(),
        update({ component: "hearth", id: hearthId }),
      ]),
      // What a Relay that's away last said may be over by now.
      {
        name: "Relay B",
        relayId: "relay-b",
        state: "unavailable",
        updates: [update({ id: "9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d" })],
      },
    ]

    expect(
      unfollowedRunningUpdates(reports, (id) => id === operationId).map(
        ({ report, update }) => [report.relayId, update.id]
      )
    ).toEqual([["relay-a", hearthId]])
  })
})
