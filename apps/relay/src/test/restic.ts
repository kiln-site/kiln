import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { FakeContainer } from "./docker.js"
import { fakeDocker } from "./docker.js"

/** A volume as a snapshot of it holds it. */
type VolumeSnapshot = {
  directories: Array<string>
  files: Array<[string, string]>
  owners: Array<[string, { gid: number; mode: number; uid: number }]>
  symlinks: Array<[string, string]>
}

interface Snapshot {
  id: string
  tags: Array<string>
  volume: VolumeSnapshot
}

/**
 * restic in place of the Relay's own, for one repository: the commands it
 * runs beside itself are a program's at `path`, and those it runs in a helper
 * take and restore snapshots of the volume Docker mounts there.
 */
export class FakeRestic {
  readonly path: string
  readonly #state: string
  #next = 1
  /** What the last snapshot of a volume was told to leave out. */
  excludes: Array<string> = []
  /** Told as each snapshot of a volume is taken, which it may fail. */
  onBackup: (tags: ReadonlyArray<string>) => void = () => undefined

  constructor(directory: string) {
    this.path = join(directory, "fake-restic")
    this.#state = join(directory, "fake-restic.json")
    writeFileSync(
      this.path,
      `#!${process.execPath}
const { existsSync, readFileSync, writeFileSync } = require("node:fs")
const state = ${JSON.stringify(this.#state)}
const args = process.argv.slice(2).filter((arg) => arg !== "--no-cache")
if (args[0] === "init") writeFileSync(state, "[]")
else if (!existsSync(state)) process.exit(10)
const snapshots = JSON.parse(readFileSync(state, "utf8"))
if (args[0] === "snapshots") {
  const tags = args[args.indexOf("--tag") + 1].split(",")
  console.log(JSON.stringify(snapshots.filter((one) => tags.every((tag) => one.tags.includes(tag)))))
} else if (args[0] === "forget") {
  writeFileSync(state, JSON.stringify(snapshots.filter((one) => one.id !== args[1])))
} else if (args[0] === "stats") console.log(JSON.stringify({ total_size: 1 }))
else if (args[0] === "key") console.log("[]")
`
    )
    chmodSync(this.path, 0o755)
    fakeDocker.entrypoints.set(this.path, (container) => this.#run(container))
  }

  get snapshots(): Array<Snapshot> {
    return existsSync(this.#state)
      ? (JSON.parse(readFileSync(this.#state, "utf8")) as Array<Snapshot>)
      : []
  }

  async #run(
    container: FakeContainer
  ): Promise<{ exitCode: number; stderr?: string; stdout?: string }> {
    const args = container.cmd.filter((arg) => arg !== "--no-cache")
    const mount = container.mounts.find(
      ({ destination }) => destination === "/volume"
    )
    const volume = fakeDocker.volumes.get(mount?.source ?? "")
    if (!volume) return { exitCode: 1, stderr: "no volume" }
    if (args[0] === "restore") {
      const taken = this.snapshots.find(({ id }) => id === args[2])?.volume
      const target = args[args.indexOf("--target") + 1]?.slice(
        "/volume/".length
      )
      // Over the volume itself, its root alone.
      if (taken && args.includes("--exclude")) return { exitCode: 0 }
      if (!taken || !target) return { exitCode: 1, stderr: "no snapshot" }
      const under = (path: string) =>
        path ? `${target}/volume/${path}` : `${target}/volume`
      volume.directories.add(under(""))
      for (const path of taken.directories) volume.directories.add(under(path))
      for (const [path, body] of taken.files)
        volume.files.set(under(path), body)
      for (const [path, to] of taken.symlinks)
        volume.symlinks.set(under(path), to)
      for (const [path, owner] of taken.owners) {
        volume.owners.set(under(path), owner)
      }
      return { exitCode: 0 }
    }
    this.excludes = args.flatMap((arg, index) =>
      args[index - 1] === "--exclude" ? [arg] : []
    )
    const tags = args.flatMap((arg, index) =>
      args[index - 1] === "--tag" ? [arg] : []
    )
    const failure = await Promise.resolve(tags)
      .then(this.onBackup)
      .then(
        () => null,
        (cause: Error) => cause.message
      )
    if (failure !== null) return { exitCode: 1, stderr: failure }
    const id = `${this.#next++}`.padStart(8, "a")
    const snapshot: Snapshot = {
      id,
      tags,
      volume: {
        directories: [...volume.directories],
        files: [...volume.files],
        owners: [...volume.owners],
        symlinks: [...volume.symlinks],
      },
    }
    writeFileSync(this.#state, JSON.stringify([...this.snapshots, snapshot]))
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ message_type: "summary", snapshot_id: id, total_bytes_processed: 1 })}\n`,
    }
  }
}
