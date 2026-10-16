import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { test } from "vite-plus/test"

// The Relay talks to Docker through the Engine API on its socket
// (apps/relay/src/docker-engine.ts) and runs only the standalone Compose and
// buildx binaries. Its image ships no docker CLI, so code that starts one
// would fail on every real install.
const workspaceRoot = new URL("../", import.meta.url)
// A process started as `docker`, by name or path, possibly across lines, or a
// shell script (`sh -c`) that runs it. `docker-compose` and `docker-buildx` are
// the standalone binaries.
const startsDocker = [
  /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|command\w*)\(\s*["'`](?:[^"'`\s]*\/)?docker(?:["'`]|\s)/gu,
  /["'`]-c["'`]\s*,\s*[^\n]*?[\s;&|("'`/]docker\s/gu,
]

test("Relay never runs the docker CLI", async () => {
  const sources = await readdir(new URL("apps/relay/", workspaceRoot), {
    recursive: true,
  })
  const violations = []
  for (const path of sources) {
    if (!/\.m?[jt]s$/u.test(path) || /\.test\.|^(?:dist|node_modules)\/|\/test\//u.test(path)) {
      continue
    }
    const text = await readFile(new URL(`apps/relay/${path}`, workspaceRoot), "utf8")
    for (const pattern of startsDocker) {
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split("\n").length
        violations.push(`apps/relay/${path}:${line}`)
      }
    }
  }
  assert.deepEqual(violations, [], "Relay must use the Docker Engine API, not the docker CLI")
})

test("the Relay's images, released and in development, install no docker CLI", async () => {
  for (const file of ["apps/relay/Dockerfile", "compose.dev.yaml"]) {
    const text = await readFile(new URL(file, workspaceRoot), "utf8")
    // Docker's CLI image, a package install of Docker, or its static CLI.
    assert.doesNotMatch(
      text,
      /^\s*(?:FROM|COPY)\b[^\n]*\bdocker:|^[^#\n]*\b(?:apk add|apt-get install|apt install|dnf install|yum install)\b[^\n]*\bdocker|^[^#\n]*\bdownload\.docker\.com|^[^#\n]*\/docker-\d[^\n]*\.tgz/mu,
      `${file} installs the docker CLI`
    )
  }
})
