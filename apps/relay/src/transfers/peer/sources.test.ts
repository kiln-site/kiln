import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test"

import { OperationLanes } from "../../operation-lanes.js"
import type { TransferRoot } from "./roots.js"
import { TransferSources } from "./sources.js"

describe("artifacts a Relay packs for others", () => {
  it("stops a discarded pack and waits for it, so its transfer ID packs again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kiln-transfer-sources-"))
    onTestFinished(() => rm(directory, { force: true, recursive: true }))
    const started = gate()
    const stopping = gate()
    const cleanUp = gate()
    let packs = 0
    // The first pack never ends by itself, and removes what it wrote only
    // once it's stopped and let to; the second packs at once.
    const root: TransferRoot = {
      bytes: Effect.succeed(null),
      install: () => Effect.void,
      installLocks: [],
      pack: (_paths, artifact) => {
        packs += 1
        if (packs > 1) {
          return Effect.promise(() => writeFile(artifact, "second")).pipe(
            Effect.as({ entries: 1, sha256: "b".repeat(64), size: 6 })
          )
        }
        return Effect.promise(() => writeFile(artifact, "first")).pipe(
          Effect.andThen(Effect.sync(() => started.open())),
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.promise(async () => {
              stopping.open()
              await cleanUp.opened
              await rm(artifact)
            })
          )
        )
      },
      packLocks: [],
    }
    const sources = new TransferSources({
      directory,
      lanes: new OperationLanes(),
      resolveRoot: () => Promise.resolve(root),
    })
    const transfer = { rootId: "instance-1", transferId: "transfer-discard-1" }
    const artifact = join(directory, "transfer-discard-1.tar.gz")

    await Effect.runPromise(sources.prepare({ ...transfer, paths: [] }))
    await started.opened
    let discarded = false
    const discarding = Effect.runPromise(sources.discard(transfer)).then(() => {
      discarded = true
    })
    // The pack is told to stop, and the discard waits while it does.
    await stopping.opened
    expect(discarded).toBe(false)
    cleanUp.open()
    await discarding

    // Nothing of the first pack is left to meet the second.
    await Effect.runPromise(sources.prepare({ ...transfer, paths: [] }))
    await vi.waitFor(() => {
      expect(sources.get(transfer)?.state).toBe("ready")
    })
    expect(await readFile(artifact, "utf8")).toBe("second")
  })
})

// Something a test waits on until it's opened.
function gate() {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open: () => open(), opened }
}
