import { describe, expect, it } from "vite-plus/test"
import { relayControlProtocolVersion } from "@workspace/contracts"

import type { KilnReleaseManifest } from "@/effect/github-releases"
import { validateUpdateManifest } from "@/lib/update-manifest"

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
    ).toThrow()
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
    ).toThrow()
    expect(() =>
      validateUpdateManifest(
        fork,
        fork.version,
        "relay",
        "https://github.com/other/fork"
      )
    ).toThrow()
  })
})
