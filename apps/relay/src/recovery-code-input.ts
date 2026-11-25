/**
 * Kiln's recovery code from standard input: typed at a terminal without
 * showing it, or the first line of what's piped in.
 */
export async function readRecoveryCode(): Promise<string> {
  const input = process.stdin
  if (!input.isTTY) {
    let text = ""
    for await (const chunk of input) {
      text += String(chunk)
      if (text.includes("\n")) break
    }
    return text.split("\n")[0]?.trim() ?? ""
  }
  process.stderr.write("Recovery code: ")
  input.setRawMode(true)
  input.resume()
  return new Promise((resolveCode, rejectCode) => {
    let typed = ""
    const finish = (error: Error | null) => {
      input.off("data", onData)
      input.setRawMode(false)
      input.pause()
      process.stderr.write("\n")
      if (error) rejectCode(error)
      else resolveCode(typed.trim())
    }
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") return finish(null)
        if (character === "\u0003") return finish(new Error("Cancelled"))
        if (character === "\u007f") typed = typed.slice(0, -1)
        else typed += character
      }
    }
    input.on("data", onData)
  })
}
