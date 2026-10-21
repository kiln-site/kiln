import {
  Document,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Node,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
} from "yaml"
import { Result } from "effect"

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
  // Whether it's changed here: not one a YAML anchor or alias shares with
  // another part of the file, or a merge brings in from one.
  editable: boolean
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
          mounts.push({
            ...mount,
            editable: ownNode(document, [service, section, index]),
            key,
            service,
          })
        }
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
  // The short syntax would read what follows a colon as the mode.
  if (change.target.includes(":")) {
    return "A path it's mounted at can't contain a colon."
  }
  if (mount.kind === "bind" && !change.source.trim()) {
    return "Enter the path each bind mounts."
  }
  // Written as typed, spaces and all, so only a name or nothing.
  if (change.source && !change.source.trim()) {
    return "Enter a name, or leave it empty for a volume of its own."
  }
  if (change.source.includes(":") && !change.source.includes("${")) {
    return "A source can't contain a colon."
  }
  // As written: Compose keeps a path's spaces, so they're the path's.
  const source = change.source
  if (
    source &&
    !source.includes("$") &&
    sourceKind(source) === "volume" &&
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(source)
  ) {
    return "Name a volume with letters, digits, and . _ - only."
  }
  return null
}

// The file with one mount changed, or removed when `change` is null. Only
// the text of what changes is rewritten; every other byte of the file stays
// as it was, since a YAML library writing the whole file anew can change
// values it never meant to, like long numbers and octal modes. Throws, with
// why, a change it can't make without changing more of the file than the
// mount.
export function changeComposeMount(
  text: string,
  key: string,
  change: ComposeMountChange | null
): string {
  const document = parseFile(text)
  const [service, section, index] = parseKey(key)
  if (!ownNode(document, [service, section, index])) return text
  const list = document.getIn(["services", service, section], true) as YAMLSeq
  const entry = list.items[index] as Node
  const changed =
    change === null
      ? removeEntry(text, document, service, section, list, entry)
      : applyPatches(
          text,
          section === "volumes"
            ? changeVolume(text, document, entry, change)
            : changeFile(text, entry, section, change)
        )
  verifyChange(document, changed, [service, section, index], change)
  return changed
}

// The file as changed must read as the file before with only that change:
// the mount as asked, a volume it newly names declared, and nothing else
// different. Anything else is a change this can't make safely, and the
// file is left for its author.
function verifyChange(
  before: Document,
  text: string,
  [service, section, index]: [string, Section, number],
  change: ComposeMountChange | null
) {
  const refuse = () => {
    throw new Error(
      "This change would touch more of the Compose file than the mount; make it in the file."
    )
  }
  const after = parseFile(text)
  if (after.errors.length > 0) refuse()
  const was = resolved(before)
  const now = resolved(after)
  if (!isRecord(was) || !isRecord(now)) return refuse()
  const expected = structuredClone(was) as Record<string, unknown>
  const actual = structuredClone(now) as Record<string, unknown>
  const listOf = (file: Record<string, unknown>) =>
    ((file.services as Record<string, Record<string, unknown>>)[service] ??
      {})[section]
  const expectedList = listOf(expected)
  const actualList = listOf(actual)
  if (!Array.isArray(expectedList)) return refuse()
  if (change === null) {
    expectedList.splice(index, 1)
    if (expectedList.length === 0) {
      delete (expected.services as Record<string, Record<string, unknown>>)[
        service
      ]![section]
    }
  } else {
    if (!Array.isArray(actualList)) return refuse()
    const asked =
      section === "volumes"
        ? volumeMount(now, "", actualList[index])
        : fileMount(now, section, actualList[index])
    const had =
      section === "volumes"
        ? volumeMount(was, "", expectedList[index])
        : fileMount(was, section, expectedList[index])
    if (
      !asked ||
      !had ||
      asked.target !== change.target ||
      (section === "volumes" &&
        (asked.source !== change.source ||
          asked.readOnly !== change.readOnly ||
          (isRecord(expectedList[index]) && asked.kind !== had.kind))) ||
      (section !== "volumes" && asked.source !== had.source)
    ) {
      return refuse()
    }
    expectedList[index] = null
    actualList[index] = null
    // A volume the mount newly names, declared for it.
    const declared = isRecord(actual.volumes) ? actual.volumes : {}
    const known = isRecord(expected.volumes) ? expected.volumes : {}
    const added = Object.keys(declared).filter(
      (name) => !Object.hasOwn(known, name)
    )
    if (added.length > 0) {
      if (added.length > 1 || added[0] !== asked.source) return refuse()
      expected.volumes = { ...known, [added[0]]: {} }
    }
  }
  if (stableJson(expected) !== stableJson(actual)) refuse()
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_, inner: unknown) =>
    isRecord(inner)
      ? Object.fromEntries(
          Object.keys(inner)
            .sort()
            .map((key) => [key, inner[key]])
        )
      : typeof inner === "bigint"
        ? inner.toString()
        : inner
  )
}

interface Patch {
  end: number
  start: number
  text: string
}

function removeEntry(
  text: string,
  document: Document,
  service: string,
  section: Section,
  list: YAMLSeq,
  entry: Node
): string {
  // An empty list reads as an error to Compose, so the last one takes its
  // key with it.
  if (list.items.length === 1) {
    const definition = document.getIn(["services", service], true) as YAMLMap
    const pair = definition.items.find(
      (candidate) => isScalar(candidate.key) && candidate.key.value === section
    )
    const keyNode = pair?.key as Node | undefined
    if (!keyNode?.range) return text
    return applyPatches(text, [
      {
        end: lineEnd(text, contentEnd(entry) - 1),
        start: lineStart(text, keyNode.range[0]),
        text: "",
      },
    ])
  }
  return applyPatches(text, [
    {
      end: lineEnd(text, contentEnd(entry) - 1),
      start: lineStart(text, entry.range![0]),
      text: "",
    },
  ])
}

// Where a node's own text ends: its last value, not the comments and
// indentation that may follow it before the next key.
function contentEnd(node: Node): number {
  if (isMap(node) || isSeq(node)) {
    const last = node.items.at(-1)
    const inner = isMap(node)
      ? ((last as { value?: Node | null; key?: Node } | undefined)?.value ??
        (last as { key?: Node } | undefined)?.key)
      : (last as Node | undefined)
    if (isNode(inner) && inner.range) return contentEnd(inner)
  }
  return node.range![1]
}

function changeVolume(
  text: string,
  document: Document,
  entry: Node,
  change: ComposeMountChange
): Array<Patch> {
  const source = change.source
  if (isScalar(entry) && typeof entry.value === "string") {
    // The short syntax's source says what it is, as Compose reads it.
    const [first, second, mode] = splitShort(entry.value)
    const before = second === undefined ? "" : first
    const declared =
      source && source !== before && sourceKind(source) === "volume"
        ? declareVolume(text, document, source)
        : []
    const flags = (mode ?? "")
      .split(",")
      .filter((flag) => flag && flag !== "ro" && flag !== "rw")
    // An anonymous volume written here keeps no options, like nocopy.
    if (!source && flags.length > 0) {
      throw new Error(
        `Make a volume with ${flags.join(", ")} anonymous in the Compose file.`
      )
    }
    if (change.readOnly) flags.push("ro")
    // An anonymous volume is only its target; a mode would read as one,
    // so a read-only one is written out in full.
    const replacement = !source
      ? change.readOnly
        ? flowMap({ type: "volume", target: change.target, read_only: true })
        : scalarText(change.target, entry)
      : scalarText(
          [source, change.target, ...(flags.length ? [flags.join(",")] : [])]
            .join(":"),
          entry
        )
    return [...declared, replaceNode(entry, replacement)]
  }
  if (!isMap(entry)) return []
  // The long syntax names its type, which stays as it is.
  const declared =
    entry.get("type") === "volume" && source && source !== entry.get("source")
      ? declareVolume(text, document, source)
      : []
  return [
    ...declared,
    ...setPair(text, entry, "source", source || null),
    ...setPair(text, entry, "target", change.target),
    // An explicit false stays, written as false.
    ...setPair(
      text,
      entry,
      "read_only",
      change.readOnly ? true : entry.has("read_only") ? false : null
    ),
  ]
}

function changeFile(
  text: string,
  entry: Node,
  section: "configs" | "secrets",
  change: ComposeMountChange
): Array<Patch> {
  if (isScalar(entry)) {
    const name = String(entry.value)
    if (change.target === defaultFileTarget(section, name)) return []
    return [replaceNode(entry, flowMap({ source: name, target: change.target }))]
  }
  if (!isMap(entry)) return []
  return setPair(text, entry, "target", change.target)
}

// A map's key set to a value, added after its last key, or removed when the
// value is null.
function setPair(
  text: string,
  map: YAMLMap,
  key: string,
  value: string | boolean | null
): Array<Patch> {
  const pair = map.items.find(
    (candidate) => isScalar(candidate.key) && candidate.key.value === key
  )
  const first = map.items[0]?.key as Node | undefined
  if (pair) {
    const keyNode = pair.key as Node
    const valueNode = pair.value as Node | null
    if (value !== null) {
      if (isScalar(valueNode) && valueNode.value === value) return []
      if (!isScalar(valueNode)) {
        throw new Error(`Change ${key} in the Compose file.`)
      }
      return [replaceNode(valueNode, scalarText(value, valueNode))]
    }
    // The first key shares its line with the list's dash.
    if (keyNode === first || !keyNode.range) {
      throw new Error(`Remove ${key} in the Compose file.`)
    }
    const end = valueNode?.range ? valueNode.range[1] : keyNode.range[1]
    return [
      {
        end: lineEnd(text, Math.max(end - 1, keyNode.range[0])),
        start: lineStart(text, keyNode.range[0]),
        text: "",
      },
    ]
  }
  if (value === null || !first?.range || !map.range) return []
  return [
    insertLine(
      text,
      map.range[1],
      `${" ".repeat(column(text, first.range[0]))}${key}: ${scalarText(value)}`
    ),
  ]
}

// A named volume Compose doesn't know of yet, declared at the top level,
// so the file still deploys. One declared through an alias or merge is
// already known. Declarations shared with another part of the file, or
// brought in by a merge, aren't changed; the file needs it declared by
// hand first.
function declareVolume(
  text: string,
  document: Document,
  name: string
): Array<Patch> {
  if (name.includes("$")) return []
  const file = resolved(document)
  if (file === null) {
    throw new Error("The Compose file has too many aliases to change here.")
  }
  const declared = isRecord(file) ? file.volumes : undefined
  if (isRecord(declared) && Object.hasOwn(declared, name)) return []
  const root = document.contents
  const firstService = (document.get("services", true) as YAMLMap).items[0]
    ?.key as Node | undefined
  const indent = " ".repeat(
    firstService?.range ? column(text, firstService.range[0]) || 2 : 2
  )
  const declaration = `${scalarText(name)}: {}`
  if (isMap(root) && !hasMerge(root)) {
    const pair = root.items.find(
      (candidate) => isScalar(candidate.key) && candidate.key.value === "volumes"
    )
    const keyNode = pair?.key as Node | undefined
    const volumes = pair?.value as Node | null | undefined
    if (!pair) {
      return [
        insertLine(text, text.length, `volumes:\n${indent}${declaration}`),
      ]
    }
    // "volumes:" with nothing after it.
    if (
      keyNode?.range &&
      (volumes === null ||
        (isScalar(volumes) &&
          volumes.value === null &&
          volumes.range?.[0] === volumes.range?.[1]))
    ) {
      return [
        insertLine(
          text,
          lineEnd(text, keyNode.range[1]),
          `${indent}${declaration}`
        ),
      ]
    }
    const first = isMap(volumes) ? (volumes.items[0]?.key as Node) : undefined
    if (
      isMap(volumes) &&
      !volumes.flow &&
      !volumes.anchor &&
      !hasMerge(volumes) &&
      volumes.range &&
      first?.range
    ) {
      return [
        insertLine(
          text,
          volumes.range[1],
          `${" ".repeat(column(text, first.range[0]))}${declaration}`
        ),
      ]
    }
  }
  throw new Error(
    `Declare the volume ${name} under volumes in the Compose file first.`
  )
}

function replaceNode(node: Node, text: string): Patch {
  const [start, end] = node.range!
  return { end, start, text }
}

// A line of its own at `at`, which starts a line or ends the file.
function insertLine(text: string, at: number, line: string): Patch {
  const newline = text.includes("\r\n") ? "\r\n" : "\n"
  const before = at > 0 && text[at - 1] !== "\n" ? newline : ""
  return {
    end: at,
    start: at,
    text: `${before}${line.replaceAll("\n", newline)}${newline}`,
  }
}

function applyPatches(text: string, patches: ReadonlyArray<Patch>): string {
  return [...patches]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (current, patch) =>
        current.slice(0, patch.start) + patch.text + current.slice(patch.end),
      text
    )
}

// A value written as YAML would read it back, in the quotes the value it
// replaces used.
function scalarText(value: string | boolean, like?: Scalar): string {
  if (typeof value === "boolean") return String(value)
  if (like?.type === "QUOTE_DOUBLE") return JSON.stringify(value)
  if (like?.type === "QUOTE_SINGLE") return `'${value.replaceAll("'", "''")}'`
  // On one line, quoted wherever YAML would read it as something else.
  const plain = new Document(value).toString({ lineWidth: 0 }).trimEnd()
  return plain.includes("\n") ? JSON.stringify(value) : plain
}

// Strings in a flow map are quoted unless they're plainly a path or name,
// since commas and brackets end values there; JSON's quotes are YAML's
// double quotes.
function flowMap(entries: Record<string, string | boolean>): string {
  const pairs = Object.entries(entries).map(
    ([key, value]) =>
      `${key}: ${typeof value === "string" ? flowScalar(value) : value}`
  )
  return `{ ${pairs.join(", ")} }`
}

function flowScalar(value: string): string {
  const plain = /^[\w./-]+$/u.test(value) && scalarText(value) === value
  return plain ? value : JSON.stringify(value)
}

function lineStart(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1
}

// Past the end of the line `at` is on, its newline included.
function lineEnd(text: string, at: number): number {
  const end = text.indexOf("\n", at)
  return end === -1 ? text.length : end + 1
}

function column(text: string, at: number): number {
  return at - lineStart(text, at)
}

// Whether the entry is the file's own to change: it, the list it's in, and
// the service it's for are written where they are, none of it shared
// through an anchor or alias, and nothing merged in from elsewhere, which
// a change could reveal or leave in force.
function ownNode(
  document: Document,
  [service, section, index]: [string, Section, number]
): boolean {
  const services = document.get("services", true)
  const definition = document.getIn(["services", service], true)
  const list = document.getIn(["services", service, section], true)
  const entry = document.getIn(["services", service, section, index], true)
  if (!isMap(services) || !isMap(definition) || !isSeq(list)) return false
  if (!isNode(entry) || isAlias(entry)) return false
  if (hasMerge(services) || hasMerge(definition)) return false
  if ([services, definition, list].some((node) => node.anchor)) return false
  // Its lines are what's rewritten, so they're the block style's own.
  if ([services, definition, list].some((node) => node.flow)) return false
  // Compose gives tags like !reset and !override meanings of their own.
  if ([services, definition, list].some((node) => node.tag)) return false
  if (unreadableSettings(entry)) return false
  let shared = false
  visit(entry, {
    Alias: () => {
      shared = true
      return visit.BREAK
    },
    Node: (_, node) => {
      if (node.anchor || node.tag) {
        shared = true
        return visit.BREAK
      }
    },
    Pair: (_, pair) => {
      if (isMergeKey(pair.key)) {
        shared = true
        return visit.BREAK
      }
    },
  })
  return !shared
}

// Settings this can't read for certain, so a change here could undo them:
// what a variable decides, like `read_only: ${READ_ONLY:-true}` or a whole
// mount in one variable, and a read_only that isn't plainly true or false.
function unreadableSettings(entry: Node): boolean {
  if (isScalar(entry)) {
    if (typeof entry.value !== "string") return true
    if (entry.type === "BLOCK_FOLDED" || entry.type === "BLOCK_LITERAL") {
      return true
    }
    const [first, target, mode] = splitShort(entry.value)
    const access = new Set(
      (mode ?? "").split(",").filter((flag) => flag === "ro" || flag === "rw")
    )
    return (
      (target === undefined && first.includes("$")) ||
      (target ?? "").includes("$") ||
      (mode ?? "").includes("$") ||
      // Both, where which wins is easy to misread.
      access.size > 1
    )
  }
  if (!isMap(entry) || entry.flow) return true
  // A block scalar's range takes the newline after it with it.
  if (
    entry.items.some(
      (pair) =>
        isScalar(pair.value) &&
        (pair.value.type === "BLOCK_FOLDED" ||
          pair.value.type === "BLOCK_LITERAL")
    )
  ) {
    return true
  }
  const readOnly = entry.items.find(
    (pair) => isScalar(pair.key) && pair.key.value === "read_only"
  )
  if (
    readOnly &&
    !(isScalar(readOnly.value) && typeof readOnly.value.value === "boolean")
  ) {
    return true
  }
  return entry.items.some(
    (pair) =>
      isScalar(pair.key) &&
      pair.key.value !== "source" &&
      pair.key.value !== "target" &&
      isNode(pair.value) &&
      hasVariable(pair.value)
  )
}

function hasVariable(node: Node): boolean {
  let found = false
  visit(node, {
    Scalar: (_, scalar) => {
      if (typeof scalar.value === "string" && scalar.value.includes("$")) {
        found = true
        return visit.BREAK
      }
    },
  })
  return found
}

// The file as plain values, or null when its aliases expand past what the
// parser allows.
function resolved(document: Document): unknown {
  const result = Result.try(() => document.toJS() as unknown)
  return Result.isSuccess(result) ? result.success : null
}

function hasMerge(map: YAMLMap): boolean {
  return map.items.some((pair) => isMergeKey(pair.key))
}

// A merge key parses as a symbol, or as "<<" where merges are off.
function isMergeKey(key: unknown): boolean {
  if (!isScalar(key)) return false
  return typeof key.value === "symbol"
    ? key.value.description === "<<"
    : key.value === "<<"
}

function parseFile(text: string) {
  // Compose reads YAML merge keys (<<), so their entries count.
  return parseDocument(text, { merge: true })
}

function volumeMount(
  file: Record<string, unknown>,
  project: string,
  entry: unknown
): Omit<ComposeMount, "editable" | "key" | "service"> | null {
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
): Omit<ComposeMount, "editable" | "key" | "service"> | null {
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

function parseKey(key: string): [string, Section, number] {
  return JSON.parse(key) as [string, Section, number]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
