import { describe, expect, it } from "vite-plus/test"

import {
  withMadeVolume,
  type DraftSource,
  type MountDraft,
} from "@/components/app/app-mount-drafts"

const draft = (id: string, source: DraftSource): MountDraft => ({
  id,
  readOnly: false,
  service: null,
  source,
  target: `/${id}`,
})
const newVolume = (name: string): DraftSource => ({
  name,
  type: "volume",
  volumeId: null,
})

describe("withMadeVolume", () => {
  it("gives a new volume to every draft naming it, so a retry can't split it", () => {
    // `other` failed to save after `data` was made.
    const drafts = withMadeVolume(
      [
        draft("one", newVolume("data")),
        draft("two", newVolume("other")),
        draft("three", newVolume(" data ")),
      ],
      "data",
      "made-id"
    )
    expect(drafts.map(({ source }) => source)).toEqual([
      { name: "data", type: "volume", volumeId: "made-id" },
      newVolume("other"),
      { name: "data", type: "volume", volumeId: "made-id" },
    ])
  })

  it("leaves a chosen volume and other mounts alone", () => {
    const chosen = draft("one", {
      name: "data",
      type: "volume",
      volumeId: "chosen-id",
    })
    const folder = draft("two", { path: "/srv/data", type: "host" })
    expect(withMadeVolume([chosen, folder], "data", "made-id")).toEqual([
      chosen,
      folder,
    ])
  })
})
