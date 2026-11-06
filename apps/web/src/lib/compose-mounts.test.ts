import { describe, expect, it } from "vite-plus/test"

import { composeMounts } from "./compose-mounts"

const project = "kiln-app-abc"

describe("compose mounts", () => {
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

  it("says where each definition is, for opening the file there", () => {
    const text = `x-base: &base
  image: base
  volumes:
    - inherited:/inherited
services:
  web:
    image: web
    volumes:
      - data:/data:ro   # kept
      - type: volume
        source: logs
        target: /logs
  job:
    <<: *base
volumes:
  data: {}
  logs: {}
`
    const mounts = composeMounts(text, project)!
    const definition = (target: string) => {
      const range = mounts.find((mount) => mount.target === target)?.range
      return range ? text.slice(range.from, range.to) : range
    }
    expect(definition("/data")).toBe("data:/data:ro")
    expect(definition("/logs")).toBe(
      "type: volume\n        source: logs\n        target: /logs"
    )
    // A merge brings this one in; it has no place in the service.
    expect(definition("/inherited")).toBeNull()
  })
})
