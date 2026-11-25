import { describe, expect, it } from "vite-plus/test"

import { backupRepositoryPassword, backupRepositoryRoot } from "./index.js"

describe("Kiln's password for a backup repository", () => {
  // Repositories are opened with it long after the release that added it.
  it("is the same for a recovery code and repository in every release", async () => {
    const root = await backupRepositoryRoot("recovery-key")
    expect(root).toBe("WuBtUDO3AItiiOjG5sVqSPeYfoBi7p5ikBA3UeoN-yY")
    expect(
      await backupRepositoryPassword(
        root,
        "66666666-6666-4666-8666-666666666666"
      )
    ).toBe("XroQw3Iybv5QFY-Oqkt35R8elTdSsAT_rFJgwxSs46U")
  })
})
