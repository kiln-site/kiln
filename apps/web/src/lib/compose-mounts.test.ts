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

  // A volume left to be made is one Kiln keeps, and shown as kept. One the
  // file names is the file's own, which no backup takes, unless the name
  // is the one it would get anyway: under the project the Relay runs the
  // file as, never the name the file gives itself.
  it("tells a volume Kiln keeps from one the file names, whatever the file calls itself", () => {
    const text = `name: custom
services:
  app:
    image: app
    volumes:
      - plain:/plain
      - default:/default
      - own:/own
volumes:
  plain: {}
  default:
    name: ${project}_default
  own:
    name: custom_own
`
    expect(
      composeMounts(text, project)?.map(({ dockerName, source }) => [
        source,
        dockerName,
      ])
    ).toEqual([
      ["plain", null],
      ["default", null],
      ["own", "custom_own"],
    ])
  })
})
