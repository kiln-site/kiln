import { Result } from "effect"

/**
 * moby/patternmatcher, the matcher BuildKit filters a build context with
 * (`.dockerignore`, and a local source's include and exclude patterns),
 * ported so the Relay sends exactly the files the CLI sent.
 *
 * A pattern becomes a Go (RE2) regular expression the way patternmatcher
 * builds it, and that expression is then translated to a JavaScript one
 * with the same meaning. What has no JavaScript equivalent fails, as a
 * pattern Go couldn't compile does, instead of matching differently.
 */

/** A pattern Go rejects, as `filepath.ErrBadPattern` or a regexp error. */
export class BadPatternError extends Error {
  constructor(pattern: string, reason = "syntax error in pattern") {
    super(`Invalid pattern ${JSON.stringify(pattern)}: ${reason}`)
    this.name = "BadPatternError"
  }
}

/** For each pattern, whether a directory matched it, for its children. */
export type MatchInfo = ReadonlyArray<boolean>

type MatchType = "exact" | "prefix" | "regexp" | "suffix"

export class Pattern {
  readonly exclusion: boolean
  /** The cleaned pattern, without its `!`. */
  readonly text: string
  #type: MatchType | undefined
  #matcher: ((text: string) => boolean) | undefined

  constructor(text: string, exclusion: boolean) {
    this.text = text
    this.exclusion = exclusion
  }

  match(path: string): boolean {
    if (this.#type === undefined) this.#compile()
    switch (this.#type) {
      case "exact":
        return path === this.text
      case "prefix":
        return path.startsWith(this.text.slice(0, -2))
      case "suffix": {
        const suffix = this.text.slice(2)
        if (path.endsWith(suffix)) return true
        return suffix.startsWith("/") && path === suffix.slice(1)
      }
      default:
        return this.#matcher!(path)
    }
  }

  // patternmatcher's `compile`, building the same Go expression.
  #compile() {
    let source = "^"
    let type: MatchType = "exact"
    const characters = [...this.text]
    for (
      let index = 0, step = 0;
      index < characters.length;
      index += 1, step += 1
    ) {
      const character = characters[index]!
      if (character === "*") {
        if (characters[index + 1] === "*") {
          index += 1
          // `**/` is `**`.
          if (characters[index + 1] === "/") index += 1
          if (index + 1 >= characters.length) {
            if (type === "exact") type = "prefix"
            else {
              source += ".*"
              type = "regexp"
            }
          } else {
            source += "(.*/)?"
            type = "regexp"
          }
          if (step === 0) type = "suffix"
        } else {
          source += "[^/]*"
          type = "regexp"
        }
      } else if (character === "?") {
        source += "[^/]"
        type = "regexp"
      } else if (".+()|{}$".includes(character)) {
        source += `\\${character}`
      } else if (character === "\\") {
        const next = characters[index + 1]
        if (next === undefined) source += "\\"
        else {
          source += `\\${next}`
          index += 1
          type = "regexp"
        }
      } else if (character === "[" || character === "]") {
        source += character
        type = "regexp"
      } else {
        source += character
      }
    }
    if (type === "regexp") {
      const compiled = Result.try(() => compileGoRegex(`${source}$`))
      if (Result.isFailure(compiled)) {
        const cause = compiled.failure
        throw new BadPatternError(
          this.text,
          cause instanceof Error ? cause.message : String(cause)
        )
      }
      this.#matcher = compiled.success
    }
    this.#type = type
  }
}

export class PatternMatcher {
  readonly patterns: ReadonlyArray<Pattern>
  /** Whether any pattern is an exception (`!`). */
  readonly exclusions: boolean

  /** patternmatcher's `New`: throws on a pattern Go rejects. */
  constructor(patterns: ReadonlyArray<string>) {
    const compiled: Array<Pattern> = []
    let exclusions = false
    for (const raw of patterns) {
      let pattern = goTrimSpace(raw)
      if (pattern === "") continue
      pattern = cleanPath(pattern)
      let exclusion = false
      if (pattern.startsWith("!")) {
        if (pattern.length === 1) {
          throw new BadPatternError(pattern, 'illegal exclusion pattern: "!"')
        }
        exclusion = true
        exclusions = true
        pattern = pattern.slice(1)
      }
      checkMatchSyntax(pattern)
      compiled.push(new Pattern(pattern, exclusion))
    }
    this.patterns = compiled
    this.exclusions = exclusions
  }

  /**
   * Whether `file` (slash-separated) or one of its parent directories
   * matches, and no later exception matches it.
   */
  matchesOrParentMatches(file: string): boolean {
    let matched = false
    const parent = parentPath(file)
    const parents = parent === "." ? [] : parent.split("/")
    for (const pattern of this.patterns) {
      if (pattern.exclusion !== matched) continue
      let match = pattern.match(file)
      for (let depth = 1; !match && depth <= parents.length; depth += 1) {
        match = pattern.match(parents.slice(0, depth).join("/"))
      }
      if (match) matched = !pattern.exclusion
    }
    return matched
  }

  /**
   * `matchesOrParentMatches`, reusing what `file`'s parent directory
   * matched (from its own call) instead of matching each parent again.
   */
  matchesUsingParentResults(
    file: string,
    parent: MatchInfo | undefined
  ): readonly [boolean, MatchInfo] {
    if (parent && parent.length !== this.patterns.length) {
      throw new Error("wrong number of values in parentMatched")
    }
    let matched = false
    const info: Array<boolean> = []
    for (const [index, pattern] of this.patterns.entries()) {
      let match = parent?.[index] ?? false
      if (!match) {
        if (pattern.exclusion !== matched) {
          info.push(false)
          continue
        }
        match = pattern.match(file)
        if (!match && !parent?.length) {
          const directory = parentPath(file)
          if (directory !== ".") {
            const parents = directory.split("/")
            for (let depth = 1; !match && depth <= parents.length; depth += 1) {
              match = pattern.match(parents.slice(0, depth).join("/"))
            }
          }
        }
      }
      info.push(match)
      if (match) matched = !pattern.exclusion
    }
    return [matched, info]
  }
}

/** Go's `path.Clean`. */
export function cleanPath(path: string): string {
  if (path === "") return "."
  const rooted = path.startsWith("/")
  const parts: Array<string> = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (parts.length > 0 && parts.at(-1) !== "..") parts.pop()
      else if (!rooted) parts.push("..")
      continue
    }
    parts.push(part)
  }
  const cleaned = parts.join("/")
  if (rooted) return `/${cleaned}`
  return cleaned || "."
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/")
  if (index === -1) return "."
  return cleanPath(path.slice(0, index) || "/")
}

// Go's `strings.TrimSpace`: Unicode white space, which (unlike String's
// `trim`) doesn't include the byte order mark.
function goTrimSpace(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && GO_SPACE.has(value.charCodeAt(start))) start += 1
  while (end > start && GO_SPACE.has(value.charCodeAt(end - 1))) end -= 1
  return value.slice(start, end)
}

const GO_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
])

/**
 * The syntax `filepath.Match` accepts, which `New` checks every pattern
 * against: character classes must close and hold valid ranges, and a `\`
 * must escape something.
 */
function checkMatchSyntax(pattern: string) {
  const characters = [...pattern]
  const bad = () => new BadPatternError(pattern)
  let index = 0
  // A class's character, with its escape: undefined when it can't start a
  // range (or the pattern ends after it), as Go's `getEsc`.
  const classCharacter = () => {
    let character = characters[index]
    if (character === undefined || character === "-" || character === "]") {
      throw bad()
    }
    if (character === "\\") {
      index += 1
      character = characters[index]
      if (character === undefined) throw bad()
    }
    index += 1
    if (index >= characters.length) throw bad()
    return character.codePointAt(0)!
  }
  while (index < characters.length) {
    const character = characters[index]!
    if (character === "[") {
      index += 1
      if (characters[index] === "^") index += 1
      let ranges = 0
      for (;;) {
        if (characters[index] === "]" && ranges > 0) {
          index += 1
          break
        }
        classCharacter()
        if (characters[index] === "-") {
          index += 1
          classCharacter()
        }
        ranges += 1
      }
    } else if (character === "\\") {
      index += 1
      if (index >= characters.length) throw bad()
      index += 1
    } else {
      index += 1
    }
  }
}

// ------------------------------------------------- Go regexp to JavaScript

const POSIX_CLASSES: Record<string, string> = {
  alnum: "0-9A-Za-z",
  alpha: "A-Za-z",
  ascii: "\\0-\\x7f",
  blank: "\\t ",
  cntrl: "\\0-\\x1f\\x7f",
  digit: "0-9",
  graph: "!-~",
  lower: "a-z",
  print: " -~",
  punct: "!-\\/:-@\\[-`{-~",
  space: "\\t\\n\\v\\f\\r ",
  upper: "A-Z",
  word: "0-9A-Za-z_",
  xdigit: "0-9A-Fa-f",
}

// Perl classes as RE2 defines them (ASCII), and their complements, for use
// inside a class.
const PERL_CLASSES: Record<string, string> = {
  D: "\\0-\\/:-\\u{10ffff}",
  S: "\\0-\\x08\\x0b\\x0e-\\x1f!-\\u{10ffff}",
  W: "\\0-\\/:-@\\[-\\^`{-\\u{10ffff}",
  d: "0-9",
  s: "\\t\\n\\f\\r ",
  w: "0-9A-Za-z_",
}

const SYNTAX = new Set("^$\\.*+?()[]{}|/")

// The parts of a Go regular expression: characters (each a test of one
// code point), assertions, groups, and repetitions.
type Token =
  | {
      readonly kind: "assert"
      readonly test: (text: ReadonlyArray<number>, at: number) => boolean
    }
  | { readonly kind: "char"; readonly test: (character: number) => boolean }
  | { readonly kind: "close" }
  | { readonly kind: "open" }
  | { readonly kind: "repeat"; readonly operator: "*" | "+" | "?" }

/**
 * Compiles the Go regular expression patternmatcher built into a matcher
 * that runs in time linear in the text, as RE2 does: a Thompson NFA run as
 * a Pike VM, so no pattern makes matching backtrack. RE2's escapes, Perl
 * and POSIX classes, and class syntax keep their meaning; each class is a
 * test of a single character.
 */
function compileGoRegex(source: string): (text: string) => boolean {
  return runner(parseTokens(tokenize(source)))
}

function tokenize(source: string): Array<Token> {
  const characters = [...source]
  let index = 0
  const tokens: Array<Token> = []
  const output = {
    // A character test from a JavaScript class, run on one character.
    klass(pattern: string) {
      const compiled = new RegExp(`^${pattern}$`, "u")
      tokens.push({
        kind: "char",
        test: (value) => compiled.test(String.fromCodePoint(value)),
      })
    },
    literal(value: number) {
      tokens.push({ kind: "char", test: (character) => character === value })
    },
  }
  const fail = (reason: string): never => {
    throw new Error(reason)
  }
  // Where `first` then `second` next appear, from `from`.
  const find = (first: string, second: string, from: number) => {
    for (let at = from; at < characters.length - 1; at += 1) {
      if (characters[at] === first && characters[at + 1] === second) return at
    }
    return -1
  }
  const classLiteral = (value: number) => {
    const character = String.fromCodePoint(value)
    if (value < 0x20 || value === 0x7f) return `\\u{${value.toString(16)}}`
    return SYNTAX.has(character) || character === "-"
      ? `\\${character}`
      : character
  }

  // `\pL`, `\p{Greek}`, `\P{...}`, or `\p{^...}`, after the `p` or `P`.
  const unicodeClass = (negated: boolean): string => {
    let name: string
    if (characters[index] === "{") {
      const end = characters.indexOf("}", index)
      if (end === -1) return fail("invalid character class range")
      name = characters.slice(index + 1, end).join("")
      index = end + 1
    } else {
      const next = characters[index]
      if (next === undefined) return fail("invalid character class range")
      name = next
      index += 1
    }
    if (name.startsWith("^")) {
      negated = !negated
      name = name.slice(1)
    }
    if (name === "Any") return negated ? "" : "\\0-\\u{10ffff}"
    for (const property of [name, `Script=${name}`]) {
      const valid = Result.try(() => new RegExp(`\\p{${property}}`, "u"))
      if (Result.isSuccess(valid)) {
        return `${negated ? "\\P" : "\\p"}{${property}}`
      }
    }
    return fail("invalid character class range")
  }

  // An escape, after its `\`: one character, or a class's ranges.
  const escape = ():
    | { readonly character: number }
    | { readonly ranges: string } => {
    const character = characters[index]
    if (character === undefined) {
      return fail("trailing backslash at end of expression")
    }
    index += 1
    const perl = PERL_CLASSES[character]
    if (perl !== undefined) return { ranges: perl }
    if (character === "p" || character === "P") {
      return { ranges: unicodeClass(character === "P") }
    }
    if (character >= "0" && character <= "7") {
      // A lone `\1` to `\7` is a backreference, which RE2 doesn't have.
      const next = characters[index]
      if (
        character !== "0" &&
        (next === undefined || next < "0" || next > "7")
      ) {
        return fail(`invalid escape sequence: \\${character}`)
      }
      let digits = character
      for (let count = 0; count < 2; count += 1) {
        const following = characters[index]
        if (following === undefined || following < "0" || following > "7") {
          break
        }
        digits += following
        index += 1
      }
      return { character: Number.parseInt(digits, 8) }
    }
    if (character === "x") {
      let hex = ""
      if (characters[index] === "{") {
        const end = characters.indexOf("}", index)
        if (end !== -1) hex = characters.slice(index + 1, end).join("")
        index = end === -1 ? characters.length : end + 1
      } else {
        hex = characters.slice(index, index + 2).join("")
        index += 2
        if (hex.length !== 2) hex = ""
      }
      const value = /^[0-9a-f]+$/iu.test(hex)
        ? Number.parseInt(hex, 16)
        : Number.NaN
      if (!(value <= 0x10ffff)) return fail("invalid escape sequence: \\x")
      return { character: value }
    }
    const control = CONTROL_ESCAPES[character]
    if (control !== undefined) return { character: control }
    const value = character.codePointAt(0)!
    // Punctuation escapes to itself.
    if (value < 0x80 && !/[0-9A-Za-z]/u.test(character)) {
      return { character: value }
    }
    return fail(`invalid escape sequence: \\${character}`)
  }

  // RE2's character class, after its `[`.
  const characterClass = () => {
    let negated = false
    if (characters[index] === "^") {
      negated = true
      index += 1
    }
    let body = ""
    // A `]` right after `[` or `[^` is a literal.
    let first = true
    for (;;) {
      const current = characters[index]
      if (current === undefined) return fail("missing closing ]")
      if (current === "]" && !first) {
        index += 1
        break
      }
      first = false
      if (current === "[" && characters[index + 1] === ":") {
        const end = find(":", "]", index + 2)
        // `[:` without `:]` is a literal `[`.
        if (end !== -1) {
          const name = characters.slice(index + 2, end).join("")
          const ranges = POSIX_CLASSES[name]
          if (ranges === undefined) {
            return fail(`invalid character class range: [:${name}:]`)
          }
          body += ranges
          index = end + 2
          continue
        }
      }
      let low: number
      if (current === "\\") {
        index += 1
        const escaped = escape()
        if ("ranges" in escaped) {
          if (escaped.ranges === "") return fail("empty character class")
          body += escaped.ranges
          continue
        }
        low = escaped.character
      } else {
        low = current.codePointAt(0)!
        index += 1
      }
      let high = low
      // `[a-]` is `a` or `-`.
      if (characters[index] === "-" && (characters[index + 1] ?? "]") !== "]") {
        index += 1
        const next = characters[index]!
        if (next === "\\") {
          index += 1
          const escaped = escape()
          if ("ranges" in escaped) return fail("invalid character class range")
          high = escaped.character
        } else {
          high = next.codePointAt(0)!
          index += 1
        }
        if (high < low) return fail("invalid character class range")
      }
      body +=
        low === high
          ? classLiteral(low)
          : `${classLiteral(low)}-${classLiteral(high)}`
    }
    return `[${negated ? "^" : ""}${body}]`
  }

  const begin = (_: ReadonlyArray<number>, at: number) => at === 0
  const end = (text: ReadonlyArray<number>, at: number) => at === text.length
  const isWord = (value: number | undefined) =>
    value !== undefined && /^[0-9A-Za-z_]$/u.test(String.fromCodePoint(value))
  const boundary = (text: ReadonlyArray<number>, at: number) =>
    isWord(text[at - 1]) !== isWord(text[at])
  while (index < characters.length) {
    const character = characters[index]!
    index += 1
    if (character === "\\") {
      const next = characters[index]
      if (next === "A") {
        index += 1
        tokens.push({ kind: "assert", test: begin })
      } else if (next === "z") {
        index += 1
        tokens.push({ kind: "assert", test: end })
      } else if (next === "b" || next === "B") {
        index += 1
        tokens.push({
          kind: "assert",
          test: next === "b" ? boundary : (text, at) => !boundary(text, at),
        })
      } else if (next === "Q") {
        // Literal text up to `\E`.
        const close = find("\\", "E", index + 1)
        const text = characters.slice(
          index + 1,
          close === -1 ? undefined : close
        )
        for (const quoted of text) output.literal(quoted.codePointAt(0)!)
        index = close === -1 ? characters.length : close + 2
      } else if (next === "C") {
        return fail("invalid escape sequence: \\C")
      } else {
        const escaped = escape()
        if ("ranges" in escaped) {
          output.klass(
            escaped.ranges === "" ? "[^\\0-\\u{10ffff}]" : `[${escaped.ranges}]`
          )
        } else {
          output.literal(escaped.character)
        }
      }
    } else if (character === "[") {
      output.klass(characterClass())
    } else if (character === ".") {
      // RE2's `.` matches anything but a newline.
      tokens.push({ kind: "char", test: (value) => value !== 10 })
    } else if (character === "^") {
      tokens.push({ kind: "assert", test: begin })
    } else if (character === "$") {
      tokens.push({ kind: "assert", test: end })
    } else if (character === "(") {
      tokens.push({ kind: "open" })
    } else if (character === ")") {
      tokens.push({ kind: "close" })
    } else if (character === "*" || character === "+" || character === "?") {
      tokens.push({ kind: "repeat", operator: character })
    } else {
      output.literal(character.codePointAt(0)!)
    }
  }
  return tokens
}

type Node =
  | {
      readonly kind: "assert"
      readonly test: (text: ReadonlyArray<number>, at: number) => boolean
    }
  | { readonly kind: "char"; readonly test: (character: number) => boolean }
  | {
      readonly kind: "repeat"
      readonly node: Node
      readonly operator: "*" | "+" | "?"
    }
  | { readonly kind: "sequence"; readonly nodes: ReadonlyArray<Node> }

function parseTokens(tokens: ReadonlyArray<Token>): Node {
  let index = 0
  const sequence = (): Node => {
    const nodes: Array<Node> = []
    while (index < tokens.length && tokens[index]!.kind !== "close") {
      const token = tokens[index]!
      index += 1
      let node: Node
      if (token.kind === "open") {
        node = sequence()
        if (tokens[index]?.kind !== "close")
          throw new Error("missing closing )")
        index += 1
      } else if (token.kind === "repeat") {
        throw new Error(
          `missing argument to repetition operator: ${token.operator}`
        )
      } else if (token.kind === "close") {
        throw new Error("unexpected )")
      } else {
        node = token
      }
      while (tokens[index]?.kind === "repeat") {
        const repeat = tokens[index] as Extract<Token, { kind: "repeat" }>
        node = { kind: "repeat", node, operator: repeat.operator }
        index += 1
      }
      nodes.push(node)
    }
    return { kind: "sequence", nodes }
  }
  const root = sequence()
  if (index !== tokens.length) throw new Error("unexpected )")
  return root
}

type Instruction =
  | {
      op: "assert"
      test: (text: ReadonlyArray<number>, at: number) => boolean
      next: number
    }
  | { op: "char"; test: (character: number) => boolean; next: number }
  | { op: "match" }
  | { op: "split"; first: number; second: number }

// A Pike VM: every thread advances one character at a time, and threads at
// the same instruction merge, so a match takes time linear in the text.
function runner(root: Node): (text: string) => boolean {
  const program: Array<Instruction> = []
  const emit = (instruction: Instruction) => program.push(instruction) - 1
  // Compiles a node whose end continues at whatever's emitted next.
  const compile = (node: Node): void => {
    switch (node.kind) {
      case "sequence":
        for (const part of node.nodes) compile(part)
        return
      case "char":
        emit({ next: program.length + 1, op: "char", test: node.test })
        return
      case "assert":
        emit({ next: program.length + 1, op: "assert", test: node.test })
        return
      case "repeat": {
        if (node.operator === "+") {
          const start = program.length
          compile(node.node)
          emit({ first: start, op: "split", second: program.length + 1 })
          return
        }
        const split = emit({
          first: program.length + 1,
          op: "split",
          second: 0,
        })
        compile(node.node)
        if (node.operator === "*") {
          emit({ first: split, op: "split", second: program.length + 1 })
        }
        ;(program[split] as Extract<Instruction, { op: "split" }>).second =
          program.length
        return
      }
    }
  }
  compile(root)
  emit({ op: "match" })
  return (input) => {
    const text = [...input].map((character) => character.codePointAt(0)!)
    let current: Array<number> = []
    const seen = new Int32Array(program.length).fill(-1)
    let generation = 0
    // Follows splits and assertions from `pc` at `at`, collecting the
    // instructions that read a character (and reporting a match).
    const add = (list: Array<number>, start: number, at: number): boolean => {
      const stack = [start]
      let matched = false
      while (stack.length > 0) {
        const pc = stack.pop()!
        if (seen[pc] === generation) continue
        seen[pc] = generation
        const instruction = program[pc]!
        if (instruction.op === "match") matched = true
        else if (instruction.op === "char") list.push(pc)
        else if (instruction.op === "assert") {
          if (instruction.test(text, at)) stack.push(instruction.next)
        } else stack.push(instruction.second, instruction.first)
      }
      return matched
    }
    for (let at = 0; ; at += 1) {
      // A search, as Go's MatchString: a thread may start anywhere.
      if (add(current, 0, at)) return true
      if (at === text.length) return false
      const next: Array<number> = []
      generation += 1
      for (const pc of current) {
        const instruction = program[pc] as Extract<Instruction, { op: "char" }>
        if (
          instruction.test(text[at]!) &&
          add(next, instruction.next, at + 1)
        ) {
          return true
        }
      }
      current = next
    }
  }
}

const CONTROL_ESCAPES: Record<string, number> = {
  a: 7,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
}
