import { Effect } from "effect"

import { commandError } from "./errors.js"

/**
 * Asks for the account password on the terminal without echoing it, as a
 * deletion's confirmation needs. Ctrl-C cancels.
 */
export const promptPasswordEffect = Effect.fn("cli.password.prompt")(function* (
  question: string
) {
  return yield* Effect.callback<string, ReturnType<typeof commandError>>(
    (resume) => {
      const input = process.stdin
      let value = ""
      const finish = () => {
        input.setRawMode(false)
        input.pause()
        input.off("data", onData)
        process.stderr.write("\n")
      }
      const onData = (chunk: string) => {
        for (const character of chunk) {
          if (
            character === "\r" ||
            character === "\n" ||
            character === "\u0004"
          ) {
            finish()
            resume(Effect.succeed(value))
            return
          }
          if (character === "\u0003") {
            finish()
            resume(
              Effect.fail(
                commandError({
                  code: "cancelled",
                  exitCode: 130,
                  message: "Cancelled.",
                })
              )
            )
            return
          }
          if (character === "\u007f" || character === "\b") {
            value = value.slice(0, -1)
          } else {
            value += character
          }
        }
      }
      process.stderr.write(question)
      input.setEncoding("utf8")
      input.setRawMode(true)
      input.resume()
      input.on("data", onData)
      return Effect.sync(() => {
        if (input.isRaw) finish()
      })
    }
  )
})
