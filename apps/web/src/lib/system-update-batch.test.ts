import { describe, expect, it } from "vite-plus/test"

import {
  beginSystemUpdateBatch,
  inactiveSystemUpdateBatch,
  isHearthUpdateLocked,
  recordHearthUpdateCompletion,
  recordSystemUpdateFailure,
  systemUpdateCompletionDisposition,
} from "./system-update-batch"
import {
  clearSystemUpdateActive,
  isHearthSystemUpdateActive,
  markSystemUpdateActive,
} from "./system-update-presence"

describe("system update batch", () => {
  it("preserves mixed-batch completion when another start is attempted", () => {
    let batch = inactiveSystemUpdateBatch<string, { version: string }>()
    batch = beginSystemUpdateBatch(batch, "v0.2.0")
    batch = recordSystemUpdateFailure(batch, "Relay failed")
    batch = recordHearthUpdateCompletion(batch, { version: "0.2.0" })

    const continued = beginSystemUpdateBatch(batch, "v0.3.0")

    expect(continued).toBe(batch)
    expect(continued.failures).toEqual(["Relay failed"])
    expect(continued.hearthCompletion).toEqual({ version: "0.2.0" })
    expect(continued.versionName).toBe("v0.2.0")
    expect(isHearthUpdateLocked(continued)).toBe(true)
  })

  it("keeps successful Hearth presence until reload", () => {
    const update: Parameters<typeof markSystemUpdateActive>[0] = {
      component: "hearth",
      operationId: "test-hearth-success",
      relayId: "test-relay",
    }
    const disposition = systemUpdateCompletionDisposition("hearth", "succeeded")

    markSystemUpdateActive(update)
    if (disposition.clearPresence) clearSystemUpdateActive(update)

    expect(isHearthSystemUpdateActive()).toBe(true)
    expect(disposition).toEqual({
      clearPresence: false,
      lockUntilReload: true,
    })
    expect(systemUpdateCompletionDisposition("relay", "succeeded")).toEqual({
      clearPresence: true,
      lockUntilReload: false,
    })
    expect(systemUpdateCompletionDisposition("hearth", "failed")).toEqual({
      clearPresence: true,
      lockUntilReload: false,
    })
    clearSystemUpdateActive(update)
    expect(isHearthSystemUpdateActive()).toBe(false)
  })
})
