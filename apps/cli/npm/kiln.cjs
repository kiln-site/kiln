#!/usr/bin/env node
const { spawn } = require("node:child_process")
const { installBinary } = require("./install.cjs")

try {
  const child = spawn(installBinary(), process.argv.slice(2), {
    stdio: "inherit",
  })
  const forward = (signal) => child.kill(signal)
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
