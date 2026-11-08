// Which viewer shows a file, from its path alone. Kept tiny and free of
// React so a route can choose what to read, and which module to warm, before
// the Files workspace loads.

/**
 * A file's viewer. Text viewers show the file's text read through Hearth,
 * in the editor and, for some, rendered beside it; the others read the file
 * their own way.
 */
export type FileViewerKind = TextViewerKind | FileContentViewerKind

/** The viewers that show a file's text, read through Hearth. */
export type TextViewerKind = "text" | RenderedTextViewerKind

/** Text files that can also be shown rendered, as a document or a table. */
export type RenderedTextViewerKind = "csv" | "markdown" | "svg"

/** The viewers that read a file their own way rather than as text. */
export type FileContentViewerKind =
  | "audio"
  | "database"
  | "image"
  | "pdf"
  | "video"

const textViewers: ReadonlySet<FileViewerKind> = new Set<TextViewerKind>([
  "csv",
  "markdown",
  "svg",
  "text",
])

// Matched by extension, longest first where one is a suffix of another.
const viewersByExtension: ReadonlyArray<readonly [RegExp, FileViewerKind]> = [
  [/\.(?:db|sqlite|sqlite3|db3|s3db|sl3)$/iu, "database"],
  [/\.(?:md|markdown|mdown|mkd)$/iu, "markdown"],
  [/\.(?:csv|tsv|tab)$/iu, "csv"],
  [/\.svg$/iu, "svg"],
  [/\.(?:apng|avif|bmp|gif|ico|jpe?g|png|webp)$/iu, "image"],
  [/\.pdf$/iu, "pdf"],
  // As the Relay serves previews; browsers play what they can of these.
  [/\.(?:m4v|mov|mp4|ogv|webm)$/iu, "video"],
  [/\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav|weba)$/iu, "audio"],
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

/** Whether a text file of `kind` can also be shown rendered. */
export function fileViewerRendersText(
  kind: TextViewerKind
): kind is RenderedTextViewerKind {
  return kind !== "text"
}
