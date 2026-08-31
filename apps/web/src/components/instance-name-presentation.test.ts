import { describe, expect, it } from "vite-plus/test"

import { instanceStatusPresentation } from "@/components/instance-name-presentation"

describe("instanceStatusPresentation", () => {
  it.each([
    ["provisioning", "Provisioning", "warning"],
    ["stopping", "Stopping", "warning"],
  ] as const)(
    "keeps database %s status consistent across identity and status cells",
    (observedState, label, tone) => {
      expect(
        instanceStatusPresentation({
          id: "database-a",
          inventoryStatus: "available",
          kind: "database",
          observedState,
          relayId: "relay-a",
        })
      ).toEqual({ label, tone })
    }
  )
})
