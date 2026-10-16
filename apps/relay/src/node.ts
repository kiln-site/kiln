import {
  arch,
  cpus,
  freemem,
  hostname,
  loadavg,
  platform,
  totalmem,
  uptime,
} from "node:os"
import { statfs } from "node:fs/promises"

import type { RelayNode } from "@workspace/contracts"

import { relayBuildLabel } from "./build-info.js"
import type { RelayConfig } from "./config.js"
import { hostCpuModel } from "./cpu-model.js"
import type { DockerDriver } from "./docker.js"
import { relayProcessMemory } from "./relay-memory.js"

const connectedAt = new Date().toISOString()
const relayVersion = relayBuildLabel()

// When the machine booted. Linux counts uptime for the whole machine, even
// inside a container. Worked out once: samples of it jitter, and a value that
// changed between snapshots would send Hearth a node update each time.
const nodeBootedAt = new Date(
  Math.round((Date.now() - uptime() * 1_000) / 1_000) * 1_000
).toISOString()

export async function nodeSnapshot(
  config: RelayConfig,
  docker: DockerDriver
): Promise<RelayNode> {
  const filesystem = await statfs(config.rootDirectory)
  const storageTotal = filesystem.blocks * filesystem.bsize
  const storageAvailable = filesystem.bavail * filesystem.bsize
  const operatingSystem = docker.hostOperatingSystem()
  const [dockerVersion, cpuModel, startedAt, relayMemory] = await Promise.all([
    docker.dockerVersion(),
    hostCpuModel(),
    docker.relayStartedAt(),
    relayProcessMemory(),
  ])
  const relayResources = docker.relayResources()
  const totalMemory = totalmem()
  const startedAtTimestamp = startedAt ? Date.parse(startedAt) : Number.NaN

  return {
    id: config.nodeId,
    name: config.nodeName || hostname(),
    version: relayVersion,
    capabilities: [
      "schedule-continue-on-failure",
      "tailscale-stacks",
      "tailscale-staged-removal",
    ],
    canProvisionInstances: config.canProvisionInstances,
    platform: platform(),
    arch: arch(),
    uptimeSeconds: Number.isFinite(startedAtTimestamp)
      ? Math.max(0, Math.floor((Date.now() - startedAtTimestamp) / 1_000))
      : null,
    startedAt,
    bootedAt: nodeBootedAt,
    cpu: {
      cores: cpus().length,
      loadPercent: Math.round((loadavg()[0] / cpus().length) * 10_000) / 100,
      ...(cpuModel ? { model: cpuModel } : {}),
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
    ...(operatingSystem ? { operatingSystem } : {}),
    connectedAt,
    relayMemory,
    ...(relayResources ? { relayResources } : {}),
  }
}
