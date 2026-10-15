/**
 * Splits a Compose `command` or `entrypoint` string into words as Compose
 * does, a port of mattn/go-shellwords v1.0.14 `Parse` with environment,
 * backtick, and comment parsing off. Parsing stops at `;`, `&`, `|`, `<`, or
 * `>` outside quotes, and `$(...)` and backticks are kept as written.
 */
export function shellWords(
  input: string,
  // What the words are, for the error an invalid line fails with.
  subject: string
): Array<string> {
  const invalid = () => new Error(`${subject} is not a valid command line`)
  const args: Array<string> = []
  let buffer = ""
  let escaped = false
  let doubleQuoted = false
  let singleQuoted = false
  let backQuote = false
  let dollarQuote = false
  // 0: no word, 1: a word, 2: a quoted (possibly empty) word.
  let got = 0
  const flush = () => {
    if (got === 2 || (got !== 0 && buffer.length > 0)) args.push(buffer)
    buffer = ""
    got = 0
  }
  loop: for (const character of input) {
    if (escaped) {
      escaped = false
      if (backQuote || dollarQuote) buffer += `\\${character}`
      else if (character === "t") buffer += "\t"
      else if (character === "n") buffer += "\n"
      else buffer += character
      got = 1
      continue
    }
    if (character === "\\") {
      if (singleQuoted) buffer += "\\"
      else escaped = true
      continue
    }
    if (
      character === " " ||
      character === "\t" ||
      character === "\r" ||
      character === "\n"
    ) {
      if (singleQuoted || doubleQuoted || backQuote || dollarQuote) {
        buffer += character
      } else flush()
      continue
    }
    switch (character) {
      case "`":
        if (!singleQuoted && !doubleQuoted && !dollarQuote) {
          backQuote = !backQuote
        }
        break
      case ")":
        if (!singleQuoted && !doubleQuoted && !backQuote) {
          if (!dollarQuote) throw invalid()
          buffer += ")"
          dollarQuote = false
          got = 1
          continue
        }
        break
      case "(":
        if (!singleQuoted && !doubleQuoted && !backQuote) {
          if (
            !dollarQuote &&
            buffer.endsWith("$") &&
            !buffer.endsWith("\\$")
          ) {
            dollarQuote = true
            buffer += "("
            continue
          }
          throw invalid()
        }
        break
      case '"':
        if (!singleQuoted && !dollarQuote && !backQuote) {
          if (doubleQuoted) got = 2
          doubleQuoted = !doubleQuoted
          continue
        }
        break
      case "'":
        if (!doubleQuoted && !dollarQuote && !backQuote) {
          if (singleQuoted) got = 2
          singleQuoted = !singleQuoted
          continue
        }
        break
      case ";":
      case "&":
      case "|":
      case "<":
      case ">":
        if (!(singleQuoted || doubleQuoted || backQuote || dollarQuote)) {
          // `2>file`: the digits are the redirect's, not a word.
          if (character === ">" && /^[0-9]+$/u.test(buffer)) got = 0
          break loop
        }
        break
    }
    got = 1
    buffer += character
  }
  flush()
  if (escaped || singleQuoted || doubleQuoted || backQuote || dollarQuote) {
    throw invalid()
  }
  return args
}
