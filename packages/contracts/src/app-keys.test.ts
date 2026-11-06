import { describe, expect, it } from "vite-plus/test"

import {
  appFileRootId,
  appIdFromFileRoot,
  appVolumeFileRootId,
  appVolumeFromFileRoot,
  fileRootIdSchema,
  isServerFileRoot,
} from "./app-keys.js"

const appId = "a".repeat(40)
const volumeId = "b".repeat(40)

// A root's ID is how a Relay decides whose files a request reaches and which
// permission it takes, so a volume's must stay an App's.
describe("App volume file roots", () => {
  it.each([
    ["a Kiln volume", volumeId],
    ["a Compose file's volume", `${appId}/site_data.v2`],
  ])("round trips %s as a root of its App", (_, id) => {
    const root = appVolumeFileRootId(appId, id)
    expect(fileRootIdSchema.safeParse(root).success).toBe(true)
    expect(appVolumeFromFileRoot(root)).toEqual({ appId, volumeId: id })
    expect(appIdFromFileRoot(root)).toBe(appId)
    expect(isServerFileRoot(root)).toBe(false)
  })

  it("leaves an App's own folder alone", () => {
    expect(appVolumeFromFileRoot(appFileRootId(appId))).toBeNull()
    expect(appIdFromFileRoot(appFileRootId(appId))).toBe(appId)
  })

  it.each([
    `app:${appId}:volume:../../etc`,
    `app:${appId}:volume:${volumeId}/../x`,
    `app:${appId}:volume:${volumeId}:..%2f`,
    `app:${appId}:volume:`,
  ])("refuses %s", (root) => {
    expect(fileRootIdSchema.safeParse(root).success).toBe(false)
    expect(appVolumeFromFileRoot(root)).toBeNull()
    expect(appIdFromFileRoot(root)).toBeNull()
  })
})
