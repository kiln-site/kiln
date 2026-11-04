import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "vite-plus/test"

import { KILN_DESKTOP_IMAGE_TAG } from "../packages/contracts/src/git-repository.ts"

const workspaceRoot = new URL("../", import.meta.url)
const read = (path) => readFile(new URL(path, workspaceRoot), "utf8")

// A Relay pulls the tag, which CI publishes from the Dockerfile's version, and
// its stream plays in the client Hearth serves.
test("Relays, the image, and Hearth's client are the same voxl", async () => {
  const [dockerfile, client] = await Promise.all([
    read("apps/desktop/Dockerfile"),
    read("apps/web/public/desktop-client/VERSION"),
  ])
  const voxl = /^ARG VOXL_VERSION=(.+)$/mu.exec(dockerfile)?.[1]
  const revision = /^ARG DESKTOP_IMAGE_REVISION=(.+)$/mu.exec(dockerfile)?.[1]
  assert.equal(`${voxl}-${revision}`, KILN_DESKTOP_IMAGE_TAG)
  assert.equal(client.trim(), voxl)
})
