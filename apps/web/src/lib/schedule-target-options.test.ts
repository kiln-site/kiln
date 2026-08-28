import { describe, expect, it } from "vite-plus/test"

import type { ScheduleTarget } from "@workspace/contracts"

import { scheduleTargetsWithAvailability } from "./schedule-target-options"

const available: ScheduleTarget = {
  id: "server-a",
  kind: "instance",
  name: "Server A",
  relayId: "relay-a",
}
const removed: ScheduleTarget = {
  id: "server-b",
  kind: "instance",
  name: "Server B",
  relayId: "relay-a",
}

describe("schedule target options", () => {
  it("keeps referenced missing targets available for schedule recovery", () => {
    expect(
      scheduleTargetsWithAvailability([available], [available, removed])
    ).toEqual([
      { ...available, available: true },
      { ...removed, available: false },
    ])
  })

  it("uses the current target name when a stored reference is still live", () => {
    expect(
      scheduleTargetsWithAvailability(
        [{ ...available, name: "Renamed Server" }],
        [available]
      )
    ).toEqual([{ ...available, available: true, name: "Renamed Server" }])
  })
})
