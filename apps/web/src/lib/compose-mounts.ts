import { Document, isNode, parseDocument } from "yaml"
import { Result } from "effect"

// What a Compose file mounts into its services, read from the file as
// written, with where each is in it, so it can be opened there. Loaded on
// demand: the yaml parser stays out of the pages that don't show a Compose
// file's mounts.

export type ComposeMountKind = "bind" | "config" | "secret" | "volume"

export interface ComposeMount {
  kind: ComposeMountKind
  // Its place in the file's structure.
  key: string
  readOnly: boolean
  service: string
  // A volume's or config's name, or a bind's path as written. Empty for an
  // anonymous volume.
  source: string
  target: string
  // A volume's name in Docker: the project's, or the name the file gives
  // it. Null for an anonymous volume and anything but a volume.
  dockerName: string | null
  // Where a config or secret is read from, as the file says.
  origin: string | null
  // Where its definition is in the text, or null for one a YAML merge
  // brings in, which has no place of its own.
  range: { from: number; to: number } | null
}

type Section = "configs" | "secrets" | "volumes"
const sections: ReadonlyArray<Section> = ["volumes", "configs", "secrets"]

// The file's mounts, or null when it isn't a Compose file this can read.
// `project` is the Compose project the Relay runs it as, which names its
// volumes.
export function composeMounts(
  text: string,
  project: string
): ReadonlyArray<ComposeMount> | null {
  const document = parseFile(text)
  if (document.errors.length > 0) return null
  const file = resolved(document)
  if (!isRecord(file) || !isRecord(file.services)) return null
  const mounts: Array<ComposeMount> = []
  for (const [service, definition] of Object.entries(file.services)) {
    if (!isRecord(definition)) continue
    for (const section of sections) {
      const entries = definition[section]
      if (!Array.isArray(entries)) continue
      entries.forEach((entry: unknown, index) => {
        const key = mountKey(service, section, index)
        const mount =
          section === "volumes"
            ? volumeMount(file, project, entry)
            : fileMount(file, section, entry)
        if (mount) {
          const node = document.getIn(
            ["services", service, section, index],
            true
          )
          mounts.push({
            ...mount,
            key,
            range:
              isNode(node) && node.range
                ? definitionRange(text, node.range)
                : null,
            service,
          })
        }
      })
    }
  }
  return mounts
}

// The file as plain values, or null when its aliases expand past what the
// parser allows.
function resolved(document: Document): unknown {
  const result = Result.try(() => document.toJS() as unknown)
  return Result.isSuccess(result) ? result.success : null
}

// A block's range runs on to where whatever follows it starts; the
// definition ends with its text.
function definitionRange(
  text: string,
  [from, end]: readonly [number, number, number]
) {
  return { from, to: from + text.slice(from, end).trimEnd().length }
}

function parseFile(text: string) {
  // Compose reads YAML merge keys (<<), so their entries count.
  return parseDocument(text, { merge: true })
}

function volumeMount(
  file: Record<string, unknown>,
  project: string,
  entry: unknown
): Omit<ComposeMount, "key" | "range" | "service"> | null {
  if (typeof entry === "string") {
    const [first, second, mode] = splitShort(entry)
    // "/data" alone: an anonymous volume.
    const source = second === undefined ? "" : first
    const target = second ?? first
    const kind = source ? sourceKind(source) : "volume"
    return {
      dockerName: kind === "volume" ? volumeName(file, project, source) : null,
      kind,
      origin: null,
      readOnly: shortReadOnly(mode),
      source,
      target,
    }
  }
  if (!isRecord(entry) || typeof entry.target !== "string") return null
  const source = typeof entry.source === "string" ? entry.source : ""
  if (entry.type !== "bind" && entry.type !== "volume") return null
  return {
    dockerName:
      entry.type === "volume" ? volumeName(file, project, source) : null,
    kind: entry.type,
    origin: null,
    // Compose takes "true" for true too.
    readOnly: entry.read_only === true || entry.read_only === "true",
    source,
    target: entry.target,
  }
}

function fileMount(
  file: Record<string, unknown>,
  section: "configs" | "secrets",
  entry: unknown
): Omit<ComposeMount, "key" | "range" | "service"> | null {
  const name =
    typeof entry === "string"
      ? entry
      : isRecord(entry) && typeof entry.source === "string"
        ? entry.source
        : null
  if (name === null) return null
  const target =
    isRecord(entry) && typeof entry.target === "string"
      ? entry.target
      : defaultFileTarget(section, name)
  const declared = isRecord(file[section]) ? file[section][name] : undefined
  return {
    dockerName: null,
    kind: section === "configs" ? "config" : "secret",
    origin: !isRecord(declared)
      ? null
      : typeof declared.file === "string"
        ? declared.file
        : typeof declared.environment === "string"
          ? `$${declared.environment}`
          : "content" in declared
            ? "Written in the file"
            : null,
    readOnly: true,
    source: name,
    target,
  }
}

function volumeName(
  file: Record<string, unknown>,
  project: string,
  source: string
): string | null {
  if (!source) return null
  const declared = isRecord(file.volumes) ? file.volumes[source] : undefined
  if (isRecord(declared) && typeof declared.name === "string") {
    return declared.name
  }
  if (isRecord(declared) && declared.external) return source
  return `${project}_${source}`
}

function defaultFileTarget(section: "configs" | "secrets", name: string) {
  return section === "configs" ? `/${name}` : `/run/secrets/${name}`
}

// Compose reads a source that starts like a path as a bind, and anything
// else as a volume's name. A variable is most often a path.
function sourceKind(source: string): "bind" | "volume" {
  return /^[./~$]/u.test(source) ? "bind" : "volume"
}

// Compose takes the last of ro and rw in a mode.
function shortReadOnly(mode: string | undefined): boolean {
  const access = (mode ?? "")
    .split(",")
    .filter((flag) => flag === "ro" || flag === "rw")
  return access.at(-1) === "ro"
}

// "source:target:mode", where a ${VAR:-default} may hold colons of its own.
function splitShort(entry: string): Array<string> {
  const parts: Array<string> = []
  let depth = 0
  let part = ""
  for (let at = 0; at < entry.length; at += 1) {
    const character = entry[at]
    if (character === "$" && entry[at + 1] === "{") depth += 1
    if (character === "}" && depth > 0) depth -= 1
    if (character === ":" && depth === 0) {
      parts.push(part)
      part = ""
      continue
    }
    part += character
  }
  parts.push(part)
  return parts
}

function mountKey(service: string, section: Section, index: number) {
  return JSON.stringify([service, section, index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
