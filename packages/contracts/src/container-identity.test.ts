import { describe, expect, it } from "vite-plus/test"

import { hostnameContainerId } from "./container-identity.js"

const relayId = "d".repeat(64)

describe("a process's candidate container", () => {
  it("is the one its hostname file is mounted from", () => {
    const mountinfo = [
      "2374 2344 252:0 /var/lib/docker/volumes/kiln-relay-data/_data /data rw,relatime master:1 - ext4 /dev/sda1 rw",
      `2376 2344 252:0 /var/lib/docker/containers/${relayId}/hostname /etc/hostname rw,relatime - ext4 /dev/sda1 rw`,
      `2377 2344 252:0 /var/lib/docker/containers/${"e".repeat(64)}/hosts /etc/hosts rw,relatime - ext4 /dev/sda1 rw`,
    ].join("\n")

    expect(hostnameContainerId(mountinfo)).toBe(relayId)
  })

  it("is none outside a Docker container", () => {
    expect(hostnameContainerId("")).toBeNull()
    expect(
      hostnameContainerId(
        "25 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n26 25 0:5 / /etc/hostname rw - tmpfs tmpfs rw"
      )
    ).toBeNull()
  })
})
