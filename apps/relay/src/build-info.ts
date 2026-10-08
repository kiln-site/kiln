const bakedCommit = String(import.meta.env?.KILN_BUILD_SHA ?? "").trim()
const bakedVersion = String(import.meta.env?.KILN_VERSION ?? "").trim()
const bakedReleaseNumber = String(
  import.meta.env?.KILN_RELEASE_NUMBER ?? ""
).trim()

/** Full commit SHA baked at pack time, or empty when unavailable. */
export const relayBuildCommit = bakedCommit

/** Release version baked at pack time, or `development` when unavailable. */
export const relayBuildVersion = bakedVersion || "development"

/** CI run number baked at pack time, or empty outside release builds. */
export const relayBuildReleaseNumber = bakedReleaseNumber

/** Short SHA for display, or `development` when no commit was baked. */
export function relayBuildLabel(): string {
  return relayBuildVersion === "development"
    ? relayBuildCommit
      ? relayBuildCommit.slice(0, 7)
      : "development"
    : relayBuildVersion
}
