import { describe, expect, it } from "vite-plus/test"

import { parseImageReference, suggestImageTags } from "@/lib/image-tags"

describe("parseImageReference", () => {
  it("reads Docker Hub and GHCR images", () => {
    expect(parseImageReference("nginx:1.21.0")).toMatchObject({
      registry: "docker.io",
      repository: "library/nginx",
      tag: "1.21.0",
    })
    expect(parseImageReference("ghcr.io/acme/api:v2.1.0")).toMatchObject({
      name: "ghcr.io/acme/api",
      registry: "ghcr.io",
      repository: "acme/api",
    })
  })

  it("only ever asks registries it knows, whatever the name says", () => {
    for (const image of [
      "registry.evil.test/acme/api:1.0.0",
      "169.254.169.254/latest/meta-data:1.0.0",
      "localhost:5000/api:1.0.0",
      "ghcr.io.evil.test/acme/api:1.0.0",
      "ghcr.io/../../admin:1.0.0",
      "ghcr.io/acme/api?x=/../y:1.0.0",
    ]) {
      expect(parseImageReference(image)).toBeNull()
    }
  })

  it("has nothing to compare for a digest or no tag", () => {
    expect(parseImageReference("nginx@sha256:abc")).toBeNull()
    expect(parseImageReference("nginx")).toBeNull()
  })
})

describe("suggestImageTags", () => {
  const nginx = { name: "nginx", tag: "1.21.0" }

  it("offers the newest of each line, nearest first", () => {
    expect(
      suggestImageTags(nginx, [
        "1.20.2",
        "1.21.0",
        "1.21.6",
        "1.21.10",
        "1.27.4",
        "2.0.1",
      ]).map(({ kind, tag }) => [kind, tag])
    ).toEqual([
      ["patch", "1.21.10"],
      ["minor", "1.27.4"],
      ["major", "2.0.1"],
    ])
  })

  it("keeps to the same variant and precision", () => {
    expect(
      suggestImageTags({ name: "redis", tag: "6.2.6-alpine" }, [
        "6.2.7",
        "6.2",
        "6.2.8-bookworm",
        "6.2.9-alpine",
        "7.0.0-rc1-alpine",
        "latest",
      ]).map(({ tag }) => tag)
    ).toEqual(["6.2.9-alpine"])
  })

  it("offers nothing when the tag isn't a version or nothing is newer", () => {
    expect(suggestImageTags({ name: "x", tag: "latest" }, ["1.0.0"])).toEqual(
      []
    )
    expect(suggestImageTags(nginx, ["1.20.0", "1.21.0"])).toEqual([])
  })
})
