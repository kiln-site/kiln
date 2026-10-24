import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, test } from "vite-plus/test"

const fixtures = []
const unavailable = 'throw new Error("Native compiler unavailable")'
const validSource = "export const value: number = 1\n"
const invalidSource = 'export const value: number = "wrong"\n'

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test("Vite+ accepts valid types when tsrs cannot start", () => {
  const result = check(unavailable, validSource)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test("Vite+ rejects invalid types when tsrs cannot start", () => {
  const result = check(unavailable, invalidSource)
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /TS2322/)
})

test("a native type error cannot be masked by a successful Vite+ fallback", () => {
  const result = check(
    `if (process.argv.includes("--version")) process.exit(0)
     console.error("TS2322: native type error")
     process.exit(2)`,
    validSource
  )
  assert.equal(result.status, 2, result.stdout + result.stderr)
  assert.match(result.stdout + result.stderr, /TS2322/)
})

test("a native success does not run a second compiler", () => {
  const result = check("process.exit(0)", invalidSource)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

function check(nativeCli, source) {
  const root = mkdtempSync(join(tmpdir(), "kiln-typecheck-"))
  fixtures.push(root)
  mkdirSync(join(root, "scripts"))
  mkdirSync(join(root, "src"))
  mkdirSync(join(root, "node_modules/tsrs/bin"), { recursive: true })
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ private: true, type: "module" })
  )
  writeFileSync(
    join(root, "node_modules/tsrs/package.json"),
    JSON.stringify({ exports: { "./package.json": "./package.json" } })
  )
  // Only the external tsrs executable is replaced. Exercise the real wrapper,
  // production Vite+ configuration, and Go typechecker for the fallback.
  writeFileSync(join(root, "node_modules/tsrs/bin/tsrs"), nativeCli)
  symlinkSync(
    realpathSync(
      fileURLToPath(new URL("../node_modules/vite-plus", import.meta.url))
    ),
    join(root, "node_modules/vite-plus"),
    "junction"
  )
  for (const file of [
    "scripts/typecheck.mjs",
    "scripts/oxlint-plugin.mjs",
    "vite.config.ts",
    ".gitignore",
  ]) {
    cpSync(new URL(`../${file}`, import.meta.url), join(root, file))
  }
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
      include: ["src/**/*.ts"],
    })
  )
  writeFileSync(join(root, "src/index.ts"), source)
  return spawnSync(process.execPath, [join(root, "scripts/typecheck.mjs")], {
    cwd: root,
    encoding: "utf8",
  })
}
