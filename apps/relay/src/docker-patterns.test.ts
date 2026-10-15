import { Result } from "effect"
import { describe, expect, it } from "vite-plus/test"

import { BadPatternError, PatternMatcher } from "./docker-patterns.js"

// Cases from moby/patternmatcher's own tests (patternmatcher_test.go), so
// the Relay filters a build context exactly as BuildKit does.
const single: ReadonlyArray<readonly [string, string, boolean]> = [
  ["**", "file", true],
  ["**", "file/", true],
  ["**/", "file", true],
  ["**/", "file/", true],
  ["**", "/", true],
  ["**/", "/", true],
  ["**", "dir/file", true],
  ["**/", "dir/file", true],
  ["**", "dir/file/", true],
  ["**/", "dir/file/", true],
  ["**/**", "dir/file", true],
  ["**/**", "dir/file/", true],
  ["dir/**", "dir/file", true],
  ["dir/**", "dir/file/", true],
  ["dir/**", "dir/dir2/file", true],
  ["dir/**", "dir/dir2/file/", true],
  ["**/dir", "dir", true],
  ["**/dir", "dir/file", true],
  ["**/dir2/*", "dir/dir2/file", true],
  ["**/dir2/*", "dir/dir2/file/", true],
  ["**/dir2/**", "dir/dir2/dir3/file", true],
  ["**/dir2/**", "dir/dir2/dir3/file/", true],
  ["**file", "file", true],
  ["**file", "dir/file", true],
  ["**/file", "dir/file", true],
  ["**file", "dir/dir/file", true],
  ["**/file", "dir/dir/file", true],
  ["**/file*", "dir/dir/file", true],
  ["**/file*", "dir/dir/file.txt", true],
  ["**/file*txt", "dir/dir/file.txt", true],
  ["**/file*.txt", "dir/dir/file.txt", true],
  ["**/file*.txt*", "dir/dir/file.txt", true],
  ["**/**/*.txt", "dir/dir/file.txt", true],
  ["**/**/*.txt2", "dir/dir/file.txt", false],
  ["**/*.txt", "file.txt", true],
  ["**/**/*.txt", "file.txt", true],
  ["a**/*.txt", "a/file.txt", true],
  ["a**/*.txt", "a/dir/file.txt", true],
  ["a**/*.txt", "a/dir/dir/file.txt", true],
  ["a/*.txt", "a/dir/file.txt", false],
  ["a/*.txt", "a/file.txt", true],
  ["a/*.txt**", "a/file.txt", true],
  ["a[b-d]e", "ae", false],
  ["a[b-d]e", "ace", true],
  ["a[b-d]e", "aae", false],
  ["a[^b-d]e", "aze", true],
  [".*", ".foo", true],
  [".*", "foo", false],
  ["abc.def", "abcdef", false],
  ["abc.def", "abc.def", true],
  ["abc.def", "abcZdef", false],
  ["abc?def", "abcZdef", true],
  ["abc?def", "abcdef", false],
  ["a\\\\", "a\\", true],
  ["**/foo/bar", "foo/bar", true],
  ["**/foo/bar", "dir/foo/bar", true],
  ["**/foo/bar", "dir/dir2/foo/bar", true],
  ["abc/**", "abc", false],
  ["abc/**", "abc/def", true],
  ["abc/**", "abc/def/ghi", true],
  ["**/.foo", ".foo", true],
  ["**/.foo", "bar.foo", false],
  ["a(b)c/def", "a(b)c/def", true],
  ["a(b)c/def", "a(b)c/xyz", false],
  ["a.|)$(}+{bc", "a.|)$(}+{bc", true],
  [
    "dist/proxy.py-2.4.0rc3.dev36+g08acad9-py3-none-any.whl",
    "dist/proxy.py-2.4.0rc3.dev36+g08acad9-py3-none-any.whl",
    true,
  ],
  [
    "dist/*.whl",
    "dist/proxy.py-2.4.0rc3.dev36+g08acad9-py3-none-any.whl",
    true,
  ],
  ["a\\*b", "a*b", true],
  // A negated class: `secret` doesn't start with `a`.
  ["[^a]*", "secret", true],
  ["[^a]*", "apple", false],
]

const multiple: ReadonlyArray<
  readonly [ReadonlyArray<string>, string, boolean]
> = [
  [["**", "!util/docker/web"], "util/docker/web/foo", false],
  [
    ["**", "!util/docker/web", "util/docker/web/foo"],
    "util/docker/web/foo",
    true,
  ],
  [
    ["**", "!dist/proxy.py-2.4.0rc3.dev36+g08acad9-py3-none-any.whl"],
    "dist/proxy.py-2.4.0rc3.dev36+g08acad9-py3-none-any.whl",
    false,
  ],
  [
    ["**", "!dist/*.whl"],
    "dist/proxy.py-2.4.0rc3.dev36+g08acad9-py3-none-any.whl",
    false,
  ],
  [["!fileutils.go", "*.go"], "fileutils.go", true],
  [["docs", "!docs/README.md"], "docs/README.md", false],
  [["docs/", "!docs/README.md"], "docs/README.md", false],
  [["docs/*", "!docs/README.md"], "docs/README.md", false],
  [["*.go", "!fileutils.go"], "fileutils.go", false],
]

// Go's filepath.Match cases, as patternmatcher's tests run them.
const filepathCases: ReadonlyArray<readonly [string, string, boolean | "bad"]> =
  [
    ["abc", "abc", true],
    ["*", "abc", true],
    ["*c", "abc", true],
    ["a*", "a", true],
    ["a*", "abc", true],
    ["a*", "ab/c", true],
    ["a*/b", "abc/b", true],
    ["a*/b", "a/c/b", false],
    ["a*b*c*d*e*/f", "axbxcxdxe/f", true],
    ["a*b*c*d*e*/f", "axbxcxdxexxx/f", true],
    ["a*b*c*d*e*/f", "axbxcxdxe/xxx/f", false],
    ["a*b*c*d*e*/f", "axbxcxdxexxx/fff", false],
    ["a*b?c*x", "abxbbxdbxebxczzx", true],
    ["a*b?c*x", "abxbbxdbxebxczzy", false],
    ["ab[c]", "abc", true],
    ["ab[b-d]", "abc", true],
    ["ab[e-g]", "abc", false],
    ["ab[^c]", "abc", false],
    ["ab[^b-d]", "abc", false],
    ["ab[^e-g]", "abc", true],
    ["a\\*b", "a*b", true],
    ["a\\*b", "ab", false],
    ["a?b", "a☺b", true],
    ["a[^a]b", "a☺b", true],
    ["a???b", "a☺b", false],
    ["a[^a][^a][^a]b", "a☺b", false],
    ["[a-ζ]*", "α", true],
    ["*[a-ζ]", "A", false],
    ["a?b", "a/b", false],
    ["a*b", "a/b", false],
    ["[\\]a]", "]", true],
    ["[\\-]", "-", true],
    ["[x\\-]", "x", true],
    ["[x\\-]", "-", true],
    ["[x\\-]", "z", false],
    ["[\\-x]", "x", true],
    ["[\\-x]", "-", true],
    ["[\\-x]", "a", false],
    ["[]a]", "]", "bad"],
    ["[-]", "-", "bad"],
    ["[x-]", "x", "bad"],
    ["[x-]", "-", "bad"],
    ["[x-]", "z", "bad"],
    ["[-x]", "x", "bad"],
    ["[-x]", "-", "bad"],
    ["[-x]", "a", "bad"],
    ["\\", "a", "bad"],
    ["[a-b-c]", "a", "bad"],
    ["[", "a", "bad"],
    ["[^", "a", "bad"],
    ["[^bc", "a", "bad"],
    ["a[", "a", "bad"],
    ["a[", "ab", "bad"],
    ["*x", "xxx", true],
  ]

// Generated by running moby/patternmatcher v0.6.1 itself, in Go: for each
// pattern, its verdict on each of these paths (1 matches, 0 doesn't, E an
// error). Regexp metacharacters beside globs, POSIX and Perl classes,
// negations, and Unicode, where a translation would drift from Go's RE2.
const differentialPaths = ["foo", "bar", "barx", "foo|bar", "foo|barx", "aa", "aab", "a", "ab", "b", "abab", "a{2}", "1", "12", "a1", "x", "X", "dir/foo", "foo/x", "a.b", "a+b", "aab/x", "{a,b}", "a$", "^a", "x|y", "xy", "z", "A", "Ab", "aB", " ", "a b", "]", "😀", "😀x", "a*", "*", "x.go", "d/x.go", "dir", "dir/a", "ac", "aXb", "αβ", "ab/c", "b/a"]
const differential: ReadonlyArray<readonly [string, string]> = [
  ["foo|bar*", "11111000000000000010000000000000000000000000000"],
  ["foo|bar", "00010000000000000000000000000000000000000000000"],
  ["a|**", "00000000000000000000000000000000000000000000000"],
  ["**|a", "00000000000000000000000000000000000000000000000"],
  ["**/a|b", "00000000000000000000000000000000000000000000000"],
  ["x*y|z", "00000000000000000000000001110000000000000000000"],
  ["a||b*", "11111111111111111111111111111111111111111111111"],
  ["a{2}", "00000000000100000000000000000000000000000000000"],
  ["a{2}*", "00000110000000000000010000000000000000000000000"],
  ["a{2,}*", "00000110000000000000010000000000000000000000000"],
  ["a{,2}*", "00000000000000000000000000000000000000000000000"],
  ["{a,b}*", "00000000000000000000001000000000000000000000000"],
  ["a{1001}*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["a\\{2\\}*", "00000000000100000000000000000000000000000000000"],
  ["a+b*", "00000000000000000000100000000000000000000000000"],
  ["a.b*", "00000000000000000001000000000000000000000000000"],
  ["(ab)*", "00000000000000000000000000000000000000000000000"],
  ["a$*", "00000000000000000000000100000000000000000000000"],
  ["^a*", "00000111101100100001110100000010100010000011010"],
  ["a^*", "00000000000000000000000000000000000000000000000"],
  ["x\\|y*", "00000000000000000000000001000000000000000000000"],
  ["a(b|c)*", "00000000000000000000000000000000000000000000000"],
  ["[[:digit:]]*", "00000000000011000000000000000000000000000000000"],
  ["[[:^digit:]]*", "11111111111100111111111111111111111111111111111"],
  ["[[:alpha:]]x*", "00000000000000000000000000000000000000000000000"],
  ["[^[:space:]]*", "11111111111111111111111111111110111111111111111"],
  ["[[:upper:]]*", "00000000000000001000000000001100000000000000000"],
  ["[[:word:]]*", "11111111111111111111110101111110100010111111011"],
  ["[[:foo:]]*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["*[[:upper:]]", "00000000000000001000000000001010000000000000000"],
  ["[a-c]*", "01100111111100100001110100000010100010000011011"],
  ["[!a]*", "00000111101100100001110100000010100010000011010"],
  ["[^a]*", "11111000010011011110001011111101011101111100101"],
  ["[\\]]*", "00000000000000000000000000000000010000000000000"],
  ["[a-]*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["[]a]*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["\\d*", "00000000000011000000000000000000000000000000000"],
  ["\\w*", "11111111111111111111110101111110100010111111011"],
  ["\\pL*", "11111111111100111111110101111110100010111111111"],
  ["\\p{Greek}*", "00000000000000000000000000000000000000000000100"],
  ["\\Qa*\\E", "00000000000000000000000000000000000000000000000"],
  ["a\\*", "00000000000000000000000000000000000010000000000"],
  ["\\.*", "00000000000000000000000000000000000000000000000"],
  ["*\\", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["(?i)A*", "00000000000000000000000000000000000000000000000"],
  ["a(?i)B*", "00000000000000000000000000000000000000000000000"],
  ["\\x41*", "00000000000000000000000000001100000000000000000"],
  ["\\101*", "00000000000000000000000000001100000000000000000"],
  ["\\z*", "00000000000000000000000000000000000000000000000"],
  ["a\\b*", "00000001000100000001100100000000100010000000000"],
  ["\\C*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["*.go", "00000000000000000000000000000000000000100000000"],
  ["**/*.go", "00000000000000000000000000000000000000110000000"],
  ["dir/**", "00000000000000000100000000000000000000000100000"],
  ["**", "11111111111111111111111111111111111111111111111"],
  ["?", "00000001010010011000000000011001011001010000001"],
  ["?*", "11111111111111111111111111111111111111111111111"],
  ["*?", "11111111111111111111111111111111111111111111111"],
  ["﻿*.go", "00000000000000000000000000000000000000100000000"],
  ["😀*", "00000000000000000000000000000000001100000000000"],
  ["[😀]*", "00000000000000000000000000000000001100000000000"],
  ["a?b", "00000010000000000001110000000000100000000001000"],
]

// The same, for Unicode properties, from patternmatcher built with Go
// 1.26.8 (Docker 29's): names Go rejects though RE2JS knows them (newer
// scripts, `Unknown`, underscored script names), names Go accepts though
// RE2JS doesn't (any case, aliases, `ASCII`), and characters Unicode
// assigned after Go's 15.0 tables.
const unicodePaths = ["a", "A", "ab", "abc", "1", "123", "a1", "\u03b1\u03b2", "\u03a9", "x", "\u216b", "\u4e2d\u6587", "\ud83d\ude00", "\u0378", "\ud803\udd40", "\ud818\udd00", "\ud839\udcd0", "\ud807\udf00", "\u00e9", "\u01c5", "_", "-", " ", "aa", "aaa", "a*b", "a\\b", "\u00a0", "\u017f", "\u212a", "\u007f", "\u0080", "dir/\u03b1\u03b2"]
const unicodeDifferential: ReadonlyArray<readonly [string, string]> = [
  ["\\P{Unknown}*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["\\p{Unknown}*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["\\p{Garay}*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["[\\p{Sunuwar}]*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["\\p{Nag_Mundari}*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["\\p{Old_Italic}*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["\\p{greek}*", "000000011000000000000000000000000"],
  ["\\p{GREEK}*", "000000011000000000000000000000000"],
  ["[^\\p{greek}]*", "111111100111111111111111111111111"],
  ["\\p{ASCII}*", "111111100100000000001111111000101"],
  ["\\P{ascii}*", "000000011011111111110000000111010"],
  ["[\\P{ASCII}]*", "000000011011111111110000000111010"],
  ["\\p{Letter}*", "111100111101000010110001111011001"],
  ["\\p{Lowercase_Letter}*", "101100110100000000100001111010001"],
  ["\\p{lowercase letter}*", "101100110100000000100001111010001"],
  ["\\p{Assigned}*", "111111111111100011111111111111111"],
  ["\\P{Assigned}*", "000000000000011100000000000000000"],
  ["\\p{Unassigned}*", "000000000000011100000000000000000"],
  ["\\p{L}*", "111100111101000010110001111011001"],
  ["[\\p{L}]*", "111100111101000010110001111011001"],
  ["[^\\P{L}]*", "111100111101000010110001111011001"],
  ["\\p{Lo}*", "000000000001000010000000000000000"],
  ["\\p{Cn}*", "000000000000011100000000000000000"],
  ["\\p{C}*", "000000000000011100000000000000110"],
  ["\\p{Any}*", "111111111111111111111111111111111"],
  ["\\P{Any}*", "000000000000000000000000000000000"],
  ["[\\P{Any}]*", "000000000000000000000000000000000"],
  ["[^\\P{Any}]*", "111111111111111111111111111111111"],
  ["\\p{^Greek}*", "111111100111111111111111111111111"],
  ["\\P{^Greek}*", "000000011000000000000000000000000"],
  ["\\pL*", "111100111101000010110001111011001"],
  ["\\pl*", "111100111101000010110001111011001"],
  ["\\pX*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["\\p{Script=Greek}*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["\\p{L&}*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["\\p{Han}*", "000000000001000000000000000000000"],
  ["\\p{Common}*", "000011000000100000001110000100110"],
  ["\\x{110000}*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["\\C*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["\\Z*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["\\Qa*b\\E", "000000000000000000000000000000000"],
  ["a{1001}", "000000000000000000000000000000000"],
  ["[[:foo:]]*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
  ["[a-\\pL]*", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
]

// MatchesUsingParentResults, given its parents' results as a walk does.
function matchesWalking(matcher: PatternMatcher, file: string): boolean {
  const parents = file.split("/").slice(0, -1).filter(Boolean)
  let info: ReadonlyArray<boolean> | undefined
  for (let depth = 1; depth <= parents.length; depth += 1) {
    info = matcher.matchesUsingParentResults(
      parents.slice(0, depth).join("/"),
      info
    )[1]
  }
  return matcher.matchesUsingParentResults(file, info)[0]
}

describe("build context patterns", () => {
  it.each(single)("%s against %s is %s", (pattern, file, expected) => {
    const matcher = new PatternMatcher([pattern])
    expect(matcher.matchesOrParentMatches(file)).toBe(expected)
    expect(matchesWalking(matcher, file)).toBe(expected)
    expect(matcher.matchesUsingParentResults(file, undefined)[0]).toBe(expected)
  })

  it.each(multiple)("%j against %s is %s", (patterns, file, expected) => {
    const matcher = new PatternMatcher(patterns)
    expect(matcher.matchesOrParentMatches(file)).toBe(expected)
    expect(matchesWalking(matcher, file)).toBe(expected)
    expect(matcher.matchesUsingParentResults(file, undefined)[0]).toBe(expected)
  })

  it.each(filepathCases)(
    "filepath.Match %s against %s is %s",
    (pattern, file, expected) => {
      if (expected === "bad") {
        expect(() => new PatternMatcher([pattern])).toThrow(BadPatternError)
        return
      }
      expect(new PatternMatcher([pattern]).matchesOrParentMatches(file)).toBe(
        expected
      )
    }
  )

  it("matches in time linear in the name, as RE2 does, for a pattern that makes backtracking explode", () => {
    // `*a*a…*ab` against a long name without a `b`: a backtracking
    // matcher takes exponential time; Go's RE2 is linear.
    const matcher = new PatternMatcher(["*a".repeat(20) + "b"])
    const name = "a".repeat(100)

    const started = performance.now()
    const matched = matcher.matchesOrParentMatches(name)
    const elapsed = performance.now() - started

    expect(matched).toBe(false)
    expect(elapsed).toBeLessThan(250)
  })

  it.each(differential)("%s matches as patternmatcher does", (pattern, verdicts) => {
    const actual = differentialPaths
      .map((path) => {
        const matched = Result.try(() =>
          new PatternMatcher([pattern]).matchesOrParentMatches(path)
        )
        if (Result.isFailure(matched)) {
          expect(matched.failure).toBeInstanceOf(BadPatternError)
          return "E"
        }
        return matched.success ? "1" : "0"
      })
      .join("")
    expect(actual).toBe(verdicts)
  })

  it.each(unicodeDifferential)("%s matches as patternmatcher built with Go 1.26 does", (pattern, verdicts) => {
    const actual = unicodePaths
      .map((path) => {
        const matched = Result.try(() =>
          new PatternMatcher([pattern]).matchesOrParentMatches(path)
        )
        if (Result.isFailure(matched)) {
          expect(matched.failure).toBeInstanceOf(BadPatternError)
          return "E"
        }
        return matched.success ? "1" : "0"
      })
      .join("")
    expect(actual).toBe(verdicts)
  })

  it("refuses a pattern whose counted repeats would make a huge program, before compiling it", () => {
    // 7 KB, which Go accepts, and RE2JS would hold in hundreds of MB.
    const matcher = new PatternMatcher(["a{1000}".repeat(1_000) + "?"])

    const started = performance.now()
    expect(() => matcher.matchesOrParentMatches("a")).toThrow(
      /its regular expression is 100000\d instructions; Kiln compiles up to 20000/u
    )
    expect(performance.now() - started).toBeLessThan(100)
  })

  it("refuses patterns that together would make too large a program", () => {
    const matcher = new PatternMatcher(
      Array.from({ length: 6 }, (_, index) => `${index}${"a{1000}".repeat(19)}?`)
    )

    expect(() => matcher.matchesOrParentMatches("a")).toThrow(
      "the build's patterns come to more than 100000 regular expression instructions"
    )
  })

  it("compiles a long pattern in time linear in its length", () => {
    // Compiled on first use.
    const matcher = new PatternMatcher(["[[:^digit:]]*a".repeat(3_000)])

    const started = performance.now()
    const matched = matcher.matchesOrParentMatches("1".repeat(100))
    const elapsed = performance.now() - started

    expect(matched).toBe(false)
    expect(elapsed).toBeLessThan(1_000)
  })

  it("rejects a lone exception and fails a range Go's regexp rejects", () => {
    expect(() => new PatternMatcher(["!"])).toThrow(BadPatternError)
    // Passes filepath.Match's check, but `l-O` is a backwards range.
    const matcher = new PatternMatcher(["[Local-Only]/"])
    expect(() => matcher.matchesOrParentMatches("x")).toThrow(BadPatternError)
    expect(() => matcher.matchesOrParentMatches("x")).toThrow(BadPatternError)
  })
})
