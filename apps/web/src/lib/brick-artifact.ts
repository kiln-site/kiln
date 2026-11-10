export type BrickArtifactCatalog = {
  type: string
  variant: string
}

const MCJAR_VERSION_URL =
  /^https:\/\/mcjarfiles\.com\/api\/get-jar\/([a-z0-9-]+)\/([a-z0-9-]+)\/\{\{\s*version\s*\}\}$/iu

/** The download index a Brick's `KILN_ARTIFACT_URL` names, if it names one. */
export function brickArtifactCatalog(
  environment: Readonly<Record<string, string>>
): BrickArtifactCatalog | null {
  const url = environment.KILN_ARTIFACT_URL
  if (!url) return null
  const match = MCJAR_VERSION_URL.exec(url.trim())
  if (!match?.[1] || !match[2]) return null
  return {
    type: match[1].toLowerCase(),
    variant: match[2].toLowerCase(),
  }
}
