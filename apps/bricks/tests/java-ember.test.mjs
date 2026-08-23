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

const fakeJavaScript = `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "-version" ]]; then
  echo 'openjdk version "test"' >&2
  exit 0
fi
printf '%s\\n' "$@" > "$FAKE_JAVA_ARGUMENTS"
`

async function runPaperJavaEmber(context, envOverrides = {}) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "kiln-java-ember-"))
  context.after(() => rm(temporaryDirectory, { force: true, recursive: true }))

  const binDirectory = join(temporaryDirectory, "bin")
  const argumentsPath = join(temporaryDirectory, "java-arguments")
  await Promise.all([
    mkdir(binDirectory, { recursive: true }),
    writeFile(join(temporaryDirectory, "paper.jar"), "complete artifact"),
  ])
  await writeFile(join(binDirectory, "java"), fakeJavaScript)
  await chmod(join(binDirectory, "java"), 0o755)

  const source = await readFile(join(root, "embers/java/entrypoint.sh"), "utf8")
  const entrypointPath = join(temporaryDirectory, "entrypoint.sh")
  await writeFile(
    entrypointPath,
    source.replace("cd /server", 'cd "${KILN_TEST_SERVER_DIRECTORY:?}"')
  )
  await chmod(entrypointPath, 0o755)

  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn(entrypointPath, {
      env: {
        FAKE_JAVA_ARGUMENTS: argumentsPath,
        KILN_ARTIFACT_FILE: "paper.jar",
        KILN_ARTIFACT_URL: "https://example.invalid/paper.jar",
        KILN_IMPLEMENTATION: "paper",
        KILN_SERVER_KIND: "minecraft",
        KILN_TEST_SERVER_DIRECTORY: temporaryDirectory,
        KILN_VERSION: "1.21.11",
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk
    })
    child.once("error", rejectResult)
    child.once("close", (status) => resolveResult({ status, stderr }))
  })

  let args = []
  try {
    const text = (await readFile(argumentsPath, "utf8")).trimEnd()
    args = text === "" ? [] : text.split("\n")
  } catch {
    args = []
  }

  return { ...result, args }
}

test("the Java Ember jlink runtime includes the Java SE API set", async () => {
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
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "kiln-java-ember-"))
  context.after(() => rm(temporaryDirectory, { force: true, recursive: true }))

  const binDirectory = join(temporaryDirectory, "bin")
  const serverDirectory = join(temporaryDirectory, "server")
  const argumentsPath = join(temporaryDirectory, "curl-arguments")
  await Promise.all([
    mkdir(binDirectory, { recursive: true }),
    mkdir(serverDirectory, { recursive: true }),
  ])

  const curlPath = join(binDirectory, "curl")
  await writeFile(
    curlPath,
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$@" > "$FAKE_CURL_ARGUMENTS"
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
  await chmod(curlPath, 0o755)

  const source = await readFile(join(root, "embers/java/entrypoint.sh"), "utf8")
  const entrypointPath = join(temporaryDirectory, "entrypoint.sh")
  await writeFile(
    entrypointPath,
    source.replace("cd /server", 'cd "${KILN_TEST_SERVER_DIRECTORY:?}"')
  )
  await chmod(entrypointPath, 0o755)

  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn(entrypointPath, {
      env: {
        ...process.env,
        FAKE_CURL_ARGUMENTS: argumentsPath,
        KILN_ARTIFACT_FILE: "paper.jar",
        KILN_ARTIFACT_URL: "https://example.invalid/paper.jar",
        KILN_IMPLEMENTATION: "paper",
        KILN_INSTALLATION_MARKER: ".kiln-ember-installed",
        KILN_TEST_SERVER_DIRECTORY: serverDirectory,
        KILN_VERSION: "1.21.11",
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
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
    child.once("close", (status) => resolveResult({ status, stderr, stdout }))
  })

  assert.equal(result.status, 7)
  assert.match(result.stdout, /\[Kiln Ember\] downloading paper 1\.21\.11/u)
  assert.match(result.stderr, /curl: \(7\) simulated network failure/u)
  assert.match(
    result.stderr,
    /failed to download paper 1\.21\.11 after 3 attempts\. Server startup failed\. Swap to a different Brick in Startup, or contact support if this keeps happening\./u
  )
  await assert.rejects(readFile(join(serverDirectory, ".paper.jar.download")), {
    code: "ENOENT",
  })
  await assert.rejects(
    readFile(join(serverDirectory, ".kiln-ember-installed")),
    { code: "ENOENT" }
  )

  const curlArguments = (await readFile(argumentsPath, "utf8")).split("\n")
  assert.ok(curlArguments.includes("--no-progress-meter"))
  assert.deepEqual(
    curlArguments.slice(
      curlArguments.indexOf("--retry"),
      curlArguments.indexOf("--retry") + 2
    ),
    ["--retry", "2"]
  )
})

test("the Java Ember writes the installation marker before starting the server", async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "kiln-java-ember-"))
  context.after(() => rm(temporaryDirectory, { force: true, recursive: true }))

  const binDirectory = join(temporaryDirectory, "bin")
  const serverDirectory = join(temporaryDirectory, "server")
  await Promise.all([
    mkdir(binDirectory, { recursive: true }),
    mkdir(serverDirectory, { recursive: true }),
  ])

  const curlPath = join(binDirectory, "curl")
  await writeFile(
    curlPath,
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
  await chmod(curlPath, 0o755)

  const javaPath = join(binDirectory, "java")
  await writeFile(
    javaPath,
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
  await chmod(javaPath, 0o755)

  const source = await readFile(join(root, "embers/java/entrypoint.sh"), "utf8")
  const entrypointPath = join(temporaryDirectory, "entrypoint.sh")
  await writeFile(
    entrypointPath,
    source.replace("cd /server", 'cd "${KILN_TEST_SERVER_DIRECTORY:?}"')
  )
  await chmod(entrypointPath, 0o755)

  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn(entrypointPath, {
      env: {
        ...process.env,
        KILN_ARTIFACT_FILE: "paper.jar",
        KILN_ARTIFACT_URL: "https://example.invalid/paper.jar",
        KILN_IMPLEMENTATION: "paper",
        KILN_INSTALLATION_MARKER: ".kiln-ember-installed",
        KILN_TEST_SERVER_DIRECTORY: serverDirectory,
        KILN_VERSION: "1.21.11",
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
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
    child.once("close", (status) => resolveResult({ status, stderr, stdout }))
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /fake server started/u)
  assert.equal(
    await readFile(join(serverDirectory, ".kiln-ember-installed"), "utf8"),
    ""
  )
  assert.equal(
    await readFile(join(serverDirectory, "eula.txt"), "utf8"),
    "eula=true\n"
  )
  assert.doesNotMatch(
    await readFile(join(serverDirectory, "server.properties"), "utf8"),
    /^online-mode=/mu
  )
})

test("the Java Ember distinguishes unset and empty server arguments", async (context) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "kiln-java-ember-"))
  context.after(() => rm(temporaryDirectory, { force: true, recursive: true }))

  const binDirectory = join(temporaryDirectory, "bin")
  await Promise.all([
    mkdir(binDirectory, { recursive: true }),
    writeFile(join(temporaryDirectory, "velocity.jar"), "complete artifact"),
  ])

  const javaPath = join(binDirectory, "java")
  await writeFile(
    javaPath,
    `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "-version" ]]; then
  echo 'openjdk version "test"' >&2
  exit 0
fi
printf '%s\n' "$@" > "$FAKE_JAVA_ARGUMENTS"
`
  )
  await chmod(javaPath, 0o755)

  const source = await readFile(join(root, "embers/java/entrypoint.sh"), "utf8")
  const entrypointPath = join(temporaryDirectory, "entrypoint.sh")
  await writeFile(
    entrypointPath,
    source.replace("cd /server", 'cd "${KILN_TEST_SERVER_DIRECTORY:?}"')
  )
  await chmod(entrypointPath, 0o755)

  const runEmber = async (name, serverArguments) => {
    const argumentsPath = join(temporaryDirectory, `${name}-arguments`)
    const environment = {
      FAKE_JAVA_ARGUMENTS: argumentsPath,
      KILN_ARTIFACT_FILE: "velocity.jar",
      KILN_ARTIFACT_URL: "https://example.invalid/velocity.jar",
      KILN_IMPLEMENTATION: "velocity",
      KILN_SERVER_KIND: "application",
      KILN_TEST_SERVER_DIRECTORY: temporaryDirectory,
      KILN_VERSION: "3.5.1",
      PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
    }
    if (serverArguments !== undefined) {
      environment.KILN_SERVER_ARGS = serverArguments
    }

    const result = await new Promise((resolveResult, rejectResult) => {
      const child = spawn(entrypointPath, {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stderr = ""
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk
      })
      child.once("error", rejectResult)
      child.once("close", (status) => resolveResult({ status, stderr }))
    })

    assert.equal(result.status, 0, result.stderr)
    return (await readFile(argumentsPath, "utf8")).trimEnd().split("\n")
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
  await assert.rejects(
    readFile(join(temporaryDirectory, "server.properties")),
    {
      code: "ENOENT",
    }
  )
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
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "kiln-java-ember-"))
  context.after(() => rm(temporaryDirectory, { force: true, recursive: true }))

  const serverDirectory = join(temporaryDirectory, "server")
  await mkdir(serverDirectory, { recursive: true })
  await writeFile(join(serverDirectory, "paper.jar"), "keep me")

  const source = await readFile(join(root, "embers/java/entrypoint.sh"), "utf8")
  const entrypointPath = join(temporaryDirectory, "entrypoint.sh")
  await writeFile(
    entrypointPath,
    source.replace("cd /server", 'cd "${KILN_TEST_SERVER_DIRECTORY:?}"')
  )
  await chmod(entrypointPath, 0o755)

  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn(entrypointPath, {
      env: {
        ...process.env,
        KILN_ARTIFACT_FILE: "paper.jar",
        KILN_ARTIFACT_URL: "https://example.invalid/paper.jar",
        KILN_INSTALLATION_MARKER: "paper.jar",
        KILN_TEST_SERVER_DIRECTORY: serverDirectory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk
    })
    child.once("error", rejectResult)
    child.once("close", (status) => resolveResult({ status, stderr }))
  })

  assert.equal(result.status, 64)
  assert.match(result.stderr, /must be a reserved \.kiln-\* filename/u)
  assert.equal(
    await readFile(join(serverDirectory, "paper.jar"), "utf8"),
    "keep me"
  )
})
