import type { FileRoot, FilesystemDriver } from "../../files.js"
import type { LaneLock } from "../../operation-lanes.js"

/**
 * A file root a transfer packs from or installs into, with the lane locks
 * each takes: packing reads the root beside other work and waits only for
 * work that replaces it; installing replaces what's there, so it runs alone.
 */
export interface TransferFileRoot {
  readonly filesystem: FilesystemDriver
  readonly root: FileRoot
  readonly packLocks: ReadonlyArray<LaneLock>
  readonly installLocks: ReadonlyArray<LaneLock>
}

export type TransferRootResolver = (rootId: string) => Promise<TransferFileRoot>
