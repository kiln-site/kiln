// Which viewer shows a file, from its path alone. Kept tiny and free of
// React so a route can choose what to read, and which module to warm, before
// the Files workspace loads.

/**
 * A file's viewer. Text viewers show the file's text read through Hearth;
 * the others read the file their own way.
 */
export type FileViewerKind = "text" | "database"

/** The viewers that read a file their own way rather than as text. */
export type FileContentViewerKind = Exclude<FileViewerKind, TextViewerKind>

/** The viewers that show a file's text, read through Hearth. */
export type TextViewerKind = "text"

const textViewers: ReadonlySet<FileViewerKind> = new Set<TextViewerKind>([
  "text",
])

// Matched by extension, longest first where one is a suffix of another.
const viewersByExtension: ReadonlyArray<readonly [RegExp, FileViewerKind]> = [
  [/\.(?:db|sqlite|sqlite3|db3|s3db|sl3)$/iu, "database"],
]

export function fileViewerKind(path: string): FileViewerKind {
  if (!path || path.endsWith("/")) return "text"
  for (const [pattern, kind] of viewersByExtension) {
    if (pattern.test(path)) return kind
  }
  return "text"
}

/** Whether `kind` shows the file's text, read through Hearth. */
export function fileViewerReadsText(
  kind: FileViewerKind
): kind is TextViewerKind {
  return textViewers.has(kind)
}
