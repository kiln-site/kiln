import type { BrickVariableValue } from "@workspace/contracts"

import { interpolateBrickEnvironment } from "./brick-variables.js"

const DEFAULT_MIN_RAM = "512M"
const DEFAULT_MAX_RAM_PERCENTAGE = 75
const MEBIBYTE = 1024 ** 2
const GIBIBYTE = 1024 ** 3

export function dockerMemoryBytes(value: string): number | null {
  const match = value.trim().match(/^(\d+)([bkmgt])$/iu)
  if (!match?.[1] || !match[2]) return null
  const amount = Number(match[1])
  const unit = match[2].toLowerCase()
  const exponent =
    unit === "b"
      ? 0
      : unit === "k"
        ? 1
        : unit === "m"
          ? 2
          : unit === "g"
            ? 3
            : 4
  const bytes = amount * 1024 ** exponent
  return Number.isSafeInteger(bytes) ? bytes : null
}

export function managedJavaStartupFlags(
  environment: Readonly<Record<string, string>>,
  memory: string | undefined,
  variables: Readonly<Record<string, BrickVariableValue>> = {},
  brick?: { id: string; name?: string }
): string {
  const resolved = interpolateBrickEnvironment(environment, variables, brick)
  const minRam = resolved.MIN_RAM?.trim() || DEFAULT_MIN_RAM
  const flags = [`-Xms${minRam}`]
  const maxRam = resolved.MAX_RAM?.trim()
  if (maxRam) flags.push(`-Xmx${maxRam}`)
  else {
    const percentage = Number(
      resolved.KILN_JAVA_MAX_RAM_PERCENTAGE ?? DEFAULT_MAX_RAM_PERCENTAGE
    )
    const heapBytes =
      memory && Number.isFinite(percentage)
        ? heapBytesFromContainerMemory(memory, percentage)
        : null
    flags.push(
      heapBytes
        ? `-Xmx${formatJavaMemory(heapBytes)}`
        : `-XX:MaxRAMPercentage=${Number.isFinite(percentage) ? percentage : DEFAULT_MAX_RAM_PERCENTAGE}`
    )
  }
  const artifactFile = resolved.KILN_ARTIFACT_FILE?.trim()
  if (artifactFile) flags.push("-jar", artifactFile)
  if (!Object.hasOwn(resolved, "KILN_SERVER_ARGS")) flags.push("--nogui")
  else {
    const serverArgs = resolved.KILN_SERVER_ARGS.trim()
    if (serverArgs) flags.push(serverArgs)
  }
  return flags.join(" ")
}

function heapBytesFromContainerMemory(
  memory: string,
  percentage: number
): number | null {
  const bytes = dockerMemoryBytes(memory)
  if (bytes === null || percentage <= 0) return null
  const heap = Math.floor((bytes * percentage) / 100)
  return heap > 0 ? heap : null
}

function formatJavaMemory(bytes: number): string {
  if (bytes >= GIBIBYTE && bytes % GIBIBYTE === 0) return `${bytes / GIBIBYTE}G`
  if (bytes >= MEBIBYTE && bytes % MEBIBYTE === 0) return `${bytes / MEBIBYTE}M`
  return `${Math.max(1, Math.round(bytes / MEBIBYTE))}M`
}
