import { describe, expect, it } from "vite-plus/test"

import { matchingReadyLogLine, parseConsoleOutput } from "./console-parsing.js"

// What Docker returns for a Forge server's TTY once its console prompt is
// up: each line redraws the `> ` prompt around it.
const escape = String.fromCodePoint(27)
const forgeLine = (time: string, text: string) =>
  `2026-11-20T${time}.240971034Z ${escape}[m> \r${escape}[K${escape}[32m[${time}] [Server thread/INFO] [minecraft/DedicatedServer]: ${text}\r`

describe("console output", () => {
  // Every line Forge wrote after its prompt came up was dropped as a prompt
  // redraw, so its console showed nothing and its readiness never matched.
  it("keeps a Forge server's lines once its prompt is up", () => {
    const lines = parseConsoleOutput({
      stdout: [
        forgeLine("02:36:24", 'Preparing level "world"'),
        `2026-11-20T02:36:25.000000000Z ${escape}[m> say hi\r\r`,
        forgeLine("02:36:28", 'Done (4.261s)! For help, type "help"'),
      ].join("\n"),
      stderr: "",
    })

    expect(lines.map((line) => line.text)).toEqual([
      '[02:36:24] [Server thread/INFO] [minecraft/DedicatedServer]: Preparing level "world"',
      '[02:36:28] [Server thread/INFO] [minecraft/DedicatedServer]: Done (4.261s)! For help, type "help"',
    ])
    expect(matchingReadyLogLine(lines, [")! For help, type "])?.timestamp).toBe(
      "2026-11-20T02:36:28.240971034Z"
    )
  })
})
