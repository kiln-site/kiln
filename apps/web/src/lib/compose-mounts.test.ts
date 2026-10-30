import { describe, expect, it } from "vite-plus/test"

import { changeComposeMount, composeMounts } from "./compose-mounts"

const project = "kiln-app-abc"

describe("compose mounts", () => {
  it("leaves alone a mount that shares or inherits any part of itself", () => {
    const shared = `x-mount: &mount
  type: volume
  source: data
  target: /data
  read_only: true
x-base: &base
  image: base
  volumes:
    - data:/data
services:
  web:
    image: web
    volumes:
      - type: volume
        source: &source data
        target: /data
  api:
    image: api
    volumes:
      - type: volume
        source: *source
        target: /data
  worker:
    image: worker
    volumes:
      - <<: *mount
  job:
    <<: *base
    volumes:
      - cache:/cache
volumes:
  data: {}
  cache: {}
`
    const found = composeMounts(shared, project)!
    expect(found.map((mount) => [mount.service, mount.editable])).toEqual([
      ["web", false],
      ["api", false],
      ["worker", false],
      ["job", false],
    ])
    for (const mount of found) {
      expect(
        changeComposeMount(shared, mount.key, {
          readOnly: false,
          source: "other",
          target: "/other",
        })
      ).toBe(shared)
      expect(changeComposeMount(shared, mount.key, null)).toBe(shared)
    }
  })

  it("reads no mounts, rather than failing, from a file of too many aliases", () => {
    const services = Array.from(
      { length: 101 },
      (_, at) => `  app${at}: *base`
    ).join("\n")
    const text = `x-base: &base
  image: app
  volumes:
    - data:/data
services:
${services}
volumes:
  data: {}
`
    expect(composeMounts(text, project)).toBeNull()
  })

  it("writes only what changes, leaving every other byte as it was", () => {
    const text = `services:
  bot:
    image: bot
    entrypoint: ["/bin/sh", "-ec"]
    environment:
      DISCORD_GUILD_ID: 1234567890123456789
    volumes:
      - data:/data   # kept
      - type: volume
        source: logs
        target: /logs
        read_only: true
      - /scratch
    secrets:
      - source: token
        mode: 0440
volumes:
  data: {}
  logs: {}
secrets:
  token:
    file: ./token
`
    const keyAt = (target: string) =>
      composeMounts(text, project)!.find((mount) => mount.target === target)!
        .key
    expect(
      changeComposeMount(text, keyAt("/data"), {
        readOnly: true,
        source: "cache",
        target: "/data",
      })
    ).toBe(
      text
        .replace("data:/data   # kept", "cache:/data:ro   # kept")
        .replace("  logs: {}\n", "  logs: {}\n  cache: {}\n")
    )
    expect(
      changeComposeMount(text, keyAt("/logs"), {
        readOnly: false,
        source: "logs",
        target: "/var/log",
      })
    ).toBe(
      text.replace(
        "target: /logs\n        read_only: true\n",
        "target: /var/log\n        read_only: false\n"
      )
    )
    expect(
      changeComposeMount(text, keyAt("/scratch"), {
        readOnly: true,
        source: "",
        target: "/scratch",
      })
    ).toBe(
      text.replace(
        "- /scratch",
        "- { type: volume, target: /scratch, read_only: true }"
      )
    )
    expect(changeComposeMount(text, keyAt("/scratch"), null)).toBe(
      text.replace("      - /scratch\n", "")
    )
    expect(changeComposeMount(text, keyAt("/run/secrets/token"), null)).toBe(
      text.replace(
        "    secrets:\n      - source: token\n        mode: 0440\n",
        ""
      )
    )
  })
})
