import {
  arch,
  cpus,
  freemem,
  hostname,
  loadavg,
  platform,
  totalmem,
} from "node:os"
import { statfs } from "node:fs/promises"

import type { RelayNode } from "@workspace/contracts"

import { relayBuildLabel } from "./build-info.js"
import type { RelayConfig } from "./config.js"
import type { DockerDriver } from "./docker.js"
import { relayProcessMemory } from "./relay-memory.js"

const connectedAt = new Date().toISOString()
const relayVersion = relayBuildLabel()

export async function nodeSnapshot(
  config: RelayConfig,
  docker: DockerDriver
): Promise<RelayNode> {
  const filesystem = await statfs(config.rootDirectory)
  const storageTotal = filesystem.blocks * filesystem.bsize
  const storageAvailable = filesystem.bavail * filesystem.bsize
  const [dockerVersion, startedAt, relayMemory] = await Promise.all([
    docker.dockerVersion(),
    docker.relayStartedAt(),
    relayProcessMemory(),
  ])
  const totalMemory = totalmem()
  const startedAtTimestamp = startedAt ? Date.parse(startedAt) : Number.NaN

  return {
    id: config.nodeId,
    name: config.nodeName || hostname(),
    version: relayVersion,
    capabilities: ["tailscale-stacks", "tailscale-staged-removal"],
    canProvisionInstances: config.canProvisionInstances,
    platform: platform(),
    arch: arch(),
    uptimeSeconds: Number.isFinite(startedAtTimestamp)
      ? Math.max(0, Math.floor((Date.now() - startedAtTimestamp) / 1_000))
      : null,
    startedAt,
    cpu: {
      cores: cpus().length,
      loadPercent: Math.round((loadavg()[0] / cpus().length) * 10_000) / 100,
    },
    memory: {
      totalBytes: totalMemory,
      usedBytes: totalMemory - freemem(),
    },
    storage: {
      totalBytes: storageTotal,
      usedBytes: storageTotal - storageAvailable,
    },
    docker: {
      available: dockerVersion !== null,
      version: dockerVersion,
    },
    connectedAt,
    relayMemory,
  }
}
