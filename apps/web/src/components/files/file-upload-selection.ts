export interface UploadFile {
  file: File
  path: string
}

export const maxFolderUploadFiles = 5_000
const maxFolderUploadEntries = 10_000

function fileUploadRelativePath(file: {
  name: string
  webkitRelativePath: string
}): string {
  const relativePath = file.webkitRelativePath.replaceAll("\\", "/")
  if (
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.split("/").some((segment) => segment === "..")
  ) {
    return file.name
  }
  return relativePath
}

export function selectedUploadFiles(files: Iterable<File>): Array<UploadFile> {
  return Array.from(files, (file) => ({
    file,
    path: fileUploadRelativePath(file),
  }))
}

function isDroppedFileEntry(
  entry: FileSystemEntry
): entry is FileSystemFileEntry {
  return entry.isFile
}

function isDroppedDirectoryEntry(
  entry: FileSystemEntry
): entry is FileSystemDirectoryEntry {
  return entry.isDirectory
}

function droppedEntryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolveFile, reject) => entry.file(resolveFile, reject))
}

function readDroppedDirectory(
  directory: FileSystemDirectoryEntry
): Promise<Array<FileSystemEntry>> {
  const reader = directory.createReader()
  return new Promise((resolveEntries, reject) => {
    const entries: Array<FileSystemEntry> = []
    const readNext = () => {
      reader.readEntries((batch) => {
        if (!batch.length) {
          resolveEntries(entries)
          return
        }
        entries.push(...batch)
        if (entries.length > maxFolderUploadEntries) {
          reject(new Error("Folder is too large to enumerate safely"))
          return
        }
        readNext()
      }, reject)
    }
    readNext()
  })
}

async function collectDroppedEntries(
  entries: ReadonlyArray<FileSystemEntry>
): Promise<Array<UploadFile>> {
  if (entries.length > maxFolderUploadEntries) {
    throw new Error("Folder is too large to enumerate safely")
  }
  const queue = entries.map((entry) => ({ entry, path: entry.name }))
  const files: Array<UploadFile> = []
  let index = 0
  while (index < queue.length) {
    const current = queue[index]
    index += 1
    if (!current) break
    if (isDroppedFileEntry(current.entry)) {
      files.push({
        file: await droppedEntryFile(current.entry),
        path: current.path,
      })
      if (files.length > maxFolderUploadFiles) {
        throw new Error(
          `Folders can contain at most ${maxFolderUploadFiles.toLocaleString()} files per upload`
        )
      }
      continue
    }
    if (!isDroppedDirectoryEntry(current.entry)) continue
    const children = await readDroppedDirectory(current.entry)
    if (queue.length + children.length > maxFolderUploadEntries) {
      throw new Error("Folder is too large to enumerate safely")
    }
    for (const child of children) {
      queue.push({
        entry: child,
        path: `${current.path}/${child.name}`,
      })
    }
  }
  return files
}

export function droppedUploadFiles(
  dataTransfer: DataTransfer
): Promise<Array<UploadFile>> {
  const entries = Array.from(dataTransfer.items).flatMap((item) => {
    if (item.kind !== "file") return []
    const entry = item.webkitGetAsEntry()
    return entry ? [entry] : []
  })
  return entries.length
    ? collectDroppedEntries(entries)
    : Promise.resolve(selectedUploadFiles(dataTransfer.files))
}
