import { describe, expect, it } from "vite-plus/test"

import { backupDestinationUse } from "./use"

const destination = (
  ownerUserId: string | null,
  state: { deleting?: boolean; enabled?: boolean } = {}
) => ({ deleting: false, enabled: true, ownerUserId, ...state })

// Who may send a backup where: a destination someone else owns hands its
// owner whatever it is sent.
describe("backup destination use", () => {
  const me = { platformTarget: false, userId: "me" }

  it("opens a shared destination to anyone, and a personal one to its owner alone", () => {
    expect(backupDestinationUse(destination(null), me)).toBe("shared")
    expect(backupDestinationUse(destination("me"), me)).toBe("personal")
    expect(backupDestinationUse(destination("them"), me)).toBe("unavailable")
  })

  it("keeps Kiln's own backup out of anyone's personal destination", () => {
    const kiln = { platformTarget: true, userId: "me" }
    expect(backupDestinationUse(destination(null), kiln)).toBe("shared")
    expect(backupDestinationUse(destination("me"), kiln)).toBe("platform_only")
    // Someone else's reads the same as one that isn't there.
    expect(backupDestinationUse(destination("them"), kiln)).toBe("unavailable")
  })

  it("refuses one that is gone, disabled or being deleted, whoever asks", () => {
    for (const gone of [
      null,
      destination(null, { enabled: false }),
      destination("me", { deleting: true }),
    ]) {
      expect(backupDestinationUse(gone, me)).toBe("unavailable")
    }
  })
})
