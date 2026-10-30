import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const entrypointSource = await readFile(
  join(root, "embers/java/entrypoint.sh"),
  "utf8"
)
const serverDirectoryLine = "\ncd /server\n"

// The image runs the entrypoint in /server; tests point it at a temp directory.
function testableEntrypoint() {
  assert.equal(
    entrypointSource.split(serverDirectoryLine).length - 1,
    1,
    "embers/java/entrypoint.sh must `cd /server` exactly once; update this test with the new server directory line"
  )
  return entrypointSource.replace(
    serverDirectoryLine,
    '\ncd "${KILN_TEST_SERVER_DIRECTORY:?}"\n'
  )
}

// A temp server directory and the entrypoint.
async function emberSandbox(context) {
  const directory = await mkdtemp(join(tmpdir(), "kiln-java-ember-"))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const server = join(directory, "server")
  await mkdir(server, { recursive: true })
  const entrypoint = join(directory, "entrypoint.sh")
  await writeFile(entrypoint, testableEntrypoint())
  await chmod(entrypoint, 0o755)

  return {
    server,
    run(environment) {
      return new Promise((resolveResult, rejectResult) => {
        const child = spawn(entrypoint, {
          env: {
            KILN_TEST_SERVER_DIRECTORY: server,
            PATH: process.env.PATH ?? "",
            ...environment,
          },
          stdio: ["ignore", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
          stdout += chunk
        })
        child.stderr.setEncoding("utf8").on("data", (chunk) => {
          stderr += chunk
        })
        child.once("error", rejectResult)
        child.once("close", (status) =>
          resolveResult({ status, stderr, stdout })
        )
      })
    },
  }
}

test("the Java Ember rejects marker names outside the reserved namespace", async (context) => {
  const ember = await emberSandbox(context)
  await writeFile(join(ember.server, "paper.jar"), "keep me")

  const result = await ember.run({
    KILN_ARTIFACT_FILE: "paper.jar",
    KILN_ARTIFACT_URL: "https://example.invalid/paper.jar",
    KILN_INSTALLATION_MARKER: "paper.jar",
  })

  assert.equal(result.status, 64)
  assert.match(result.stderr, /must be a reserved \.kiln-\* filename/u)
  assert.equal(
    await readFile(join(ember.server, "paper.jar"), "utf8"),
    "keep me"
  )
})
