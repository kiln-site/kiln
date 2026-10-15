import { describe, expect, it } from "vite-plus/test"

import { shellWords } from "./shell-words.js"

// Cases from mattn/go-shellwords v1.0.14's own tests (shellwords_test.go)
// that apply with environment, backtick, and comment parsing off, as
// Compose parses a string command or entrypoint.
const words: ReadonlyArray<readonly [string, Array<string>]> = [
  [``, []],
  [`""`, [``]],
  [`''`, [``]],
  [`var --bar=baz`, [`var`, `--bar=baz`]],
  [`var --bar="baz"`, [`var`, `--bar=baz`]],
  [`var "--bar=baz"`, [`var`, `--bar=baz`]],
  [`var "--bar='baz'"`, [`var`, `--bar='baz'`]],
  ["var --bar=`baz`", [`var`, "--bar=`baz`"]],
  [`var "--bar=\\"baz'"`, [`var`, `--bar="baz'`]],
  [`var "--bar=\\'baz\\'"`, [`var`, `--bar='baz'`]],
  [`var --bar='\\'`, [`var`, `--bar=\\`]],
  [`var "--bar baz"`, [`var`, `--bar baz`]],
  [`var --"bar baz"`, [`var`, `--bar baz`]],
  [`var  --"bar baz"`, [`var`, `--bar baz`]],
  [`a "b"`, [`a`, `b`]],
  [`a " b "`, [`a`, ` b `]],
  [`a "   "`, [`a`, `   `]],
  [`a 'b'`, [`a`, `b`]],
  [`a ' b '`, [`a`, ` b `]],
  [`a '   '`, [`a`, `   `]],
  ["foo bar\\  ", [`foo`, `bar `]],
  [`foo "" bar ''`, [`foo`, ``, `bar`, ``]],
  [`foo \\\\`, [`foo`, `\\`]],
  [`foo \\& bar`, [`foo`, `&`, `bar`]],
  [`sh -c "printf 'Hello\\tworld\\n'"`, [`sh`, `-c`, "printf 'Hello\tworld\n'"]],
  // TestComment's cases, with comment parsing off.
  ["foo not#comment", ["foo", "not#comment"]],
  // TestHaveMore, TestHaveRedirect, TestHaveRedirectPrefix: the words
  // before a command separator or redirect.
  ["echo 🍺; seq 1 10", ["echo", "🍺"]],
  ["ls -la 2>foo", ["ls", "-la"]],
  ["cmd 2x> file", ["cmd", "2x"]],
  ["cmd 10> file", ["cmd"]],
  // Substitutions are kept as written when not run.
  ["echo $(echo a\\ b)", ["echo", "$(echo a\\ b)"]],
  ["cmd -flag=`echo val1` -flag=val2", ["cmd", "-flag=`echo val1`", "-flag=val2"]],
]

const errors = [
  "foo '",
  `foo "`,
  "foo `",
  "echo $(echo1",
  "echo $ (echo1",
  "echo (echo1",
  "echo )echo1",
]

describe("shellWords", () => {
  it.each(words)("splits %j", (line, expected) => {
    expect(shellWords(line, "The command")).toEqual(expected)
  })

  it.each(errors)("refuses %j", (line) => {
    expect(() => shellWords(line, "The command")).toThrow(
      "The command is not a valid command line"
    )
  })
})
