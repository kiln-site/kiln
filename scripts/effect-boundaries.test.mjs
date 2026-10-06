import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { relative } from "node:path"
import { test } from "vite-plus/test"
import { fileURLToPath } from "node:url"

import ts from "typescript"

const workspaceRoot = new URL("../", import.meta.url)
const sourceRoots = ["apps", "packages"]
const staticEffectNamespaces = new Set(["Effect", "Result", "Schema", "Stream"])

test("production TypeScript uses Effect recovery boundaries", async () => {
  const files = (
    await Promise.all(
      sourceRoots.map((root) =>
        collectTypeScriptFiles(new URL(`${root}/`, workspaceRoot))
      )
    )
  ).flat()
  const violations = (
    await Promise.all(files.map((file) => inspectFile(file)))
  ).flat()

  assert.deepEqual(
    violations,
    [],
    [
      "Production TypeScript must use Effect/Result recovery instead of raw",
      "try statements or Promise .catch/.finally chains:",
      ...violations.map(
        ({ file, line, message }) => `  ${file}:${line} ${message}`
      ),
    ].join("\n")
  )
})

test("boundary inspection catches Promise rejection handlers", () => {
  assert.deepEqual(
    inspectSource(
      "example.ts",
      [
        "pending.then(onFulfilled, onRejected)",
        "pending.then(onFulfilled)",
        "Effect.catch(onRejected)",
      ].join("\n")
    ),
    [
      {
        file: "example.ts",
        line: 1,
        message: "Promise-style .then(_, onRejected)",
      },
    ]
  )
})

async function collectTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const location = new URL(
        `${entry.name}${entry.isDirectory() ? "/" : ""}`,
        directory
      )
      if (entry.isDirectory()) {
        if (
          // `test/` holds shared test fakes and fixtures, not production code.
          ["node_modules", "dist", ".tanstack", ".output", "test"].includes(
            entry.name
          )
        )
          return []
        return collectTypeScriptFiles(location)
      }
      return isProductionTypeScript(entry.name) ? [location] : []
    })
  )
  return files.flat()
}

function isProductionTypeScript(name) {
  return (
    /\.(?:ts|tsx)$/u.test(name) &&
    !/\.(?:test|spec)\.(?:ts|tsx)$/u.test(name) &&
    name !== "instrument.ts"
  )
}

async function inspectFile(file) {
  const path = fileURLToWorkspacePath(file)
  const source = await readFile(file, "utf8")
  return inspectSource(path, source)
}

function inspectSource(path, source) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const violations = []

  function report(node, message) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
    violations.push({ file: path, line: line + 1, message })
  }

  function visit(node) {
    if (ts.isTryStatement(node)) {
      report(node, "raw try statement")
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text
      const receiver = node.expression.expression
      const isStaticEffectOperator =
        ts.isIdentifier(receiver) &&
        staticEffectNamespaces.has(receiver.text) &&
        method === "catch"
      if (
        (method === "catch" || method === "finally") &&
        !isStaticEffectOperator
      ) {
        report(node, `Promise-style .${method}()`)
      }
      if (method === "then" && node.arguments.length >= 2) {
        report(node, "Promise-style .then(_, onRejected)")
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

function fileURLToWorkspacePath(file) {
  return relative(fileURLToPath(workspaceRoot), fileURLToPath(file))
}
