import {
  isKilnReleaseVersion,
  kilnImageRepository,
  kilnReleaseVersionCore,
  relayControlProtocolVersion,
} from "@workspace/contracts"

import { kilnGitRepository } from "@/lib/environment"

import type { KilnReleaseManifest } from "@/effect/github-releases"

export function updateTargetVersion(manifest: KilnReleaseManifest): string {
  return manifest.channel === "nightly"
    ? (manifest.imageVersion ?? manifest.version)
    : manifest.version
}

export function validateUpdateManifest(
  manifest: KilnReleaseManifest,
  version: string,
  component: "hearth" | "relay",
  repository = kilnGitRepository()
): void {
  if (manifest.version !== version) {
    throw new Error("The release manifest version does not match its tag")
  }
  if (
    manifest.imageVersion !== undefined &&
    (!isKilnReleaseVersion(manifest.imageVersion) ||
      kilnReleaseVersionCore(manifest.imageVersion) !==
        kilnReleaseVersionCore(manifest.version))
  ) {
    throw new Error("The release manifest image version is invalid")
  }
  if (
    component === "relay" &&
    manifest.compatibility.relayProtocol !== relayControlProtocolVersion
  ) {
    throw new Error(
      `This release requires Relay protocol ${manifest.compatibility.relayProtocol}; Hearth supports protocol ${relayControlProtocolVersion}`
    )
  }
  for (const [name, component] of Object.entries(manifest.components)) {
    if (component.image !== kilnImageRepository(name, repository)) {
      throw new Error("The release manifest contains an unexpected image")
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(component.digest)) {
      throw new Error("The release manifest contains an invalid image digest")
    }
  }
}
