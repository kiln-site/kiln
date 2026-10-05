#!/usr/bin/env node
const { spawn } = require("node:child_process")
const { installBinary } = require("./install.cjs")

try {
  const child = spawn(installBinary(), process.argv.slice(2), {
    stdio: "inherit",
  })
  // Windows delivers Ctrl+C to the child itself, and child.kill() there is a
  // hard kill that would skip its cleanup. This launcher only has to stay alive.
  const forward = (signal) => {
    if (process.platform !== "win32") child.kill(signal)
  }
  const onInterrupt = () => forward("SIGINT")
  const onTerminate = () => forward("SIGTERM")
  process.on("SIGINT", onInterrupt)
  process.on("SIGTERM", onTerminate)
  child.on("error", (error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  child.on("exit", (code, signal) => {
    process.off("SIGINT", onInterrupt)
    process.off("SIGTERM", onTerminate)
    process.exitCode =
      code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)
  })
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
