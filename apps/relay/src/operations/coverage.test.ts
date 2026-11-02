import { relative, resolve } from "node:path"

import ts from "typescript"
import { describe, expect, it } from "vite-plus/test"

// New Relay work is an operation (docs/relay-operations.md): runOperation
// admits it to the lanes, so a feature names what it changes rather than
// taking its turn by hand or keeping a lock of its own. These are the places
// that still do, each until its area moves to operation(); the list only
// shrinks.
const directAdmissions: Record<string, string> = {
  "control-socket.ts:ticket":
    "Hearth's requests, by operation-plans.ts, until each area moves",
  "browser-socket.ts:browser.console": "Browser console, until sessions move",
  "sftp-server.ts:inLane": "SFTP, until file entry points move",
  "transfers/browser-files.ts:browser.file.upload":
    "Browser uploads, until file entry points move",
  "transfers/browser-files.ts:browser.file.upload.commit":
    "Nested; putting an upload in place, until file entry points move",
  "transfers/peer/sources.ts:transfer.source.pack": "Until transfers move",
  "transfers/peer/pulls.ts:transfer.pull.install": "Until transfers move",
  "container-commands.ts:run": "Scheduled commands, until schedules move",
  "resource-power.ts:scheduled": "Scheduled power, until schedules move",
  "runtime-recovery.ts:recovery.start": "Until crash recovery moves",
  "runtime-recovery.ts:recovery.stop": "Until crash recovery moves",
  "docker.ts:quota.stop": "Disk-quota stops, until the workers move",
  "provisioning.ts:refused": "Provisioning, until the workers move",
  "apps.ts:app.deployment": "Deployments, until the workers move",
  "apps.ts:app.allocations": "Nested; declared up front with deploys",
  "apps.ts:app.deployment.volumes": "Nested; declared up front with deploys",
  "lifecycle.ts:instance.allocations":
    "Nested; declared up front with game server changes",
  "lifecycle.ts:tailscale.member.remove":
    "Nested; declared up front with deletion",
  "backups.ts:outcome": "Backup tasks, until backups move",
  "backups.ts:backup.batch": "Backup batches, until backups move",
  "backups.ts:backup.coverage": "Nested; declared up front with backups",
  "backups.ts:backup.app.restart": "Until backups move",
  "backups.ts:#settleTarRestore": "Restore recovery, until backups move",
  "index.ts:inLane": "Hearth's requests' follow-ups, until each area moves",
  "index.ts:withRoutesLock": "Nested; declared up front with deletion",
  "index.ts:platform.reconcile": "Platform passes, until the workers move",
  "index.ts:platform.restart": "Until platform actions move",
  "index.ts:web.certificates.refresh": "Until the workers move",
}

// Semaphores the Relay keeps that guard something lanes can't: throughput,
// persistence order, or state shared with other processes. A new one that
// orders changes to a resource belongs in the lanes instead.
const semaphores: Record<string, string> = {
  "apps.ts:#registryLookups": "Bounds registry lookups",
  "docker.ts:#diskUsageSemaphore": "Bounds disk scans",
  "installation.ts:adoption": "Orders adopting an installation's metadata",
  "lifecycle.ts:#gamePortSemaphore":
    "Port leases outlive requests (docs/relay-operations.md)",
  "lifecycle.ts:#tailscaleDnsSemaphore":
    "Until every CoreDNS writer runs in the lanes",
  "platform.ts:identifying": "Orders identifying Kiln's services",
  "runtime-recovery.ts:created": "Orders crash recovery's saved state",
  "schedules.ts:#semaphore": "Orders saving schedules",
  "schedules.ts:progressPermit": "Orders saving a run's progress",
  "security-inventory.ts:#permit": "Bounds inventory scans",
  "sftp-server.ts:changes":
    "One change per SFTP session waits at a time, so a client sending many can't fill the lanes",
  "system-updates.ts:#batchSemaphore":
    "Orders starting update batches, until restarts and updates move",
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
