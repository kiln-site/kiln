import { describe, expect, it } from "vite-plus/test"

import { parseVolumeSpecs } from "@/lib/volume-spec"

const parsed = (text: string) => parseVolumeSpecs(text).map(({ spec }) => spec)

describe("parseVolumeSpecs", () => {
  it("reads a named volume, a path on the node, and their modes", () => {
    expect(
      parsed(
        [
          "site-configs:/var/www/html/configs:ro",
          "/srv/media:/media:rw,z",
          "data:/data/",
        ].join("\n")
      )
    ).toEqual([
      {
        kind: "volume",
        name: "site-configs",
        readOnly: true,
        target: "/var/www/html/configs",
      },
      { kind: "host", path: "/srv/media", readOnly: false, target: "/media" },
      { kind: "volume", name: "data", readOnly: false, target: "/data" },
    ])
  })

  it("reads a list as a Compose file writes it", () => {
    const list = `
    volumes:
      # Keep these
      - site-configs:/configs:ro  # shared
      - "uploads:/uploads"
      - 'cache:/cache'
    `
    expect(
      parsed(list).map((spec) => spec && "name" in spec && spec.name)
    ).toEqual(["site-configs", "uploads", "cache"])
  })

  it("says what's wrong with a line it can't use, and keeps the others", () => {
    const results = parseVolumeSpecs(
      [
        "./data:/data",
        "good:/good",
        "${DATA}:/x",
        "bad:relative",
        "a:/a:nope",
      ].join("\n")
    )
    expect(results.map(({ spec }) => spec !== null)).toEqual([
      false,
      true,
      false,
      false,
      false,
    ])
    expect(results[4]?.problem).toContain("nope")
  })

  it("asks for what a partial definition leaves out", () => {
    expect(parseVolumeSpecs("/data")[0]?.problem).toContain("data:/data")
    expect(parseVolumeSpecs("uploads")[0]?.problem).toContain("uploads:/data")
  })
})
