import { resolve } from "node:path"

import ts from "typescript"
import { describe, expect, it } from "vite-plus/test"

// Every server function is reachable by anyone who can send an HTTP request,
// so each handler must reach one of the session checks in `server/auth.ts`
// (directly or through the helpers it calls). Endpoints that are public on
// purpose are listed here with the reason.
const publicServerFunctions: Record<string, string> = {
  "auth.ts:getAuthState": "Tells signed-out visitors whether setup is done",
  "auth.ts:createInitialAdministrator":
    "First-run setup; refuses once an administrator exists",
  "auth.ts:replacePendingAccountEmail":
    "Checks the account password before changing an unverified email",
  "auth.ts:enableDevelopmentBypass": "Refuses unless the dev bypass is enabled",
  "auth.ts:disableDevelopmentBypass": "Only clears the dev bypass cookie",
  "runtime-config.ts:getPublicRuntimeConfig":
    "Returns the public Git repository",
  "users.ts:requestAccountClaim": "Signed-out account claim, rate limited",
  "users.ts:prepareAccountSignup": "Signed-out sign-up check, rate limited",
  "users.ts:getAccountClaimPreview": "Authorized by the emailed claim token",
  "users.ts:claimAccount": "Authorized by the emailed claim token",
  "backup-downloads.ts:getBackupDownloadShare":
    "Authorized by the unguessable share link",
}

// Mutating CLI API calls that read-only CLI links may still make.
const readOnlyCliCalls: Record<string, string> = {
  getCliBackupDownloadEffect: "Prepares a download link; reads only",
  revokeCliCredentialEffect: "Signs this CLI out",
}

// The session checks every handler must reach.
const sessionChecks = new Set([
  "getCurrentUser",
  "requireAuthenticatedUser",
  "requireAuthenticatedIdentity",
  "requireVerifiedUser",
  "requireEligibleResourceUser",
  "requireEligibleResourceIdentity",
])

const webRoot = resolve(import.meta.dirname, "../..")
const authFile = resolve(webRoot, "src/server/auth.ts")
const cliAccessFile = resolve(webRoot, "src/effect/cli-access.ts")
const cliRouteFile = resolve(webRoot, "src/routes/api.cli.v1.$.ts")

describe("API authentication", () => {
  const { program, checker } = loadProgram()

  it("authenticates every server function", { timeout: 60_000 }, () => {
    const reaches = reachabilityChecker(checker, isSessionCheck)
    const handlers = serverFunctionHandlers(program)
    expect(handlers.length).toBeGreaterThan(100)

    const unauthenticated = handlers
      .filter(
        ({ id, handler }) => !(id in publicServerFunctions) && !reaches(handler)
      )
      .map(({ id }) => id)
    expect(unauthenticated).toEqual([])

    const stale = Object.keys(publicServerFunctions).filter(
      (id) => !handlers.some((handler) => handler.id === id)
    )
    expect(stale).toEqual([])
  })

  it(
    "does not count a guard that is only imported",
    { timeout: 60_000 },
    () => {
      const fixture = resolve(webRoot, "src/server/auth-coverage-fixture.ts")
      const fixtureProgram = loadProgram({
        [fixture]: `
        import { createServerFn } from "@tanstack/react-start"
        import { requireVerifiedUser as staticGuard } from "@/server/auth"

        export const destructured = createServerFn({ method: "POST" }).handler(
          async () => {
            const { requireVerifiedUser } = await import("@/server/auth")
            return null
          }
        )
        export const renamed = createServerFn({ method: "POST" }).handler(
          async () => {
            const { requireVerifiedUser: guard } = await import("@/server/auth")
            return null
          }
        )
        export const staticOnly = createServerFn({ method: "POST" }).handler(
          async () => null
        )
        export const called = createServerFn({ method: "POST" }).handler(
          async () => {
            const { requireVerifiedUser } = await import("@/server/auth")
            return requireVerifiedUser()
          }
        )
        export const calledStatic = createServerFn({ method: "POST" }).handler(
          async () => staticGuard()
        )
      `,
      })
      const reaches = reachabilityChecker(
        fixtureProgram.checker,
        isSessionCheck
      )
      const results = Object.fromEntries(
        serverFunctionHandlers(fixtureProgram.program)
          .filter(({ id }) => id.startsWith("auth-coverage-fixture.ts:"))
          .map(({ id, handler }) => [id.split(":")[1], reaches(handler)])
      )
      expect(results).toEqual({
        destructured: false,
        renamed: false,
        staticOnly: false,
        called: true,
        calledStatic: true,
      })
    }
  )

  // Read-only CLI links must not change anything, so every Effect the CLI
  // API runs for POST, PUT, PATCH, or DELETE must reach `requireCliWrite`.
  it("refuses read-only CLI links on mutating endpoints", () => {
    const reaches = reachabilityChecker(checker, isCliWriteCheck)
    const calls = mutatingCliCalls(program, checker)
    expect(calls.length).toBeGreaterThan(5)

    const unchecked = calls
      .filter(
        ({ name, declaration }) =>
          !(name in readOnlyCliCalls) && !reaches(declaration)
      )
      .map(({ name }) => name)
    expect(unchecked).toEqual([])
  })
})

function loadProgram(virtualFiles: Record<string, string> = {}) {
  const configPath = resolve(webRoot, "tsconfig.json")
  const config = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        )
      },
    }
  )
  if (!config) throw new Error("Could not read apps/web/tsconfig.json")
  const host = ts.createCompilerHost(config.options)
  const { fileExists, getSourceFile, readFile } = host
  host.fileExists = (file) => file in virtualFiles || fileExists(file)
  host.readFile = (file) => virtualFiles[file] ?? readFile(file)
  host.getSourceFile = (file, language, ...rest) =>
    file in virtualFiles
      ? ts.createSourceFile(file, virtualFiles[file], language, true)
      : getSourceFile(file, language, ...rest)
  const virtualNames = Object.keys(virtualFiles)
  const program = ts.createProgram({
    rootNames: virtualNames.length
      ? virtualNames
      : config.fileNames.filter(
          (file) => file.includes("/src/") && !/\.test\.tsx?$/.test(file)
        ),
    options: config.options,
    host,
  })
  return { program, checker: program.getTypeChecker() }
}

interface ServerFunctionHandler {
  readonly id: string
  readonly handler: ts.Node
}

function serverFunctionHandlers(program: ts.Program) {
  const handlers: Array<ServerFunctionHandler> = []
  for (const file of program.getSourceFiles()) {
    if (
      file.isDeclarationFile ||
      !file.fileName.startsWith(resolve(webRoot, "src"))
    ) {
      continue
    }
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        createsServerFunction(node.initializer)
      ) {
        const handler = handlerArgument(node.initializer)
        if (!handler) throw new Error(`${node.name.text} has no handler`)
        handlers.push({
          id: `${file.fileName.split("/").at(-1)}:${node.name.text}`,
          handler,
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return handlers
}

function createsServerFunction(node: ts.Expression): boolean {
  if (ts.isCallExpression(node)) {
    if (ts.isIdentifier(node.expression)) {
      return node.expression.text === "createServerFn"
    }
    return createsServerFunction(node.expression)
  }
  if (ts.isPropertyAccessExpression(node)) {
    return createsServerFunction(node.expression)
  }
  return false
}

// `createServerFn(...).validator(...).handler(fn)` → fn
function handlerArgument(node: ts.Expression): ts.Node | undefined {
  if (!ts.isCallExpression(node)) return undefined
  const callee = node.expression
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "handler") {
    return node.arguments[0]
  }
  return ts.isPropertyAccessExpression(callee)
    ? handlerArgument(callee.expression)
    : undefined
}

// Effects from other modules called by the CLI route's mutating handlers.
function mutatingCliCalls(program: ts.Program, checker: ts.TypeChecker) {
  const route = program.getSourceFile(cliRouteFile)
  if (!route) throw new Error("Missing the CLI API route")
  const calls = new Map<string, ts.Node>()
  const visitHandler = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      let symbol = checker.getSymbolAtLocation(node.expression)
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
        symbol = checker.getAliasedSymbol(symbol)
      }
      const declaration = symbol?.declarations?.[0]
      if (
        declaration &&
        node.expression.text.endsWith("Effect") &&
        declaration.getSourceFile() !== route &&
        isSourceDeclaration(declaration)
      ) {
        calls.set(node.expression.text, declaration)
      }
    }
    ts.forEachChild(node, visitHandler)
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(node.name.text)
    ) {
      visitHandler(node.initializer)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(route)
  return [...calls].map(([name, declaration]) => ({ name, declaration }))
}

// Whether code reaches a target declaration through the functions it
// references, following imports (including `await import(...)`
// destructuring) across the app's source.
function reachabilityChecker(
  checker: ts.TypeChecker,
  isTarget: (declaration: ts.Node) => boolean
) {
  const memo = new Map<ts.Node, boolean>()

  const reaches = (root: ts.Node): boolean => {
    const cached = memo.get(root)
    if (cached !== undefined) return cached
    memo.set(root, false)
    let found = false
    const visit = (node: ts.Node) => {
      if (found) return
      if (ts.isIdentifier(node)) {
        for (const declaration of declarationsOf(node)) {
          if (isTarget(declaration) || reaches(declaration)) {
            found = true
            return
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(root)
    memo.set(root, found)
    return found
  }

  const declarationsOf = (identifier: ts.Identifier): Array<ts.Node> => {
    // Only follow references. A guard that is destructured or imported but
    // never used must not count as reaching it.
    if (isDeclarationName(identifier)) return []
    let symbol = checker.getSymbolAtLocation(identifier)
    if (!symbol) return []
    if (symbol.flags & ts.SymbolFlags.Alias)
      symbol = checker.getAliasedSymbol(symbol)
    return (symbol.declarations ?? []).flatMap((declaration) => {
      if (ts.isBindingElement(declaration)) {
        return dynamicImportExport(declaration)
      }
      return isSourceDeclaration(declaration) ? [declaration] : []
    })
  }

  // `const { name } = await import("@/x")`, or one entry of
  // `const [{ name }] = await Promise.all([import("@/x")])` → the export.
  const dynamicImportExport = (element: ts.BindingElement): Array<ts.Node> => {
    const importCall = dynamicImportFor(element.parent)
    if (!importCall) return []
    const moduleSymbol = checker.getSymbolAtLocation(importCall.arguments[0])
    if (!moduleSymbol) return []
    const exportName = (element.propertyName ?? element.name) as ts.Identifier
    let exported = checker
      .getExportsOfModule(moduleSymbol)
      .find((symbol) => symbol.name === exportName.text)
    if (!exported) return []
    if (exported.flags & ts.SymbolFlags.Alias) {
      exported = checker.getAliasedSymbol(exported)
    }
    return (exported.declarations ?? []).filter(isSourceDeclaration)
  }

  return reaches
}

function dynamicImportFor(
  pattern: ts.BindingPattern
): ts.CallExpression | undefined {
  const owner = pattern.parent
  if (ts.isVariableDeclaration(owner) && owner.initializer) {
    const value = awaited(owner.initializer)
    return isDynamicImport(value) ? value : undefined
  }
  if (ts.isBindingElement(owner) && ts.isArrayBindingPattern(owner.parent)) {
    const declaration = owner.parent.parent
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      return undefined
    }
    const all = awaited(declaration.initializer)
    const entries = ts.isCallExpression(all) ? all.arguments[0] : undefined
    if (!entries || !ts.isArrayLiteralExpression(entries)) return undefined
    const entry = entries.elements[owner.parent.elements.indexOf(owner)]
    return entry && isDynamicImport(entry) ? entry : undefined
  }
  return undefined
}

function awaited(expression: ts.Expression) {
  return ts.isAwaitExpression(expression) ? expression.expression : expression
}

function isDynamicImport(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  )
}

function isSourceDeclaration(node: ts.Node) {
  const file = node.getSourceFile()
  return (
    !file.isDeclarationFile && file.fileName.startsWith(resolve(webRoot, "src"))
  )
}

function isSessionCheck(declaration: ts.Node) {
  return (
    declaration.getSourceFile().fileName === authFile &&
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    sessionChecks.has(declaration.name.text)
  )
}

function isDeclarationName(identifier: ts.Identifier) {
  const parent = identifier.parent
  if (
    ts.isBindingElement(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent)
  ) {
    return parent.name === identifier || parent.propertyName === identifier
  }
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isPropertyAccessExpression(parent)
  ) {
    return parent.name === identifier
  }
  return false
}

function isCliWriteCheck(declaration: ts.Node) {
  return (
    declaration.getSourceFile().fileName === cliAccessFile &&
    ts.isFunctionDeclaration(declaration) &&
    declaration.name?.text === "requireCliWrite"
  )
}
