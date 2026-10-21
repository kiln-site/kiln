import { isMap, isScalar, isSeq, parseDocument, type Document } from "yaml"

// What a Compose file mounts into its services, read from the file as
// written, and changed in place so the rest of it, comments included,
// stays as it was. Loaded on demand: the yaml parser stays out of the
// pages that don't show a Compose file's mounts.

export type ComposeMountKind = "bind" | "config" | "secret" | "volume"

export interface ComposeMount {
  kind: ComposeMountKind
  // Its place in the file, which stays the same while it's edited.
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
}

export interface ComposeMountChange {
  readOnly: boolean
  source: string
  target: string
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
  const document = parseDocument(text)
  if (document.errors.length > 0) return null
  const file: unknown = document.toJS()
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
        if (mount) mounts.push({ ...mount, key, service })
      })
    }
  }
  return mounts
}

// Why the change can't be saved, or null when it can.
export function composeMountProblem(
  mount: Pick<ComposeMount, "kind">,
  change: ComposeMountChange
): string | null {
  if (!change.target.startsWith("/")) {
    return "Mount each at an absolute path, like /data."
  }
  if (mount.kind === "bind" && !change.source.trim()) {
    return "Enter the path each bind mounts."
  }
  if (change.source.includes(":") && !change.source.includes("${")) {
    return "A source can't contain a colon."
  }
  return null
}

// The file with one mount changed, or removed when `change` is null.
export function changeComposeMount(
  text: string,
  key: string,
  change: ComposeMountChange | null
): string {
  const document = parseDocument(text)
  const [service, section, index] = parseKey(key)
  const path = ["services", service, section, index]
  const node = document.getIn(path, true)
  if (node === undefined) return text
  if (change === null) {
    document.deleteIn(path)
    // An empty list reads as an error to Compose.
    const rest = document.getIn(["services", service, section], true)
    if (isSeq(rest) && rest.items.length === 0) {
      document.deleteIn(["services", service, section])
    }
    return document.toString()
  }
  if (section === "volumes") {
    changeVolume(document, node, change)
  } else {
    changeFile(document, path, node, section, change)
  }
  return document.toString()
}

function changeVolume(
  document: Document,
  node: unknown,
  change: ComposeMountChange
) {
  const source = change.source.trim()
  const kind = source ? sourceKind(source) : "volume"
  if (kind === "volume" && source) declareVolume(document, source)
  if (isScalar(node) && typeof node.value === "string") {
    const [, , mode] = splitShort(node.value)
    const flags = (mode ?? "")
      .split(",")
      .filter((flag) => flag && flag !== "ro" && flag !== "rw")
    if (change.readOnly) flags.push("ro")
    // An anonymous volume is only its target; a mode would read as one.
    node.value = !source
      ? change.target
      : [source, change.target, ...(flags.length ? [flags.join(",")] : [])]
          .join(":")
    return
  }
  if (!isMap(node)) return
  node.set("type", kind)
  if (source) node.set("source", source)
  else node.delete("source")
  node.set("target", change.target)
  if (change.readOnly) node.set("read_only", true)
  else node.delete("read_only")
}

function changeFile(
  document: Document,
  path: ReadonlyArray<string | number>,
  node: unknown,
  section: "configs" | "secrets",
  change: ComposeMountChange
) {
  const name = isScalar(node)
    ? String(node.value)
    : isMap(node)
      ? String(node.get("source"))
      : ""
  if (!name) return
  if (isScalar(node)) {
    if (change.target === defaultFileTarget(section, name)) return
    document.setIn(
      path,
      document.createNode({ source: name, target: change.target })
    )
    return
  }
  if (isMap(node)) node.set("target", change.target)
}

// A named volume Compose doesn't know of yet, declared at the top level,
// so the file still deploys.
function declareVolume(document: Document, name: string) {
  if (name.includes("$") || document.hasIn(["volumes", name])) return
  if (!isMap(document.get("volumes", true))) {
    document.set("volumes", document.createNode({}))
  }
  document.setIn(["volumes", name], document.createNode({}))
}

function volumeMount(
  file: Record<string, unknown>,
  project: string,
  entry: unknown
): Omit<ComposeMount, "key" | "service"> | null {
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
      readOnly: (mode ?? "").split(",").includes("ro"),
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
    readOnly: entry.read_only === true,
    source,
    target: entry.target,
  }
}

function fileMount(
  file: Record<string, unknown>,
  section: "configs" | "secrets",
  entry: unknown
): Omit<ComposeMount, "key" | "service"> | null {
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

function parseKey(key: string): [string, Section, number] {
  return JSON.parse(key) as [string, Section, number]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
