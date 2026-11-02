import { relative, resolve } from "node:path"

import ts from "typescript"
import { describe, expect, it } from "vite-plus/test"

// Work enters the Relay's lanes through runOperation, or admits itself
// directly where its entry point owns the admission (docs/relay-operations.md).
// Each direct admission and each Semaphore below is a deliberate, reviewed
// choice with its purpose stated: a new one fails until it's listed, and a
// listed one that's gone fails until it's removed. It can't see a change
// that never enters the lanes at all.
const directAdmissions: Record<string, string> = {
  "control-socket.ts:ticket":
    "Hearth's requests, admitted as their frames arrive, with operation-plans.ts's locks",
  "browser-socket.ts:browser.console":
    "Browser console input, admitted as its frame arrives",
  "sftp-server.ts:inLane": "Each SFTP change, for that one request",
  "transfers/browser-files.ts:browser.file.upload":
    "Browser uploads, streamed beside other file work",
  "transfers/browser-files.ts:browser.file.upload.commit":
    "Nested; putting an upload in place under the files lock",
  "transfers/peer/sources.ts:transfer.source.pack":
    "Packing a transfer's source, beside other work as a backup reads",
  "transfers/peer/pulls.ts:transfer.pull.install":
    "Installing a transfer, alone as a restore does",
  "container-commands.ts:run": "Schedules' Command steps on databases and Apps",
  "resource-power.ts:scheduled":
    "Schedules' power steps, checked against the power intent in their turn",
  "runtime-recovery.ts:recovery.start":
    "Crash recovery's start, checked again in its turn",
  "runtime-recovery.ts:recovery.stop":
    "Crash recovery's stop of a server meant to be stopped",
  "docker.ts:quota.stop":
    "The disk-quota stop, apart from the scan, one per server",
  "provisioning.ts:refused":
    "The provisioning worker, holding each new instance for its whole create",
  "apps.ts:app.deployment":
    "The deployment worker, holding the App's lifecycle for the build",
  "apps.ts:app.allocations": "Nested; declared up front with deploys",
  "apps.ts:app.deployment.volumes": "Nested; declared up front with deploys",
  "lifecycle.ts:instance.allocations":
    "Nested; declared up front with game server changes",
  "lifecycle.ts:instance.dns":
    "Nested; the CoreDNS step of a game server's create, startup change, or deletion",
  "lifecycle.ts:tailscale.member.remove":
    "Nested; declared up front with deletion",
  "backups.ts:outcome":
    "The backup worker's tasks, withdrawn if cancelled while they wait",
  "backups.ts:backup.batch":
    "Stopped backup batches, stopping each App once for every member",
  "backups.ts:backup.coverage": "Nested; declared up front with backups",
  "backups.ts:backup.app.restart":
    "Starting, as the Relay starts, Apps a stopped backup still owes a start",
  "backups.ts:#settleTarRestore":
    "Recovering a restore whose swap didn't finish",
  "index.ts:inLane":
    "Schedules' console writes, and a database terminal until its session opens",
  "index.ts:withRoutesLock":
    "Nested; a deletion clearing its web routes, holding the routes only for that",
  "index.ts:platform.reconcile":
    "The platform worker's pass over Kiln's services",
  "index.ts:platform.restart": "Restarting Hearth once it has its answer",
  "index.ts:web.certificates.refresh":
    "The certificate worker, applying due certificates to the routes",
}

// Semaphores the Relay keeps for what lanes don't order: throughput,
// persistence order, or admission pressure. One that orders changes to a
// resource belongs in the lanes instead.
const semaphores: Record<string, string> = {
  "apps.ts:#registryLookups": "Bounds registry lookups",
  "docker.ts:#diskUsageSemaphore": "Bounds disk scans",
  "installation.ts:adoption": "Orders adopting an installation's metadata",
  "lifecycle.ts:#gamePortSemaphore":
    "Port leases outlive requests (docs/relay-operations.md)",
  "lifecycle.ts:#tailscaleDnsSemaphore":
    "Orders writing Tailscale's CoreDNS file, which starts refresh holding the routes only shared",
  "platform.ts:identifying": "Orders identifying Kiln's services",
  "runtime-recovery.ts:created": "Orders crash recovery's saved state",
  "schedules.ts:#semaphore": "Orders saving schedules",
  "schedules.ts:progressPermit": "Orders saving a run's progress",
  "security-inventory.ts:#permit": "Bounds inventory scans",
  "sftp-server.ts:changes":
    "One change per SFTP session waits at a time, so a client sending many can't fill the lanes",
  "system-updates.ts:#batchSemaphore": "Orders starting update batches",
  "transfers/peer/pulls.ts:#save": "Orders saving a transfer's record",
  "volumes.ts:#permits": "Bounds volume size scans",
}

const relayRoot = resolve(import.meta.dirname, "../..")
const sourceRoot = resolve(relayRoot, "src")
const runnerFile = resolve(sourceRoot, "operations/operation.ts")

describe("Relay operations", () => {
  const { program, checker } = loadProgram()
  const sources = program
    .getSourceFiles()
    .filter((file) => file.fileName.startsWith(sourceRoot))

  it("admits work to the lanes only through runOperation, but for the listed places", () => {
    const found = new Map<string, number>()
    for (const file of sources) {
      if (file.fileName === runnerFile) continue
      visit(file, (node) => {
        if (!ts.isCallExpression(node)) return
        const callee = node.expression
        if (!ts.isPropertyAccessExpression(callee)) return
        const method = callee.name.text
        if (method !== "run" && method !== "admit" && method !== "runNested")
          return
        if (!isLanes(checker.getTypeAtLocation(callee.expression))) return
        const id = `${relative(sourceRoot, file.fileName)}:${labelOf(node)}`
        found.set(id, (found.get(id) ?? 0) + 1)
      })
    }
    expect([...found.keys()].filter((id) => !(id in directAdmissions))).toEqual(
      []
    )
    expect(
      Object.keys(directAdmissions).filter((id) => !found.has(id))
    ).toEqual([])
  })

  it("keeps no semaphore of its own but the listed ones", () => {
    const found = new Set<string>()
    for (const file of sources) {
      visit(file, (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "Semaphore"
        ) {
          found.add(`${relative(sourceRoot, file.fileName)}:${ownerOf(node)}`)
        }
      })
    }
    expect([...found].filter((id) => !(id in semaphores))).toEqual([])
    expect(Object.keys(semaphores).filter((id) => !found.has(id))).toEqual([])
  })
})

function visit(node: ts.Node, each: (node: ts.Node) => void): void {
  each(node)
  ts.forEachChild(node, (child) => visit(child, each))
}

// The Relay's lanes, or the shared kernel they extend.
function isLanes(type: ts.Type): boolean {
  const name = type.getSymbol()?.getName()
  return name === "OperationLanes"
}

// The admission's label when it's written out, else the method it's in.
function labelOf(call: ts.CallExpression): string {
  const admission = call.arguments[0]
  if (admission && ts.isObjectLiteralExpression(admission)) {
    for (const property of admission.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "label" &&
        ts.isStringLiteralLike(property.initializer)
      ) {
        return property.initializer.text
      }
    }
  }
  return ownerOf(call)
}

// The function, method or property a node sits in.
function ownerOf(node: ts.Node): string {
  for (let at = node.parent; at; at = at.parent) {
    if (
      (ts.isFunctionDeclaration(at) ||
        ts.isMethodDeclaration(at) ||
        ts.isPropertyDeclaration(at) ||
        ts.isVariableDeclaration(at)) &&
      at.name &&
      (ts.isIdentifier(at.name) || ts.isPrivateIdentifier(at.name))
    ) {
      return at.name.text
    }
  }
  return "(module)"
}

function loadProgram() {
  const config = ts.getParsedCommandLineOfConfigFile(
    resolve(relayRoot, "tsconfig.json"),
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
  if (!config) throw new Error("Could not read apps/relay/tsconfig.json")
  const program = ts.createProgram({
    rootNames: config.fileNames.filter(
      (file) => file.startsWith(sourceRoot) && !/\.test\.ts$/.test(file)
    ),
    options: config.options,
  })
  return { program, checker: program.getTypeChecker() }
}
