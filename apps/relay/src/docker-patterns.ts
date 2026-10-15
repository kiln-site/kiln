import { Result } from "effect"
import { RE2JS } from "re2js"

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
  #regexp: RE2JS | undefined

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
      // RE2's syntax and linear-time matching, as Go's regexp package.
      const compiled = Result.try({
        try: () => RE2JS.compile(`${source}$`),
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
