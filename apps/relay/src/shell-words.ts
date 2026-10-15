/**
 * Splits a command line the way a shell would, without running one, so it
 * works in images that have no shell: whitespace separates words, single
 * quotes are literal, and double quotes and backslashes escape.
 */
export function shellWords(
  input: string,
  // What the words are, for the error an unclosed quote fails with.
  subject = "The start command"
): Array<string> {
  const words: Array<string> = []
  let current = ""
  let started = false
  let quote: '"' | "'" | null = null
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!
    if (quote) {
      if (character === quote) quote = null
      else if (
        character === "\\" &&
        quote === '"' &&
        index + 1 < input.length
      ) {
        current += input[++index]
      } else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      started = true
    } else if (character === "\\" && index + 1 < input.length) {
      current += input[++index]
      started = true
    } else if (/\s/u.test(character)) {
      if (started) words.push(current)
      current = ""
      started = false
    } else {
      current += character
      started = true
    }
  }
  if (quote) throw new Error(`${subject} has an unclosed quote`)
  if (started) words.push(current)
  return words
}
