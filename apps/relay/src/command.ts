import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { Effect } from "effect"

import { CommandError } from "./effect/errors.js"
import { runRelayEffect } from "./effect/runtime.js"

const executeFile = promisify(execFile)

export interface CommandResult {
  stderr: string
  stdout: string
}

export interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  maxBuffer?: number
  signal?: AbortSignal
  timeout?: number
}

export async function command(
  executable: string,
  arguments_: Array<string>,
  options: CommandOptions = {}
): Promise<CommandResult> {
  return runRelayEffect(
    "command.execute",
    commandEffect(executable, arguments_, options)
  )
}

export const commandEffect = Effect.fn("command.execute")(function* (
  executable: string,
  arguments_: Array<string>,
  options: CommandOptions = {}
) {
  const result = yield* Effect.tryPromise({
    try: () =>
      executeFile(executable, arguments_, {
        cwd: options.cwd,
        encoding: "utf8",
        env: options.env,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
        signal: options.signal,
        timeout: options.timeout ?? 30_000,
      }),
    catch: (cause) =>
      CommandError.make({
        executable,
        message:
          cause instanceof Error ? cause.message : `${executable} failed`,
        cause,
      }),
  })

  return { stderr: result.stderr, stdout: result.stdout }
})

// Longer lines are cut, so one line without an end can't grow without limit.
const MAX_COMMAND_LINE_CHARACTERS = 1024 * 1024

/**
 * Runs a process and hands each line of its stdout and stderr to `onLine` as
 * it arrives, so output of any size is read without holding all of it.
 */
export function commandLines(
  executable: string,
  arguments_: ReadonlyArray<string>,
  onLine: (line: string) => void,
  options: { signal?: AbortSignal; timeout?: number } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`${executable} timed out`))
    }, options.timeout ?? 30_000)
    const reader = () => {
      let pending = ""
      return {
        flush: () => {
          if (pending) onLine(pending)
          pending = ""
        },
        read: (chunk: Buffer) => {
          const lines = (pending + chunk.toString("utf8")).split("\n")
          pending = (lines.pop() ?? "").slice(0, MAX_COMMAND_LINE_CHARACTERS)
          for (const line of lines) {
            onLine(line.slice(0, MAX_COMMAND_LINE_CHARACTERS))
          }
        },
      }
    }
    const stdout = reader()
    const stderr = reader()
    child.stdout.on("data", stdout.read)
    child.stderr.on("data", stderr.read)
    child.once("error", (cause) => {
      clearTimeout(timeout)
      reject(cause)
    })
    child.once("close", (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`${executable} exited with code ${code}`))
        return
      }
      stdout.flush()
      stderr.flush()
      resolve()
    })
  })
}

/**
 * Runs a process with `input` written to stdin, killing it once its combined
 * output exceeds `maxOutputBytes` or it runs longer than `timeoutMs`.
 */
export function commandWithInput(
  executable: string,
  arguments_: ReadonlyArray<string>,
  input: string | undefined,
  options: { maxOutputBytes: number; timeoutMs: number }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout: Array<Buffer> = []
    const stderr: Array<Buffer> = []
    let outputBytes = 0
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`${executable} timed out`))
    }, options.timeoutMs)
    const collect = (target: Array<Buffer>) => (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > options.maxOutputBytes) {
        child.kill("SIGKILL")
        reject(new Error("Database transfer exceeded the current size limit"))
        return
      }
      target.push(chunk)
    }
    child.stdout.on("data", collect(stdout))
    child.stderr.on("data", collect(stderr))
    child.once("error", (cause) => {
      clearTimeout(timeout)
      reject(cause)
    })
    child.once("close", (code) => {
      clearTimeout(timeout)
      const result = {
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      }
      if (code === 0) resolve(result)
      else
        reject(
          new Error(
            result.stderr.trim() || `${executable} exited with code ${code}`
          )
        )
    })
    child.stdin.end(input)
  })
}
