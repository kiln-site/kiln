export function requiredMinecraftJavaVersion(
  brickId: string,
  version: string
): string | null {
  const parsed = parseMinecraftVersion(
    brickId === "velocity" ? version.replace(/-SNAPSHOT$/u, "") : version
  )
  if (!parsed) return null
  const [major, minor, patch] = parsed

  // Velocity's Java toolchain changed in 3.3 (17), 3.5 (21), and 4.0 (25).
  // https://github.com/PaperMC/Velocity/commit/8be7ace3f1ef
  // https://github.com/PaperMC/Velocity/commit/75ecb641596a
  // https://docs.papermc.io/velocity/faq/#what-version-of-java-does-velocity-require
  // Older releases run on Java 11, the oldest published Kiln Java Ember.
  if (brickId === "velocity") {
    if (major >= 4) return "25"
    if (major === 3 && minor >= 5) return "21"
    if (major === 3 && minor >= 3) return "17"
    if (major >= 1) return "11"
    return null
  }

  if (brickId === "paper" || brickId === "folia") {
    if (major === 26 && minor >= 1) return "25"
    if (major !== 1) return null
    if (minor === 20 || minor === 21) return "21"
    if (minor >= 17 && minor <= 19) return "17"
    if (minor === 16 && patch >= 5) return "16"
    if (minor >= 12 && minor <= 16) return "11"
    if (minor >= 7 && minor <= 11) return "8"
    return null
  }

  if (brickId === "fabric") {
    if (major === 26 && minor >= 1) return "25"
    if (major !== 1) return null
    if (minor === 21 || (minor === 20 && patch >= 5)) return "21"
    if (minor >= 17 && minor <= 20) return "17"
    if (minor >= 1 && minor <= 16) return "8"
  }

  return null
}

function parseMinecraftVersion(
  version: string
): readonly [major: number, minor: number, patch: number] | null {
  const match = version.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?$/u)
  if (!match?.[1] || !match[2]) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3] ?? 0)
  return [major, minor, patch].every(Number.isSafeInteger)
    ? [major, minor, patch]
    : null
}

export function latestVelocityVersion(
  versions: ReadonlyArray<string>
): string | null {
  const parsed = versions.flatMap((version) => {
    const value = version.trim()
    const parts = parseMinecraftVersion(value.replace(/-SNAPSHOT$/u, ""))
    return parts ? [{ value, parts }] : []
  })
  parsed.sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      const difference = right.parts[index]! - left.parts[index]!
      if (difference) return difference
    }
    // Prefer the finished release when both it and its snapshot are listed.
    return (
      Number(left.value.endsWith("-SNAPSHOT")) -
      Number(right.value.endsWith("-SNAPSHOT"))
    )
  })
  return parsed[0]?.value ?? null
}
