import { Result } from "effect"
import { RE2JS } from "re2js"

import { complement, goUnicodeRanges } from "./go-unicode.js"

/**
 * moby/patternmatcher (v0.6.1), the matcher BuildKit filters a build
 * context with (`.dockerignore`, and a local source's include and exclude
 * patterns), ported so the Relay sends exactly the files the CLI sent.
 *
 * A pattern becomes the Go regular expression patternmatcher builds from
 * it, character for character, run by RE2JS, a port of RE2: the syntax and
 * linear-time matching of Go's regexp package.
 */

/** A pattern Go rejects, as `filepath.ErrBadPattern` or a regexp error. */
export class BadPatternError extends Error {
  constructor(pattern: string, reason = "syntax error in pattern") {
    const shown = pattern.length > 100 ? `${pattern.slice(0, 100)}…` : pattern
    super(`Invalid pattern ${JSON.stringify(shown)}: ${reason}`)
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
  #regexp: RE2JS | undefined
  readonly #budget: CompileBudget

  constructor(text: string, exclusion: boolean, budget: CompileBudget) {
    this.text = text
    this.exclusion = exclusion
    this.#budget = budget
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
        return this.#regexp!.test(path)
    }
  }

  // patternmatcher's `compile`, building the same Go regular expression,
  // character by character as Go's text/scanner reads the pattern (which
  // skips a leading byte order mark).
  #compile() {
    let source = "^"
    let type: MatchType = "exact"
    const characters = [...this.text]
    let next = characters[0] === "﻿" ? 1 : 0
    const peek = () => characters[next]
    for (let index = 0; next < characters.length; index += 1) {
      const character = characters[next++]!
      if (character === "*") {
        if (peek() === "*") {
          next += 1
          // `**/` is `**`.
          if (peek() === "/") next += 1
          if (peek() === undefined) {
            if (type === "exact") type = "prefix"
            else {
              source += ".*"
              type = "regexp"
            }
          } else {
            source += "(.*/)?"
            type = "regexp"
          }
          if (index === 0) type = "suffix"
        } else {
          source += "[^/]*"
          type = "regexp"
        }
      } else if (character === "?") {
        source += "[^/]"
        type = "regexp"
      } else if (shouldEscape(character.codePointAt(0)!)) {
        source += `\\${character}`
      } else if (character === "\\") {
        if (peek() === undefined) source += "\\"
        else {
          source += `\\${characters[next++]}`
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
      const go = goRegexp(`${source}$`, this.text)
      if (go.size > MAX_PATTERN_SIZE) {
        throw new BadPatternError(
          this.text,
          `its regular expression is ${go.size} instructions; Kiln compiles up to ${MAX_PATTERN_SIZE}`
        )
      }
      this.#budget.used += go.size
      this.#budget.ranges += go.ranges
      if (this.#budget.ranges > MAX_TOTAL_RANGES) {
        throw new BadPatternError(
          this.text,
          `the build's patterns' Unicode classes come to more than ${MAX_TOTAL_RANGES} ranges, which Kiln compiles at most`
        )
      }
      if (this.#budget.used > MAX_TOTAL_SIZE) {
        throw new BadPatternError(
          this.text,
          `the build's patterns come to more than ${MAX_TOTAL_SIZE} regular expression instructions, which Kiln compiles at most`
        )
      }
      // RE2's syntax and linear-time matching, as Go's regexp package.
      const compiled = Result.try({
        try: () => RE2JS.compile(go.source),
        catch: (cause) =>
          new BadPatternError(
            this.text,
            cause instanceof Error ? cause.message : String(cause)
          ),
      })
      if (Result.isFailure(compiled)) throw compiled.failure
      this.#regexp = compiled.success
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
    const budget: CompileBudget = { ranges: 0, used: 0 }
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
      compiled.push(new Pattern(pattern, exclusion, budget))
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
    const prefixes = parentPrefixes(parents)
    for (const pattern of this.patterns) {
      if (pattern.exclusion !== matched) continue
      let match = pattern.match(file)
      for (const prefix of prefixes) {
        if (match) break
        match = pattern.match(prefix)
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
            for (const prefix of parentPrefixes(directory.split("/"))) {
              if (match) break
              match = pattern.match(prefix)
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

// `a`, `a/b`, `a/b/c` for `a`, `b`, `c`.
function parentPrefixes(parents: ReadonlyArray<string>): Array<string> {
  const prefixes: Array<string> = []
  let prefix = ""
  for (const part of parents) {
    prefix = prefix ? `${prefix}/${part}` : part
    prefixes.push(prefix)
  }
  return prefixes
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

/**
 * patternmatcher's `shouldEscape`: a bitmap of `.+()|{}$` whose bits past
 * the eighth are lost when it's built, so only `.+()$` are escaped, and
 * `|`, `{`, and `}` keep their meaning in the regular expression.
 */
const ESCAPE_BYTES = (() => {
  const bytes = new Uint8Array(8)
  for (const character of ".+()|{}$") {
    const code = character.charCodeAt(0)
    bytes[code % 8]! |= (1 << Math.floor(code / 8)) & 0xff
  }
  return bytes
})()

function shouldEscape(code: number): boolean {
  return code < 0x80 && (ESCAPE_BYTES[code % 8]! & (1 << Math.floor(code / 8))) !== 0
}

// ------------------------------------------------ Go's regexp, for RE2JS

// How large a pattern's regular expression may get, in Go's own measure
// (instructions, with counted repeats multiplied out), alone and with the
// other patterns of a build. RE2JS holds a few hundred bytes per
// instruction; Go's own limit (3,355,443) is far past what memory allows.
const MAX_PATTERN_SIZE = 20_000
const MAX_TOTAL_SIZE = 100_000
// And how many code point ranges Unicode properties may add, all told:
// `\p{L}` alone is about 650.
const MAX_TOTAL_RANGES = 50_000

/** What a matcher's patterns have compiled so far. */
interface CompileBudget {
  /** Instructions. */
  used: number
  /** Code point ranges from Unicode properties. */
  ranges: number
}

/**
 * The regular expression patternmatcher built, as RE2JS should read it to
 * mean what Go's regexp (in Go 1.26, which Docker 29 is built with) does,
 * and its size by Go's measure. Where RE2JS's syntax differs from Go's:
 * Unicode property names are looked up as Go looks them up (Go's Unicode
 * 15 tables, its case- and underscore-insensitive names and aliases, and
 * `Any`, `Assigned`, and `ASCII`) and rewritten to names RE2JS knows, or
 * fail as Go fails; capture names, which Go lets repeat, are dropped. One
 * pass, with no recursion, whatever the nesting.
 */
function goRegexp(
  source: string,
  pattern: string
): {
  readonly ranges: number
  readonly source: string
  readonly size: number
} {
  const characters = [...source]
  let output = ""
  // Each open group: what its finished alternatives and the current one
  // add up to, the last atom's size (for a repeat), and whether it
  // captures.
  const frames = [{ capture: false, current: 0, done: 0, last: 0 }]
  const atom = (size: number) => {
    const frame = frames.at(-1)!
    frame.current += size
    frame.last = size
  }
  const repeated = (size: number) => {
    const frame = frames.at(-1)!
    frame.current += size - frame.last
    frame.last = size
  }
  let index = 0
  // An escape at `index` (a `\`), copied or rewritten.
  const escape = (inClass: boolean) => {
    const next = characters[index + 1]
    if ((next === "p" || next === "P") && index + 2 < characters.length) {
      let name: string
      let end: number
      if (characters[index + 2] === "{") {
        const close = characters.indexOf("}", index + 3)
        if (close === -1) {
          output += characters.slice(index).join("")
          index = characters.length
          return
        }
        name = characters.slice(index + 3, close).join("")
        end = close + 1
      } else {
        name = characters[index + 2] ?? ""
        end = index + 3
      }
      let negated = next === "P"
      if (name.startsWith("^")) {
        negated = !negated
        name = name.slice(1)
      }
      output += unicodeProperty(name, negated, inClass, () =>
        characters.slice(index, end).join("")
      )
      index = end
      return
    }
    if (next === "x" && characters[index + 2] === "{") {
      const close = characters.indexOf("}", index + 3)
      const end = close === -1 ? characters.length : close + 1
      output += characters.slice(index, end).join("")
      index = end
      return
    }
    output += characters.slice(index, index + 2).join("")
    index += 2
  }
  // A property as the code point ranges Go's tables give it, which RE2JS
  // reads the same whatever its own tables say.
  let ranges = 0
  const unicodeProperty = (
    name: string,
    negated: boolean,
    inClass: boolean,
    written: () => string
  ): string => {
    const table = goUnicodeRanges(goCanonicalName(name))
    if (table === undefined) {
      throw new BadPatternError(
        pattern,
        `error parsing regexp: invalid character class range: \`${written()}\``
      )
    }
    const set = negated ? complement(table) : table
    ranges += set.length / 2
    let text = ""
    for (let at = 0; at + 1 < set.length; at += 2) {
      text +=
        set[at] === set[at + 1]
          ? `\\x{${set[at]!.toString(16)}}`
          : `\\x{${set[at]!.toString(16)}}-\\x{${set[at + 1]!.toString(16)}}`
    }
    return inClass ? text : text ? `[${text}]` : NOTHING
  }
  while (index < characters.length) {
    const character = characters[index]!
    if (character === "\\" && characters[index + 1] === "Q") {
      // Literal text up to `\E`.
      const start = index
      index += 2
      while (
        index < characters.length &&
        !(characters[index] === "\\" && characters[index + 1] === "E")
      ) {
        atom(1)
        index += 1
      }
      index = Math.min(index + 2, characters.length)
      output += characters.slice(start, index).join("")
    } else if (character === "\\") {
      escape(false)
      atom(1)
    } else if (character === "[") {
      // A class, to its closing `]`: a `]` first is literal, and
      // `[:name:]` is a POSIX class.
      const opening = output.length
      output += "["
      index += 1
      const negatedClass = characters[index] === "^"
      if (negatedClass) {
        output += "^"
        index += 1
      }
      const contents = output.length
      let first = true
      while (index < characters.length) {
        const inside = characters[index]!
        if (inside === "]" && !first) break
        first = false
        if (inside === "\\") {
          escape(true)
        } else if (inside === "[" && characters[index + 1] === ":") {
          const close = characters.indexOf("]", index + 2)
          const end = close === -1 ? characters.length : close + 1
          output += characters.slice(index, end).join("")
          index = end
        } else {
          output += inside
          index += 1
        }
      }
      if (index < characters.length) {
        index += 1
        if (output.length === contents) {
          output = output.slice(0, opening) + (negatedClass ? ANYTHING : NOTHING)
        } else output += "]"
      }
      atom(1)
    } else if (character === "(") {
      let capture = true
      if (characters[index + 1] === "?") {
        const named =
          characters[index + 2] === "P" && characters[index + 3] === "<"
            ? 4
            : characters[index + 2] === "<"
              ? 3
              : 0
        const close = named ? characters.indexOf(">", index + named) : -1
        if (
          named &&
          close !== -1 &&
          /^\w+$/u.test(characters.slice(index + named, close).join(""))
        ) {
          // A capture name Go accepts, dropped.
          output += "("
          index = close + 1
        } else if (named) {
          // Anything else as written, which RE2JS rejects as Go does.
          const end = close === -1 ? characters.length : close + 1
          output += characters.slice(index, end).join("")
          index = end
        } else {
          // Flags: `(?i)` sets them for the rest of the group, and `(?i:`
          // opens a group that doesn't capture.
          let stop = index + 2
          while (
            stop < characters.length &&
            characters[stop] !== ")" &&
            characters[stop] !== ":"
          ) {
            stop += 1
          }
          output += characters.slice(index, stop + 1).join("")
          const flagsOnly = characters[stop] === ")"
          index = stop + 1
          if (flagsOnly) continue
          capture = false
        }
      } else {
        output += "("
        index += 1
      }
      frames.push({ capture, current: 0, done: 0, last: 0 })
    } else if (character === ")" && frames.length > 1) {
      const frame = frames.pop()!
      output += ")"
      index += 1
      atom(frame.done + frame.current + (frame.capture ? 2 : 0))
    } else if (character === "|") {
      const frame = frames.at(-1)!
      frame.done += frame.current + 1
      frame.current = 0
      frame.last = 0
      output += "|"
      index += 1
    } else if (character === "*" || character === "+" || character === "?") {
      const last = frames.at(-1)!.last
      repeated((character === "*" ? 2 : 1) + last)
      output += character
      index += 1
      if (characters[index] === "?") {
        output += "?"
        index += 1
      }
    } else if (character === "{") {
      const counted = /^\{(\d+)(,(\d*))?\}/u.exec(
        characters.slice(index, index + 24).join("")
      )
      if (counted) {
        // Go's limit is 1000; past that RE2JS rejects it, as Go does.
        const min = Math.min(Number(counted[1]), 1_001)
        const max =
          counted[2] === undefined
            ? min
            : counted[3]
              ? Math.min(Number(counted[3]), 1_001)
              : -1
        const last = frames.at(-1)!.last
        repeated(
          max === -1
            ? min === 0
              ? 2 + last
              : 1 + min * last
            : max * last + Math.max(0, max - min)
        )
        output += counted[0]
        index += [...counted[0]].length
        if (characters[index] === "?") {
          output += "?"
          index += 1
        }
      } else {
        output += "{"
        index += 1
        atom(1)
      }
    } else {
      output += character
      index += 1
      atom(1)
    }
  }
  let size = 0
  for (const frame of frames) size += frame.done + frame.current
  return { ranges, size, source: output }
}

const ANYTHING = "[\\x{0}-\\x{10ffff}]"
const NOTHING = "[^\\x{0}-\\x{10ffff}]"

// Go's canonical form of a property name: underscores, hyphens, and spaces
// dropped, the first letter upper case and the rest lower case.
function goCanonicalName(name: string): string {
  let canonical = ""
  for (const character of name) {
    if (character === "_" || character === "-" || character === " ") continue
    canonical +=
      canonical === "" && character >= "a" && character <= "z"
        ? character.toUpperCase()
        : canonical !== "" && character >= "A" && character <= "Z"
          ? character.toLowerCase()
          : character
  }
  return canonical
}
