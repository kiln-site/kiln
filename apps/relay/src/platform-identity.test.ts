import { describe, expect, it } from "vite-plus/test"

import { isOwnContainer, mountIdentity } from "./platform-identity.js"

const relayId = "d".repeat(64)
const sidecarId = "e".repeat(64)

// /proc/self/mountinfo of a Relay started with its data volume at /data.
function mountinfo(hostnameFrom: string) {
  return [
    "2374 2344 252:0 /var/lib/docker/volumes/kiln-relay-data/_data /data rw,relatime master:1 - ext4 /dev/sda1 rw",
    `2376 2344 252:0 /var/lib/docker/containers/${hostnameFrom}/hostname /etc/hostname rw,relatime - ext4 /dev/sda1 rw`,
    `2377 2344 252:0 /var/lib/docker/containers/${hostnameFrom}/hosts /etc/hosts rw,relatime - ext4 /dev/sda1 rw`,
  ].join("\n")
}

const relayMounts = [
  {
    Destination: "/data",
    Source: "/var/lib/docker/volumes/kiln-relay-data/_data",
  },
]

describe("the Relay's own container", () => {
  it("is the container its hostname comes from, mounting its data", () => {
    const identity = mountIdentity(mountinfo(relayId), "/data")

    expect(
      isOwnContainer(identity, "/data", { Id: relayId, Mounts: relayMounts })
    ).toBe(true)
    // Docker's path when /var/lib/docker is a filesystem of its own.
    expect(
      isOwnContainer(mountIdentity(mountinfo(relayId).replaceAll("/var/lib/docker", ""), "/data"), "/data", {
        Id: relayId,
        Mounts: relayMounts,
      })
    ).toBe(true)
  })

  // `--network container:sidecar` gives the Relay the sidecar's hostname
  // file; the sidecar doesn't mount the Relay's data.
  it("isn't a container whose network and hostname it shares", () => {
    const identity = mountIdentity(mountinfo(sidecarId), "/data")

    expect(
      isOwnContainer(identity, "/data", {
        Id: sidecarId,
        Mounts: [{ Destination: "/data", Source: "/srv/sidecar-data" }],
      })
    ).toBe(false)
    expect(isOwnContainer(identity, "/data", { Id: sidecarId })).toBe(false)
  })

  it("can't be told without both clues", () => {
    expect(mountIdentity("", "/data")).toEqual({
      containerId: null,
      dataSource: null,
    })
    // Its data directory isn't a mount of its own.
    const noData = mountIdentity(
      mountinfo(relayId).split("\n").slice(1).join("\n"),
      "/data"
    )
    expect(
      isOwnContainer(noData, "/data", { Id: relayId, Mounts: relayMounts })
    ).toBe(false)
    // Docker reports another container for that ID.
    expect(
      isOwnContainer(mountIdentity(mountinfo(relayId), "/data"), "/data", {
        Id: sidecarId,
        Mounts: relayMounts,
      })
    ).toBe(false)
  })
})
