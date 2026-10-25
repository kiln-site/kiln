import { spawnSync } from "node:child_process"
import { closeSync, createReadStream, mkdirSync, openSync } from "node:fs"
import { resolve } from "node:path"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const [stage = "all", ...arguments_] = process.argv.slice(2)

const stages = {
  static() {
    vp("run", "typecheck")
    vp("check")
  },
  tests() {
    // Exclude the root test script, which would run every package again.
    vp("run", "--filter", "!web", "--filter", "!kiln", "test")
    vp("test", "run")
  },
  hearth() {
    if (process.env.KILN_TEST_MYSQL !== "1") {
      if (process.env.CI) {
        console.error(
          "Hearth verification requires KILN_TEST_MYSQL=1 and DB_*."
        )
        process.exit(1)
      }
      // The dev helper resolves this worktree's MySQL settings, then calls
      // this stage again with KILN_TEST_MYSQL=1. Never silently skip MySQL.
      run(process.execPath, [
        resolve(root, "scripts/dev-docker.mjs"),
        "test",
        ...arguments_,
      ])
      return
    }
    vp("run", "--filter", "web", "test", ...arguments_)
  },
  async build() {
    const directory = resolve(root, "artifacts/verify")
    mkdirSync(directory, { recursive: true })
    const log = resolve(directory, "build.log")
    console.log(`Build output: ${log}`)
    const output = openSync(log, "w")
    let result
    try {
      // vp can fail forwarding a long asset list to a pipe (os error 11).
      // Give it a file locally and in CI, then replay the complete output.
      result = spawnSync(process.execPath, [vitePlus(), "run", "-r", "build"], {
        cwd: root,
        stdio: ["inherit", output, output],
      })
    } finally {
      closeSync(output)
    }
    await pipeline(createReadStream(log), process.stdout, { end: false })
    checkResult(result)
    run("git", ["diff", "--exit-code", "--", "apps/web/src/routeTree.gen.ts"])
  },
}

if (stage === "--help" || stage === "-h") {
  console.log(`Usage: pnpm verify [all|static|tests|hearth|build]

Runs the same four stages as the Code checks workflow, stopping on failure.
Hearth tests require the running dev stack, or KILN_TEST_MYSQL=1 with DB_*.
Use pnpm verify hearth <test paths/options> for targeted Hearth tests.
Build output is also saved in artifacts/verify/build.log.`)
} else if (
  (stage !== "all" && !Object.hasOwn(stages, stage)) ||
  (stage !== "hearth" && arguments_.length > 0)
) {
  console.error("Usage: pnpm verify [all|static|tests|hearth|build]")
  process.exitCode = 1
} else {
  for (const name of stage === "all" ? Object.keys(stages) : [stage]) {
    console.log(`\nVerifying: ${name}`)
    await stages[name]()
  }
  console.log(`\nVerification passed: ${stage}`)
}

function vitePlus() {
  return fileURLToPath(import.meta.resolve("vite-plus/bin"))
}

function vp(...args) {
  run(process.execPath, [vitePlus(), ...args])
}

function run(executable, args) {
  checkResult(spawnSync(executable, args, { cwd: root, stdio: "inherit" }))
}

function checkResult(result) {
  if (result.error) console.error(result.error.message)
  if (result.signal) process.kill(process.pid, result.signal)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
