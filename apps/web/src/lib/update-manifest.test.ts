import { describe, expect, it } from "vite-plus/test"
import { relayControlProtocolVersion } from "@workspace/contracts"

import type { KilnReleaseManifest } from "@/effect/github-releases"
import {
  updateTargetVersion,
  validateUpdateManifest,
} from "@/lib/update-manifest"

const manifest: KilnReleaseManifest = {
  channel: "nightly",
  commit: "a".repeat(40),
  compatibility: {
    relayProtocol: relayControlProtocolVersion,
  },
  components: {
    hearth: {
      digest: `sha256:${"b".repeat(64)}`,
      image: "ghcr.io/kiln-site/hearth",
    },
    relay: {
      digest: `sha256:${"c".repeat(64)}`,
      image: "ghcr.io/kiln-site/relay",
    },
  },
  publishedAt: "2026-07-24T00:00:00.000Z",
  schemaVersion: 1,
  version: "0.1.0-nightly.2",
}

describe("update manifest validation", () => {
  it("uses the baked alias when applying a migrated nightly", () => {
    expect(
      updateTargetVersion({
        ...manifest,
        imageVersion: "0.1.0-nightly.2",
        version: "0.1.0-nightly.20260725.162524",
      })
    ).toBe("0.1.0-nightly.2")
  })

  it("keeps the stable version when applying a promoted nightly image", () => {
    expect(
      updateTargetVersion({
        ...manifest,
        channel: "stable",
        imageVersion: "0.1.0-nightly.20260725.162524",
        version: "0.1.0",
      })
    ).toBe("0.1.0")
  })

  it("accepts the current Relay protocol", () => {
    expect(() =>
      validateUpdateManifest(manifest, "0.1.0-nightly.2", "relay")
    ).not.toThrow()
  })

  it("accepts a legacy baked image version on the same release line", () => {
    expect(() =>
      validateUpdateManifest(
        {
          ...manifest,
          imageVersion: "0.1.0-nightly.2",
          version: "0.1.0-nightly.20260725.162524",
        },
        "0.1.0-nightly.20260725.162524",
        "relay"
      )
    ).not.toThrow()
  })

  it("rejects a baked image version from another release line", () => {
    expect(() =>
      validateUpdateManifest(
        {
          ...manifest,
          imageVersion: "0.1.1-nightly.2",
          version: "0.1.0-nightly.20260725.162524",
        },
        "0.1.0-nightly.20260725.162524",
        "relay"
      )
    ).toThrow("image version is invalid")
  })

  it("blocks a Relay-first update across a protocol transition", () => {
    expect(() =>
      validateUpdateManifest(
        {
          ...manifest,
          compatibility: {
            relayProtocol: relayControlProtocolVersion - 1,
          },
        },
        "0.1.0-nightly.2",
        "relay"
      )
    ).toThrow(`requires Relay protocol ${relayControlProtocolVersion - 1}`)
  })

  it("allows a Hearth-first update across a protocol transition", () => {
    expect(() =>
      validateUpdateManifest(
        {
          ...manifest,
          compatibility: {
            relayProtocol: relayControlProtocolVersion - 1,
          },
        },
        "0.1.0-nightly.2",
        "hearth"
      )
    ).not.toThrow()
  })
})

describe("fork update boundaries", () => {
  it("accepts the fork and rejects a release from another distribution", () => {
    const repository = "https://github.com/example/fork"
    const fork = {
      ...manifest,
      components: {
        hearth: {
          ...manifest.components.hearth,
          image: "ghcr.io/example/fork/hearth",
        },
        relay: {
          ...manifest.components.relay,
          image: "ghcr.io/example/fork/relay",
        },
      },
    }
    expect(() =>
      validateUpdateManifest(fork, fork.version, "relay", repository)
    ).not.toThrow()
    expect(() =>
      validateUpdateManifest(manifest, manifest.version, "relay", repository)
    ).toThrow("unexpected image")
    expect(() =>
      validateUpdateManifest(
        fork,
        fork.version,
        "relay",
        "https://github.com/other/fork"
      )
    ).toThrow("unexpected image")
  })
})
