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
})
