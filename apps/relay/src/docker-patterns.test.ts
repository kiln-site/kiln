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

  it("rejects a lone exception and fails a range Go's regexp rejects", () => {
    expect(() => new PatternMatcher(["!"])).toThrow(BadPatternError)
    // Passes filepath.Match's check, but `l-O` is a backwards range.
    const matcher = new PatternMatcher(["[Local-Only]/"])
    expect(() => matcher.matchesOrParentMatches("x")).toThrow(BadPatternError)
    expect(() => matcher.matchesOrParentMatches("x")).toThrow(BadPatternError)
  })
})
