// The media types the Files tab shows in the browser, by extension.

const imageTypes: Readonly<Record<string, string>> = {
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
}

function extensionOf(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

/** The image type a file's name says it is, if the browser shows that type. */
export function imageTypeForPath(path: string): string | undefined {
  return imageTypes[extensionOf(path)]
}

/** The short name of a file's format, as its extension in capitals. */
export function fileFormatLabel(path: string): string {
  return extensionOf(path).toUpperCase()
}
