import { z } from "zod"

import { commandError } from "./errors.js"

export interface CliArguments {
  brick?: string
  command: Array<string>
  confirm?: string
  cpu?: string
  disk?: string
  follow: boolean
  gameVersion?: string
  help: boolean
  javaVersion?: string
  limit: number
  memory?: string
  mode?: "full" | "incremental"
  name?: string
  noOpen: boolean
  passwordStdin: boolean
  profile?: string
  safetyBackup: boolean
  storage?: string
  token?: string
  url?: string
  variables: Array<string>
  version: boolean
  start: boolean
}

export function parseArguments(argv: Array<string>): CliArguments {
  const command: Array<string> = []
  let brick: string | undefined
  let confirm: string | undefined
  let cpu: string | undefined
  let disk: string | undefined
  let follow = false
  let gameVersion: string | undefined
  let help = false
  let limit = 2_000
  let javaVersion: string | undefined
  let memory: string | undefined
  let mode: "full" | "incremental" | undefined
  let name: string | undefined
  let noOpen = false
  let passwordStdin = false
  let profile: string | undefined
  let safetyBackup = true
  let storage: string | undefined
  let token: string | undefined
  let url: string | undefined
  const variables: Array<string> = []
  let version = false
  let start = true

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument) continue
    const [flag, inlineValue] = argument.split("=", 2)
    const value = () => {
      if (inlineValue !== undefined) return inlineValue
      const next = argv[index + 1]
      if (!next || next.startsWith("--")) {
        throw commandError({
          code: "invalid_arguments",
          exitCode: 2,
          message: `${flag} requires a value.`,
        })
      }
      index += 1
      return next
    }
    if (flag === "--brick") brick = value()
    else if (flag === "--confirm") confirm = value()
    else if (flag === "--cpu") cpu = value()
    else if (flag === "--disk") disk = value()
    else if (flag === "--follow" || flag === "-f") follow = true
    else if (flag === "--game-version") gameVersion = value()
    else if (flag === "--help" || flag === "-h") help = true
    else if (flag === "--java-version") javaVersion = value()
    else if (flag === "--memory") memory = value()
    else if (flag === "--mode") {
      const parsed = z.enum(["full", "incremental"]).safeParse(value())
      if (!parsed.success) {
        throw commandError({
          code: "invalid_arguments",
          exitCode: 2,
          message: "--mode must be full or incremental.",
        })
      }
      mode = parsed.data
    }
    else if (flag === "--no-open") noOpen = true
    else if (flag === "--no-safety-backup") safetyBackup = false
    else if (flag === "--no-start") start = false
    else if (flag === "--password-stdin") passwordStdin = true
    else if (flag === "--version" || flag === "-v") version = true
    else if (flag === "--limit") {
      const parsed = z.coerce
        .number()
        .int()
        .min(1)
        .max(10_000)
        .safeParse(value())
      if (!parsed.success) {
        throw commandError({
          code: "invalid_arguments",
          exitCode: 2,
          message: "--limit must be an integer from 1 to 10000.",
        })
      }
      limit = parsed.data
    } else if (flag === "--name") name = value()
    else if (flag === "--profile") profile = value()
    else if (flag === "--storage") storage = value()
    else if (flag === "--token") token = value()
    else if (flag === "--url") url = value()
    else if (flag === "--variable") variables.push(value())
    else if (argument.startsWith("-")) {
      throw commandError({
        code: "invalid_arguments",
        exitCode: 2,
        message: `Unknown option: ${argument}`,
      })
    } else command.push(argument)
  }
  return {
    ...(brick ? { brick } : {}),
    command,
    ...(confirm ? { confirm } : {}),
    ...(cpu ? { cpu } : {}),
    ...(disk ? { disk } : {}),
    follow,
    ...(gameVersion ? { gameVersion } : {}),
    help,
    ...(javaVersion ? { javaVersion } : {}),
    limit,
    ...(memory ? { memory } : {}),
    ...(mode ? { mode } : {}),
    ...(name ? { name } : {}),
    noOpen,
    passwordStdin,
    ...(profile ? { profile } : {}),
    safetyBackup,
    ...(storage ? { storage } : {}),
    ...(token ? { token } : {}),
    ...(url ? { url } : {}),
    variables,
    version,
    start,
  }
}
