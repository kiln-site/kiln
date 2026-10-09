import { describe, expect, it } from "vite-plus/test"

import { commandLines } from "./command.js"

describe("command lines", () => {
  it("keeps characters whole when output splits them between chunks", async () => {
    // Writes the first byte of 界, then the rest once that has been read,
    // on both stdout and stderr.
    const script = `
      const [first, ...rest] = Buffer.from("界 done\\n")
      process.stdout.write(Buffer.from([first]))
      process.stderr.write(Buffer.from([first]))
      setTimeout(() => {
        process.stdout.write(Buffer.from(rest))
        process.stderr.write(Buffer.from(rest))
      }, 50)
    `
    const lines: Array<string> = []

    await commandLines(process.execPath, ["-e", script], (line) => {
      lines.push(line)
    })

    expect(lines).toEqual(["界 done", "界 done"])
  })
})
