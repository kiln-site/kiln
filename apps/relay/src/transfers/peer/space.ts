/**
 * What a transfer needs room for, asked before one starts: how much the
 * root it copies holds, and the free bytes where this Relay keeps artifacts,
 * pulls, and backups, and where it keeps game servers' folders.
 */
import { stat, statfs } from "node:fs/promises"
import { Effect } from "effect"

import type { RelayTransferSpace } from "@workspace/contracts"

export const transferSpace = Effect.fn("RelayTransfer.space")(function* (input: {
  readonly dataDirectory: string
  readonly rootsDirectory: string
  /** Measures the root asked about, if one was. */
  readonly rootBytes: Effect.Effect<number, unknown> | null
}) {
  const [data, roots, dataDevice, rootsDevice, rootBytes] = yield* Effect.all(
    [
      Effect.tryPromise(() => statfs(input.dataDirectory)),
      Effect.tryPromise(() => statfs(input.rootsDirectory)),
      Effect.tryPromise(() => stat(input.dataDirectory)),
      Effect.tryPromise(() => stat(input.rootsDirectory)),
      input.rootBytes ?? Effect.succeed(null),
    ],
    { concurrency: "unbounded" }
  )
  return {
    rootBytes,
    rootsFreeBytes: roots.bavail * roots.bsize,
    sharedFilesystem: dataDevice.dev === rootsDevice.dev,
    transferFreeBytes: data.bavail * data.bsize,
  } satisfies RelayTransferSpace
})
