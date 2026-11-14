import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it, onTestFinished } from "vite-plus/test"

import { relayDeploymentLogSchema } from "@workspace/contracts"

import { DeploymentLogs } from "./deployment-logs.js"

async function dataDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "kiln-deployment-logs-"))
  onTestFinished(() => rm(directory, { force: true, recursive: true }))
  return directory
}

const appId = "a".repeat(12)
const databaseId = "d".repeat(12)
const serverId = "e".repeat(12)

// A deployment's log is read with what reading that kind's logs takes, and
// the request says which kind. Each kind's logs are kept apart, so naming
// another kind reads nothing.
it("reads a deployment's log only as the kind it was written for", async () => {
  const logs = new DeploymentLogs(await dataDirectory())
  const serverDeployment = "11111111-1111-4111-8111-111111111111"
  const databaseDeployment = "22222222-2222-4222-8222-222222222222"
  await logs.run(
    { id: serverId, kind: "instance" },
    serverDeployment,
    "Installing",
    async () => {}
  )
  await logs.run(
    { id: databaseId, kind: "database" },
    databaseDeployment,
    "Redeploying",
    async () => {}
  )

  expect(
    await logs.read({ id: serverId, kind: "instance" }, serverDeployment)
  ).not.toBeNull()
  expect(
    await logs.read({ id: databaseId, kind: "database" }, databaseDeployment)
  ).not.toBeNull()
  expect(
    await logs.read({ id: serverId, kind: "database" }, serverDeployment)
  ).toBeNull()
  expect(
    await logs.read({ id: serverId, kind: "app" }, serverDeployment)
  ).toBeNull()
  expect(
    await logs.read({ id: serverId, kind: "instance" }, "../../relay")
  ).toBeNull()
})

it("reads the logs saved before every kind shared one format", async () => {
  const directory = await dataDirectory()
  const line = {
    id: "1",
    level: "info",
    text: "Pulling nginx:alpine",
    timestamp: "2026-11-01T00:00:01.000Z",
  }
  await mkdir(join(directory, "app-deployments", appId), { recursive: true })
  await writeFile(
    join(directory, "app-deployments", appId, "20261101000000.json"),
    JSON.stringify({
      commit: null,
      dropped: 3,
      error: null,
      finishedAt: "2026-11-01T00:00:09.000Z",
      id: "20261101000000",
      lines: [line],
      rolling: true,
      sourceType: "image",
      startedAt: "2026-11-01T00:00:00.000Z",
      state: "succeeded",
    })
  )
  const serverDeployment = "11111111-1111-4111-8111-111111111111"
  await mkdir(join(directory, "server-deployments", serverId), {
    recursive: true,
  })
  await writeFile(
    join(directory, "server-deployments", serverId, `${serverDeployment}.json`),
    JSON.stringify({
      deployment: {
        error: "The image could not be pulled",
        finishedAt: "2026-11-01T00:00:09.000Z",
        id: serverDeployment,
        startedAt: "2026-11-01T00:00:00.000Z",
        state: "failed",
      },
      lines: [{ ...line, origin: "kiln" }],
    })
  )
  const logs = new DeploymentLogs(directory)

  expect(await logs.read({ id: appId, kind: "app" }, "20261101000000")).toEqual(
    {
      deployment: {
        error: null,
        finishedAt: "2026-11-01T00:00:09.000Z",
        id: "20261101000000",
        rolling: true,
        startedAt: "2026-11-01T00:00:00.000Z",
        state: "succeeded",
      },
      dropped: 3,
      lines: [line],
    }
  )
  expect(
    await logs.read({ id: serverId, kind: "instance" }, serverDeployment)
  ).toEqual({
    deployment: {
      error: "The image could not be pulled",
      finishedAt: "2026-11-01T00:00:09.000Z",
      id: serverDeployment,
      rolling: null,
      startedAt: "2026-11-01T00:00:00.000Z",
      state: "failed",
    },
    dropped: 0,
    lines: [{ ...line, origin: "kiln" }],
  })
})

// An App's log saved before deployments recorded whether they rolled over
// has neither that nor its commit, and still reads, as the latest when it
// is.
it("reads an App's log from before deployments recorded rolling over", async () => {
  const directory = await dataDirectory()
  await mkdir(join(directory, "app-deployments", appId), { recursive: true })
  for (const day of [1, 2]) {
    const id = `2026100${day}000000`
    await writeFile(
      join(directory, "app-deployments", appId, `${id}.json`),
      JSON.stringify({
        dropped: 0,
        error: null,
        finishedAt: `2026-10-0${day}T00:00:09.000Z`,
        id,
        lines: [],
        sourceType: "image",
        startedAt: `2026-10-0${day}T00:00:00.000Z`,
        state: "succeeded",
      })
    )
  }
  const logs = new DeploymentLogs(directory)
  const target = { id: appId, kind: "app" } as const

  expect((await logs.read(target, "20261001000000"))?.deployment).toMatchObject(
    { id: "20261001000000", rolling: null }
  )
  expect(
    (await logs.latest(target, relayDeploymentLogSchema))?.deployment.id
  ).toBe("20261002000000")
})

it("keeps each instance's 20 latest logs", async () => {
  const logs = new DeploymentLogs(await dataDirectory())
  const target = { id: appId, kind: "app" } as const
  const ids = Array.from(
    { length: 21 },
    (_, day) => `202611${String(day + 1).padStart(2, "0")}000000`
  )
  // Saved newest first, so only when each was started tells them apart.
  for (const [day, id] of [...ids.entries()].reverse()) {
    await logs.save(target, {
      deployment: {
        error: null,
        finishedAt: null,
        id,
        rolling: null,
        startedAt: new Date(Date.UTC(2026, 10, day + 1)).toISOString(),
        state: "succeeded",
      },
      dropped: 0,
      lines: [],
    })
  }

  expect(await logs.read(target, ids[0]!)).toBeNull()
  expect(await logs.read(target, ids[1]!)).not.toBeNull()
  expect(await logs.read(target, ids[20]!)).not.toBeNull()
})
