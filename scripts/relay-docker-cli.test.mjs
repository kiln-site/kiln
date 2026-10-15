import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { relative } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "vite-plus/test"

import ts from "typescript"

// The Relay talks to Docker through the Engine API on its socket
// (apps/relay/src/docker-engine.ts), and runs only the standalone Compose
// and buildx binaries for app deployments; its image ships no docker CLI,
// so a process that runs one would fail on every real install. The image
// build itself fails if any other docker binary gets into it
// (apps/relay/Dockerfile); this catches the source that would need one.
const workspaceRoot = new URL("../", import.meta.url)
const relayRoot = new URL("apps/relay/", workspaceRoot)
// Node's process functions, and the wrappers Relay ran the CLI through.
const processFunctions = new Set([
  "command",
  "commandEffect",
  "commandLines",
  "commandWithInput",
  "exec",
  "execFile",
  "execFileSync",
  "executeFile",
  "execSync",
  "fork",
  "spawn",
  "runProcess",
  "spawnSync",
])
// A docker command: the binary, by name or path. `docker-compose` and
// `docker-buildx`, the standalone binaries, aren't the CLI.
const dockerCommand = /(?:^|\/|\s|[;&|`(])docker(?:\s|$)/u

test("Relay never runs the docker CLI", async () => {
  const violations = (
    await Promise.all(
      (await relayFiles(relayRoot)).map(async (file) => {
        const path = relative(fileURLToPath(workspaceRoot), fileURLToPath(file))
        const source = await readFile(file, "utf8")
        return path.endsWith(".sh")
          ? inspectShell(path, source)
          : inspectSource(path, source)
      })
    )
  ).flat()

  assert.deepEqual(
    violations,
    [],
    [
      "Relay must use the Docker Engine API (docker-engine.ts), not the docker CLI:",
      ...violations.map(({ file, line, text }) => `  ${file}:${line} ${text}`),
    ].join("\n")
  )
})

test("the Relay's images, released and in development, install no docker CLI", async () => {
  for (const file of ["apps/relay/Dockerfile", "compose.dev.yaml"]) {
    const text = await readFile(new URL(file, workspaceRoot), "utf8")
    // An image built from or copying from Docker's CLI images, a package
    // install of Docker, or a download of its static CLI.
    assert.doesNotMatch(
      text,
      /^\s*(?:FROM|COPY)\b[^\n]*\bdocker:|^[^#\n]*\b(?:apk add|apt-get install|apt install|dnf install|yum install)\b[^\n]*\bdocker|^[^#\n]*\bdownload\.docker\.com|^[^#\n]*\/docker-\d[^\n]*\.tgz/mu,
      `${file} installs the docker CLI`
    )
  }
})

test("CLI detection catches the ways to start a process", () => {
  assert.deepEqual(
    inspectSource(
      "example.ts",
      [
        'spawn("docker", ["ps"])',
        'execFile("/usr/local/bin/docker", ["pull", image])',
        'childProcess.spawnSync("docker-compose", ["up"])',
        'spawn("sh", ["-c", "docker run --rm alpine"])',
        'spawn("/usr/local/libexec/docker/cli-plugins/docker-buildx", ["build"])',
        'spawn("restic", ["snapshots"])',
        'engine.exec(container, ["docker", "ps"])',
        'import { spawn as launch } from "node:child_process"',
        'launch("docker", ["ps"])',
        'const binary = "docker"',
        'spawn(binary, ["ps"])',
        "exec(`docker ${args.join(\" \")}`)",
        'spawn("sh", ["-c", `docker run ${image}`])',
        'import * as processes from "child_process"',
        'processes.execSync("docker info")',
      ].join("\n")
    ).map(({ line }) => line),
    [1, 2, 4, 9, 11, 12, 13, 15]
  )
  assert.deepEqual(
    inspectShell(
      "example.sh",
      [
        "#!/bin/sh",
        "# docker is not used here",
        "docker ps",
        'out=$(docker inspect "$1")',
        "restic snapshots && docker pull alpine",
        'echo "docker"',
        "docker-compose up --detach",
      ].join("\n")
    ).map(({ line }) => line),
    [3, 4, 5]
  )
})

async function relayFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const location = new URL(
        `${entry.name}${entry.isDirectory() ? "/" : ""}`,
        directory
      )
      if (entry.isDirectory()) {
        return ["dist", "node_modules", "test"].includes(entry.name)
          ? []
          : relayFiles(location)
      }
      return /\.(?:[cm]?[jt]s|sh)$/u.test(entry.name) &&
        !/\.test\.[cm]?[jt]s$/u.test(entry.name)
        ? [location]
        : []
    })
  )
  return files.flat()
}

// Shell commands that run docker: at the start of a command, after `;`,
// `&&`, `||`, `|`, or in `$(…)` or backticks. Comments don't count.
function inspectShell(path, source) {
  return source.split("\n").flatMap((text, index) => {
    const code = text.replace(/(^|\s)#.*$/u, "")
    return /(?:^|[;&|`]|\$\()\s*(?:sudo\s+)?docker(?:\s|$)/u.test(code)
      ? [{ file: path, line: index + 1, text: text.trim().slice(0, 80) }]
      : []
  })
}

function inspectSource(path, source) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS
  )
  const violations = []
  // Names Node's process functions are imported under, and namespaces
  // child_process is imported as.
  const functions = new Set(processFunctions)
  const namespaces = new Set(["childProcess", "child_process", "childprocess", "cp"])
  // String constants, so `spawn(binary)` sees what `binary` holds.
  const constants = new Map()

  const textOf = (node) => {
    if (!node) return undefined
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text
    }
    if (ts.isTemplateExpression(node)) {
      // The literal parts, with something in place of each substitution.
      return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" x ")
    }
    if (ts.isIdentifier(node)) return constants.get(node.text)
    return undefined
  }
  const runsDocker = (node) => {
    const text = textOf(node)
    return text !== undefined && dockerCommand.test(text)
  }

  function collect(node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^(?:node:)?child_process$/u.test(node.moduleSpecifier.text)
    ) {
      const clause = node.importClause
      if (clause?.name) namespaces.add(clause.name.text)
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) functions.add(element.name.text)
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isStringLiteral(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer))
    ) {
      constants.set(node.name.text, node.initializer.text)
    }
    ts.forEachChild(node, collect)
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      // `child_process.spawn(…)` or an imported `spawn(…)`; other objects'
      // methods, such as an exec in a container, don't start a process here.
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? ts.isIdentifier(node.expression.expression) &&
          namespaces.has(node.expression.expression.text)
          ? node.expression.name.text
          : null
        : ts.isIdentifier(node.expression)
          ? node.expression.text
          : null
      if (callee && (functions.has(callee) || processFunctions.has(callee))) {
        const [program, args] = node.arguments
        const shellScript =
          args && ts.isArrayLiteralExpression(args)
            ? args.elements.some(runsDocker)
            : false
        if (runsDocker(program) || shellScript) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart()
          )
          violations.push({
            file: path,
            line: line + 1,
            text: node.getText().slice(0, 80),
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  collect(sourceFile)
  visit(sourceFile)
  return violations
}
