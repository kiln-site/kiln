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

const fakeJavaRecordingArguments = `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "-version" ]]; then
  echo 'openjdk version "test"' >&2
  exit 0
fi
printf '%s\\n' "$@" > "$FAKE_JAVA_ARGUMENTS"
`

// A temp server directory, a bin directory for fake tools, and the entrypoint.
async function emberSandbox(context) {
  const directory = await mkdtemp(join(tmpdir(), "kiln-java-ember-"))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const bin = join(directory, "bin")
  const server = join(directory, "server")
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(server, { recursive: true }),
  ])
  const entrypoint = join(directory, "entrypoint.sh")
  await writeFile(entrypoint, testableEntrypoint())
  await chmod(entrypoint, 0o755)

  return {
    directory,
    server,
    async tool(name, script) {
      await writeFile(join(bin, name), script)
      await chmod(join(bin, name), 0o755)
    },
    run(environment) {
      return new Promise((resolveResult, rejectResult) => {
        const child = spawn(entrypoint, {
          env: {
            KILN_TEST_SERVER_DIRECTORY: server,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
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

async function readArguments(path) {
  const text = await readFile(path, "utf8").catch(() => "")
  return text.trimEnd() === "" ? [] : text.trimEnd().split("\n")
}

async function runPaperJavaEmber(context, environment = {}) {
  const ember = await emberSandbox(context)
  const argumentsPath = join(ember.directory, "java-arguments")
  await ember.tool("java", fakeJavaRecordingArguments)
  await writeFile(join(ember.server, "paper.jar"), "complete artifact")

  const result = await ember.run({
    FAKE_JAVA_ARGUMENTS: argumentsPath,
    KILN_ARTIFACT_FILE: "paper.jar",
    KILN_ARTIFACT_URL: "https://example.invalid/paper.jar",
    KILN_IMPLEMENTATION: "paper",
    KILN_SERVER_KIND: "minecraft",
    KILN_VERSION: "1.21.11",
    ...environment,
  })
  return { ...result, args: await readArguments(argumentsPath) }
}

// Static check only: the image build is the real test. This guards against
// trimming jlink modules or font libraries that plugins need at runtime.
test("the Java Ember Dockerfile still requests the runtime modules plugins need", async () => {
  const dockerfile = await readFile(
    join(root, "embers/java/Dockerfile"),
    "utf8"
  )
  assert.match(dockerfile, /\bjava\.se\b/u)
  assert.match(dockerfile, /\bjdk\.unsupported\b/u)
  assert.match(dockerfile, /\bjdk\.incubator\.vector\b/u)
  assert.match(dockerfile, /\bfontconfig\b/u)
  assert.match(dockerfile, /\blibfreetype6\b/u)
})

test("the Java Ember reports a terminal download failure and removes the partial artifact", async (context) => {
  const ember = await emberSandbox(context)
  await ember.tool(
    "curl",
    `#!/usr/bin/env bash
set -eu
while (($#)); do
  if [[ "$1" == "--output" ]]; then
    printf 'partial' > "$2"
    break
  fi
  shift
done
echo 'curl: (7) simulated network failure' >&2
exit 7
`
  )

  const result = await ember.run({
    KILN_ARTIFACT_FILE: "paper.jar",
    KILN_ARTIFACT_URL: "https://example.invalid/paper.jar",
    KILN_IMPLEMENTATION: "paper",
    KILN_INSTALLATION_MARKER: ".kiln-ember-installed",
    KILN_VERSION: "1.21.11",
  })

  assert.equal(result.status, 7)
  assert.match(result.stderr, /curl: \(7\) simulated network failure/u)
  assert.match(result.stderr, /failed to download paper 1\.21\.11/u)
  await assert.rejects(readFile(join(ember.server, ".paper.jar.download")), {
    code: "ENOENT",
  })
  await assert.rejects(readFile(join(ember.server, "paper.jar")), {
    code: "ENOENT",
  })
  await assert.rejects(readFile(join(ember.server, ".kiln-ember-installed")), {
    code: "ENOENT",
  })
})

test("the Java Ember writes the installation marker before starting the server", async (context) => {
  const ember = await emberSandbox(context)
  await ember.tool(
    "curl",
    `#!/usr/bin/env bash
set -eu
while (($#)); do
  if [[ "$1" == "--output" ]]; then
    printf 'complete artifact' > "$2"
    exit 0
  fi
  shift
done
exit 2
`
  )
  await ember.tool(
    "java",
    `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "-version" ]]; then
  echo 'openjdk version "test"' >&2
  exit 0
fi
test -f "$KILN_TEST_SERVER_DIRECTORY/.kiln-ember-installed"
echo 'fake server started'
`
  )

  const result = await ember.run({
    KILN_ARTIFACT_FILE: "paper.jar",
    KILN_ARTIFACT_URL: "https://example.invalid/paper.jar",
    KILN_IMPLEMENTATION: "paper",
    KILN_INSTALLATION_MARKER: ".kiln-ember-installed",
    KILN_VERSION: "1.21.11",
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /fake server started/u)
  assert.equal(
    await readFile(join(ember.server, ".kiln-ember-installed"), "utf8"),
    ""
  )
  assert.equal(
    await readFile(join(ember.server, "eula.txt"), "utf8"),
    "eula=true\n"
  )
  assert.doesNotMatch(
    await readFile(join(ember.server, "server.properties"), "utf8"),
    /^online-mode=/mu
  )
})

test("the Java Ember distinguishes unset and empty server arguments", async (context) => {
  const ember = await emberSandbox(context)
  await ember.tool("java", fakeJavaRecordingArguments)
  await writeFile(join(ember.server, "velocity.jar"), "complete artifact")

  const runEmber = async (name, serverArguments) => {
    const argumentsPath = join(ember.directory, `${name}-arguments`)
    const result = await ember.run({
      FAKE_JAVA_ARGUMENTS: argumentsPath,
      KILN_ARTIFACT_FILE: "velocity.jar",
      KILN_ARTIFACT_URL: "https://example.invalid/velocity.jar",
      KILN_IMPLEMENTATION: "velocity",
      KILN_SERVER_KIND: "application",
      KILN_VERSION: "3.5.1",
      ...(serverArguments === undefined
        ? {}
        : { KILN_SERVER_ARGS: serverArguments }),
    })
    assert.equal(result.status, 0, result.stderr)
    return readArguments(argumentsPath)
  }

  const baseArguments = [
    "-Xms512M",
    "-XX:MaxRAMPercentage=75.0",
    "-jar",
    "velocity.jar",
  ]
  assert.deepEqual(await runEmber("unset", undefined), [
    ...baseArguments,
    "--nogui",
  ])
  assert.deepEqual(await runEmber("empty", ""), baseArguments)
  await assert.rejects(readFile(join(ember.server, "server.properties")), {
    code: "ENOENT",
  })
})

test("the Java Ember inserts extra JVM arguments between memory flags and the jar", async (context) => {
  const result = await runPaperJavaEmber(context, {
    KILN_JAVA_ARGS: "-XX:+UseG1GC -XX:+AlwaysPreTouch",
  })

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.args, [
    "-Xms512M",
    "-XX:MaxRAMPercentage=75.0",
    "-XX:+UseG1GC",
    "-XX:+AlwaysPreTouch",
    "-jar",
    "paper.jar",
    "--nogui",
  ])
})

test("the Java Ember keeps quoted JVM argument values as a single argument", async (context) => {
  const result = await runPaperJavaEmber(context, {
    KILN_JAVA_ARGS: "-Dmessage=\"hello world\" -Dpath='plugins/My Plugin'",
  })

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.args, [
    "-Xms512M",
    "-XX:MaxRAMPercentage=75.0",
    "-Dmessage=hello world",
    "-Dpath=plugins/My Plugin",
    "-jar",
    "paper.jar",
    "--nogui",
  ])
})

test("the Java Ember ignores heap aliases in extra JVM arguments", async (context) => {
  const result = await runPaperJavaEmber(context, {
    KILN_JAVA_ARGS:
      "-XX:+UseG1GC -XX:MaxHeapSize=1G -Xmx2G -XX:MaxRAMPercentage=90",
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stderr,
    /ignoring managed JVM flags: -XX:MaxHeapSize=1G -Xmx2G -XX:MaxRAMPercentage=90/u
  )
  assert.deepEqual(result.args, [
    "-Xms512M",
    "-XX:MaxRAMPercentage=75.0",
    "-XX:+UseG1GC",
    "-jar",
    "paper.jar",
    "--nogui",
  ])
})

test("the Java Ember ignores an overridden server jar", async (context) => {
  const result = await runPaperJavaEmber(context, {
    KILN_JAVA_ARGS: "-XX:+UseG1GC -jar untrusted.jar",
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stderr,
    /ignoring managed JVM flags: -jar untrusted\.jar/u
  )
  assert.deepEqual(result.args, [
    "-Xms512M",
    "-XX:MaxRAMPercentage=75.0",
    "-XX:+UseG1GC",
    "-jar",
    "paper.jar",
    "--nogui",
  ])
})

test("the Java Ember ignores flags that disable container-aware heap", async (context) => {
  const result = await runPaperJavaEmber(context, {
    KILN_JAVA_ARGS:
      "-XX:+UseG1GC -XX:-UseContainerSupport -XX:-UseCGroupMemoryLimitForHeap",
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stderr,
    /ignoring managed JVM flags: -XX:-UseContainerSupport -XX:-UseCGroupMemoryLimitForHeap/u
  )
  assert.deepEqual(result.args, [
    "-Xms512M",
    "-XX:MaxRAMPercentage=75.0",
    "-XX:+UseG1GC",
    "-jar",
    "paper.jar",
    "--nogui",
  ])
})

test("the Java Ember rejects unmatched quotes in extra JVM arguments", async (context) => {
  const result = await runPaperJavaEmber(context, {
    KILN_JAVA_ARGS: '-Dmessage="hello world',
  })

  assert.equal(result.status, 64, result.stderr)
  assert.match(result.stderr, /unmatched quote in KILN_JAVA_ARGS/u)
  assert.deepEqual(result.args, [])
})

test("the Java Ember rejects JVM argument files in extra JVM arguments", async (context) => {
  const argfile = await runPaperJavaEmber(context, {
    KILN_JAVA_ARGS: "-XX:+UseG1GC @/server/flags.txt",
  })
  assert.equal(argfile.status, 64, argfile.stderr)
  assert.match(
    argfile.stderr,
    /Java argument files are not allowed in KILN_JAVA_ARGS: @\/server\/flags.txt/u
  )
  assert.deepEqual(argfile.args, [])

  const optionsFile = await runPaperJavaEmber(context, {
    KILN_JAVA_ARGS: "-XX:VMOptionsFile=/server/flags.txt",
  })
  assert.equal(optionsFile.status, 64, optionsFile.stderr)
  assert.match(
    optionsFile.stderr,
    /Java argument files are not allowed in KILN_JAVA_ARGS: -XX:VMOptionsFile=\/server\/flags.txt/u
  )
  assert.deepEqual(optionsFile.args, [])
})

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
