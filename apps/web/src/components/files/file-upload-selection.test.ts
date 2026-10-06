import { describe, expect, it } from "vite-plus/test"

import {
  droppedUploadFiles,
  selectedUploadFiles,
} from "@/components/files/file-upload-selection"

class TestFileSystem implements FileSystem {
  readonly name = "test"
  readonly root: FileSystemDirectoryEntry

  constructor() {
    this.root = new TestDirectoryEntry("", [], this)
  }
}

abstract class TestEntry implements FileSystemEntry {
  readonly fullPath: string
  abstract readonly isDirectory: boolean
  abstract readonly isFile: boolean

  constructor(
    readonly name: string,
    readonly filesystem: FileSystem
  ) {
    this.fullPath = `/${name}`
  }

  getParent(successCallback?: FileSystemEntryCallback): void {
    successCallback?.(this.filesystem.root)
  }
}

class TestFileEntry extends TestEntry implements FileSystemFileEntry {
  readonly isDirectory = false
  readonly isFile = true

  constructor(
    readonly value: File,
    filesystem: FileSystem
  ) {
    super(value.name, filesystem)
  }

  file(successCallback: FileCallback): void {
    successCallback(this.value)
  }
}

class TestDirectoryEntry extends TestEntry implements FileSystemDirectoryEntry {
  readonly isDirectory = true
  readonly isFile = false

  constructor(
    name: string,
    private readonly batches: ReadonlyArray<ReadonlyArray<FileSystemEntry>>,
    filesystem: FileSystem
  ) {
    super(name, filesystem)
  }

  createReader(): FileSystemDirectoryReader {
    let batchIndex = 0
    return {
      readEntries: (successCallback) => {
        const batch = Array.from(this.batches[batchIndex] ?? [])
        batchIndex += 1
        successCallback(batch)
      },
    }
  }

  getDirectory(): void {}

  getFile(): void {}
}

// A file picked through a directory input, which reports its relative path.
function pickedFile(webkitRelativePath: string): File {
  return Object.defineProperty(
    new File([""], "config.yml"),
    "webkitRelativePath",
    {
      value: webkitRelativePath,
    }
  )
}

// The browser's drop payload for `entries`.
function dropOf(entries: ReadonlyArray<FileSystemEntry>): DataTransfer {
  return {
    files: [],
    items: entries.map((entry) => ({
      kind: "file",
      webkitGetAsEntry: () => entry,
    })),
  } as unknown as DataTransfer
}

describe("file upload selection", () => {
  it("preserves safe paths supplied by directory inputs", () => {
    expect(
      selectedUploadFiles([
        pickedFile("pack/config/config.yml"),
        pickedFile("pack/overrides/config.yml"),
        pickedFile("../config.yml"),
      ]).map(({ path }) => path)
    ).toEqual([
      "pack/config/config.yml",
      "pack/overrides/config.yml",
      "config.yml",
    ])
  })

  it("recursively enumerates every directory reader batch", async () => {
    const filesystem = new TestFileSystem()
    const server = new TestFileEntry(
      new File(["port=25565"], "server.yml"),
      filesystem
    )
    const messages = new TestFileEntry(
      new File(["welcome"], "messages.yml"),
      filesystem
    )
    const config = new TestDirectoryEntry(
      "config",
      [[server], [messages]],
      filesystem
    )
    const pack = new TestDirectoryEntry("pack", [[config]], filesystem)

    const uploads = await droppedUploadFiles(dropOf([pack]))

    expect(uploads.map(({ path }) => path)).toEqual([
      "pack/config/server.yml",
      "pack/config/messages.yml",
    ])
    await expect(
      Promise.all(uploads.map(({ file }) => file.text()))
    ).resolves.toEqual(["port=25565", "welcome"])
  })
})
