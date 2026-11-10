import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it, onTestFinished } from "vite-plus/test"

import { ServerDeploymentLogs } from "./server-deployment-logs.js"

// A deployment's log is read with what reading that kind's logs takes, and
// the request says which kind. Each kind's store only finds its own, so
// naming the other kind reads nothing.
it("reads a deployment's log only as the kind it was written for", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kiln-deployment-logs-"))
  onTestFinished(() => rm(directory, { force: true, recursive: true }))
  const servers = new ServerDeploymentLogs(directory)
  const databases = new ServerDeploymentLogs(directory, "database-deployments")
  const serverId = "a".repeat(12)
  const databaseId = "d".repeat(12)
  const serverDeployment = "11111111-1111-4111-8111-111111111111"
  const databaseDeployment = "22222222-2222-4222-8222-222222222222"
  await servers.run(serverId, serverDeployment, "Installing", async () => {})
  await databases.run(
    databaseId,
    databaseDeployment,
    "Redeploying",
    async () => {}
  )

  expect(await servers.read(serverId, serverDeployment)).not.toBeNull()
  expect(await databases.read(databaseId, databaseDeployment)).not.toBeNull()
  expect(await databases.read(serverId, serverDeployment)).toBeNull()
  expect(await servers.read(databaseId, databaseDeployment)).toBeNull()
})
