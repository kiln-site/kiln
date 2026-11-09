import { describe, expect, it } from "vite-plus/test"

import { parseImageReference } from "@/lib/image-tags"

describe("parseImageReference", () => {
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
})
