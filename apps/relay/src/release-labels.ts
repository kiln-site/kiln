import {
  kilnReleaseName,
  kilnReleaseNameLabel,
  kilnReleaseNumberLabel,
} from "@workspace/contracts"

export const KILN_VERSION_LABEL = "org.opencontainers.image.version"

type ContainerLabels =
  | Readonly<Record<string, string | undefined>>
  | null
  | undefined

/** Release version a container runs, as stamped by CI or the updater. */
export function containerReleaseVersion(
  labels: ContainerLabels
): string | null {
  return labels?.[KILN_VERSION_LABEL]?.trim() || null
}

/**
 * Display name for a container's release. The updater stamps the promoted
 * name, so a stable container built as a nightly still reads "v0.1.0".
 */
export function containerReleaseName(
  labels: ContainerLabels,
  version: string | null
): string | null {
  const stamped = labels?.[kilnReleaseNameLabel]?.trim()
  if (stamped) return stamped
  return version
    ? kilnReleaseName(version, labels?.[kilnReleaseNumberLabel])
    : null
}
