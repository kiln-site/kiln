import type { RelayVolume } from "@workspace/contracts"
import { describe, expect, it } from "vite-plus/test"

import { appVolumesOf } from "@/lib/app-volumes"

const app = "a".repeat(40)
const other = "b".repeat(40)

const mount = (resourceId: string): RelayVolume["mounts"][number] => ({
  container: `container-${resourceId}`,
  destination: "/data",
  kind: "app",
  readOnly: false,
  resourceId,
  running: true,
})
const user = (appId: string): RelayVolume["users"][number] => ({
  appId,
  configured: true,
  mounted: true,
})
const volume = (fields: Partial<RelayVolume>): RelayVolume => ({
  createdAt: null,
  dockerName: "kiln-volume",
  id: "c".repeat(40),
  kind: "kiln",
  mountpoint: "/var/lib/docker/volumes/kiln-volume/_data",
  mounts: [],
  name: "Volume",
  owner: null,
  sizeBytes: 0,
  users: [],
  ...fields,
})

describe("appVolumesOf", () => {
  it("shows an App only what it owns or uses", () => {
    const owned = volume({
      id: `${app}/data`,
      kind: "app",
      name: "owned",
      owner: { appId: app, volume: "data" },
    })
    const shared = volume({ name: "shared", users: [user(app), user(other)] })
    const elsewhere = volume({ name: "elsewhere", users: [user(other)] })
    expect(
      appVolumesOf([owned, shared, elsewhere], app).map(({ name }) => name)
    ).toEqual(["owned", "shared"])
  })

  it("leaves out the host, and what else uses a shared volume", () => {
    const [shared] = appVolumesOf(
      [
        volume({
          mounts: [mount(app), mount(other)],
          owner: { appId: other, volume: "data" },
          users: [user(app), user(other)],
        }),
      ],
      app
    )
    expect(shared).toMatchObject({
      mountpoint: null,
      mounts: [mount(app)],
      owner: null,
      users: [user(app)],
    })
  })
})
