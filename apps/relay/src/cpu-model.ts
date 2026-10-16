import { readFile } from "node:fs/promises"
import { cpus } from "node:os"

import { Effect } from "effect"

// x86 CPUs name themselves in /proc/cpuinfo; ARM ones only give vendor and
// part codes, which these name, as lscpu does, for the server chips Relays
// commonly run on.
const armVendors: Record<string, string> = {
  "0x41": "Arm",
  "0x48": "HiSilicon",
  "0x4e": "NVIDIA",
  "0x51": "Qualcomm",
  "0x61": "Apple",
  "0xc0": "Ampere",
}

const armParts: Record<string, string> = {
  "0x41:0xd03": "Cortex-A53",
  "0x41:0xd08": "Cortex-A72",
  "0x41:0xd0b": "Cortex-A76",
  "0x41:0xd0c": "Neoverse N1",
  "0x41:0xd40": "Neoverse V1",
  "0x41:0xd49": "Neoverse N2",
  "0x41:0xd4f": "Neoverse V2",
  "0xc0:0xac3": "AmpereOne",
}

let armModel: Promise<string | null> | undefined

// The host's CPU model, like "AMD EPYC 7763 64-Core Processor", or null when
// the CPU doesn't say.
export async function hostCpuModel(): Promise<string | null> {
  const model = cleanModel(cpus()[0]?.model ?? "")
  if (model && model.toLowerCase() !== "unknown") return model
  armModel ??= readArmModel()
  return armModel
}

async function readArmModel(): Promise<string | null> {
  const cpuinfo = await Effect.runPromise(
    Effect.tryPromise(() => readFile("/proc/cpuinfo", "utf8")).pipe(
      Effect.catch(() => Effect.succeed(""))
    )
  )
  const field = (name: string) =>
    new RegExp(`^${name}\\s*:\\s*(\\S+)`, "mu")
      .exec(cpuinfo)?.[1]
      ?.toLowerCase()
  const vendorCode = field("CPU implementer")
  if (!vendorCode) return null
  const vendor = armVendors[vendorCode]
  const part = armParts[`${vendorCode}:${field("CPU part") ?? ""}`]
  if (part) return vendor === "Arm" ? `Arm ${part}` : part
  return vendor ? `${vendor} ARM` : null
}

function cleanModel(model: string): string {
  return model
    .replace(/\((?:R|TM|tm)\)/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200)
}
