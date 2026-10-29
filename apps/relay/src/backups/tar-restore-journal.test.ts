import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vite-plus/test"

import type { RelayConfig } from "../config.js"
import { exclusive, laneKeys, shared } from "../operation-lanes.js"
import { appLifecycleLocks } from "../operation-plans.js"
import {
  TAR_RESTORE_RECOVERY_LABEL,
  TarRestoreFences,
  writeTarRestoreJournal,
} from "./tar-restore-journal.js"

const appId = "a".repeat(40)
const userId = "b".repeat(40)
const directories: Array<string> = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true })
  }
})

it("fences what an unfinished swap left, an App's own volume and its folder included, from the journals alone", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "kiln-tar-fences-"))
  directories.push(dataDirectory)
  const config = { dataDirectory } as RelayConfig
  const volumeId = `${appId}/pgdata`
  await writeTarRestoreJournal(config, {
    consumers: [appId, userId],
    phase: "installing",
    root: null,
    source: { kind: "volume", name: "website_pgdata" },
    target: { id: volumeId, kind: "volume" },
    taskId: "0b7c9d2e-4f1a-4c3b-9d8e-7f6a5b4c3d2e",
    version: 1,
  })
  await writeTarRestoreJournal(config, {
    consumers: [],
    phase: "clearing",
    root: null,
    source: { kind: "bind", path: "/srv/apps/c" },
    target: { id: "c".repeat(40), kind: "app" },
    taskId: "1b7c9d2e-4f1a-4c3b-9d8e-7f6a5b4c3d2e",
    version: 1,
  })
  // Still staging: the old files are whole.
  await writeTarRestoreJournal(config, {
    consumers: [],
    phase: "staging",
    root: null,
    source: { kind: "bind", path: "/srv/apps/d" },
    target: { id: "d".repeat(40), kind: "app" },
    taskId: "2b7c9d2e-4f1a-4c3b-9d8e-7f6a5b4c3d2e",
    version: 1,
  })

  const fences = await TarRestoreFences.load(config)

  expect(
    fences.refusal("backup.create", [shared(laneKeys.volume(volumeId))])
  ).toContain("the restore must finish first")
  expect(fences.refusal("app.action", appLifecycleLocks(userId))).toContain(
    "can't start until the restore finishes"
  )
  expect(
    fences.refusal("app.files.write", [
      shared(laneKeys.appFiles("c".repeat(40))),
    ])
  ).toContain("the restore must finish first")
  expect(
    fences.refusal(TAR_RESTORE_RECOVERY_LABEL, [
      exclusive(laneKeys.volume(volumeId)),
    ])
  ).toBeNull()
  expect(fences.refusal("app.action", appLifecycleLocks("d".repeat(40)))).toBe(
    null
  )
  expect(
    fences.refusal("backup.create", [shared(laneKeys.volume(`${appId}/cache`))])
  ).toBeNull()

  fences.lift("0b7c9d2e-4f1a-4c3b-9d8e-7f6a5b4c3d2e")
  expect(fences.refusal("app.action", appLifecycleLocks(userId))).toBeNull()
})
