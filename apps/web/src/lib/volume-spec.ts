// Compose's short volume syntax, `SOURCE:TARGET[:MODE]`, as pasted from a
// Compose file or a `docker run -v`. A source is a volume's name or an
// absolute path on the node.

export type VolumeSpec =
  | { kind: "volume"; name: string; readOnly: boolean; target: string }
  | { kind: "host"; path: string; readOnly: boolean; target: string }

export type ParsedVolumeSpec =
  | { line: string; problem: null; spec: VolumeSpec }
  | { line: string; problem: string; spec: null }

const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u
// What can follow `ro` or `rw`: SELinux labels, consistency, and propagation.
// They change nothing a mount here can express, so they're accepted and left.
const IGNORED_OPTIONS = new Set([
  "cached",
  "consistent",
  "delegated",
  "nocopy",
  "private",
  "rprivate",
  "rshared",
  "rslave",
  "shared",
  "slave",
  "z",
  "Z",
])

/**
 * Whether text is a definition rather than a volume's name being searched
 * for: anything with a colon or a slash, or more than one line.
 */
export function looksLikeVolumeSpec(text: string): boolean {
  return /[:/\n]/u.test(text.trim())
}

/**
 * Each definition in the text. A list as a Compose file writes it reads as
 * it is: a `volumes:` line, comments, `- ` markers, and quotes are left out.
 */
export function parseVolumeSpecs(text: string): Array<ParsedVolumeSpec> {
  return text.split(/\r?\n/u).flatMap((raw) => {
    const line = definition(raw)
    return line ? [parseLine(line)] : []
  })
}

function definition(raw: string): string | null {
  const line = raw
    .replace(/(^|\s)#.*$/u, "")
    .trim()
    .replace(/^-\s*/u, "")
    .trim()
  if (!line || line === "volumes:") return null
  const quoted = /^(["'])(.*)\1$/u.exec(line)
  return (quoted ? quoted[2]! : line).trim() || null
}

function parseLine(line: string): ParsedVolumeSpec {
  const failed = (problem: string): ParsedVolumeSpec => ({
    line,
    problem,
    spec: null,
  })
  if (line.includes("${")) {
    return failed("Variables only work in a Compose file. Use the real value.")
  }
  const [source = "", target, mode, ...rest] = line.split(":")
  if (rest.length > 0) return failed("Too many colons to read.")
  if (target === undefined) {
    return failed(
      source.startsWith("/")
        ? `Give it a name too, like data:${source}.`
        : `Say where it's mounted, like ${source}:/data.`
    )
  }
  if (!target.startsWith("/")) {
    return failed("Mount it at an absolute path, like /data.")
  }
  const options = (mode ?? "").split(",").filter(Boolean)
  const unknown = options.find(
    (option) =>
      option !== "ro" && option !== "rw" && !IGNORED_OPTIONS.has(option)
  )
  if (unknown) return failed(`“${unknown}” isn't a mount option.`)
  const spec = {
    readOnly: options.includes("ro"),
    target: target.length > 1 ? target.replace(/\/+$/u, "") : target,
  }
  if (source.startsWith("/")) {
    return {
      line,
      problem: null,
      spec: { ...spec, kind: "host", path: source },
    }
  }
  if (source.startsWith(".") || source.startsWith("~")) {
    return failed("Use an absolute path on the node, like /srv/app.")
  }
  if (!VOLUME_NAME.test(source)) {
    return failed("Name a volume with letters, digits, and . _ - only.")
  }
  return {
    line,
    problem: null,
    spec: { ...spec, kind: "volume", name: source },
  }
}
