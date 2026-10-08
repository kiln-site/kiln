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

import { kilnReleaseName, type RelayNode } from "@workspace/contracts"

import { relayBuildLabel, relayBuildReleaseNumber } from "./build-info.js"
import {
  containerReleaseName,
  containerReleaseVersion,
} from "./release-labels.js"
import type { RelayConfig } from "./config.js"
import type { DockerDriver } from "./docker.js"

const connectedAt = new Date().toISOString()
const relayBuild = relayBuildLabel()

export async function nodeSnapshot(
  config: RelayConfig,
  docker: DockerDriver
): Promise<RelayNode> {
  const filesystem = await statfs(config.rootDirectory)
  const storageTotal = filesystem.blocks * filesystem.bsize
  const storageAvailable = filesystem.bavail * filesystem.bsize
  const [dockerVersion, { labels, startedAt }] = await Promise.all([
    docker.dockerVersion(),
    docker.relayContainer(),
  ])
  // Container labels follow updater promotions; the baked build is the
  // fallback outside Docker.
  const labelVersion = containerReleaseVersion(labels)
  const version = labelVersion ?? relayBuild
  const totalMemory = totalmem()
  const startedAtTimestamp = startedAt ? Date.parse(startedAt) : Number.NaN

  return {
    id: config.nodeId,
    name: config.nodeName || hostname(),
    version,
    releaseName: labelVersion
      ? containerReleaseName(labels, labelVersion)
      : kilnReleaseName(relayBuild, relayBuildReleaseNumber),
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
  }
}
