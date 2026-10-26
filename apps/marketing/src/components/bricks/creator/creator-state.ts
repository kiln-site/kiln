import { Result } from "effect"

import {
  BRICK_V2_FORMAT,
  BRICK_V2_SCHEMA_URL,
  type BrickV2,
  type BrickV2Deploy,
  type BrickV2DeployType,
  type BrickV2Kind,
  brickV2Schema,
} from "@workspace/contracts"

import { formatBrickJson } from "~/lib/bricks"

// The creator edits one Brick two ways: the form and its JSON. The form
// always holds a Brick shaped well enough to draw; JSON typed by hand is
// taken into it once it parses into that shape, and until then the form
// keeps the last one that did.

export interface CreatorState {
  brick: BrickV2
  text: string
  // Why the JSON isn't in the form yet.
  textProblem: string | null
}

export type CreatorAction =
  | { type: "replace"; brick: BrickV2 }
  | { type: "edit"; update: (brick: BrickV2) => BrickV2 }
  | { type: "text"; text: string }

export function creatorState(brick: BrickV2): CreatorState {
  const pruned = prune(brick) as BrickV2
  return { brick: pruned, text: formatBrickJson(pruned), textProblem: null }
}

export function creatorReducer(
  state: CreatorState,
  action: CreatorAction
): CreatorState {
  if (action.type === "replace") return creatorState(action.brick)
  if (action.type === "edit") {
    return creatorState(action.update(state.brick))
  }
  const read = readBrickText(action.text)
  return read.brick
    ? { brick: read.brick, text: action.text, textProblem: null }
    : { ...state, text: action.text, textProblem: read.problem }
}

// Problems that leave a value the form can't show, as opposed to one it can
// show and flag, like an empty name.
const shapeProblems = new Set([
  "invalid_type",
  "invalid_union",
  "invalid_value",
])

export function readBrickText(
  text: string
): { brick: BrickV2; problem: null } | { brick: null; problem: string } {
  const parsed = Result.try({
    try: () => JSON.parse(text) as unknown,
    catch: (error) =>
      error instanceof Error ? error.message : "That isn't JSON",
  })
  if (Result.isFailure(parsed)) return { brick: null, problem: parsed.failure }
  const value = parsed.success
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { brick: null, problem: "A Brick is a JSON object" }
  }
  const result = brickV2Schema.safeParse(value)
  const blocking = result.error?.issues.find((issue) =>
    shapeProblems.has(issue.code)
  )
  if (blocking) {
    return {
      brick: null,
      problem: `${pathLabel(blocking.path)}: ${issueMessage(blocking)}`,
    }
  }
  return { brick: value as BrickV2, problem: null }
}

export interface CreatorIssue {
  message: string
  path: string
  section: CreatorSection
}

export type CreatorSection = "basics" | "inputs" | "deploy" | "database"

export function brickIssues(brick: BrickV2): Array<CreatorIssue> {
  const result = brickV2Schema.safeParse(brick)
  if (result.success) return []
  return result.error.issues.map((issue) => ({
    message:
      valueAt(brick, issue.path) === "" ? "Required" : issueMessage(issue),
    path: issue.path.join("."),
    section: sectionOf(issue.path[0]),
  }))
}

function valueAt(value: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<PropertyKey, unknown>)[key]
  }
  return current
}

function sectionOf(key: PropertyKey | undefined): CreatorSection {
  if (key === "inputs") return "inputs"
  if (key === "deploy") return "deploy"
  if (key === "database") return "database"
  return "basics"
}

interface LooseIssue {
  code: string
  input?: unknown
  message: string
  minimum?: unknown
  origin?: string
  path: ReadonlyArray<PropertyKey>
}

function issueMessage(issue: LooseIssue): string {
  if (issue.code === "invalid_type" && issue.input === undefined) {
    return "Required"
  }
  if (
    issue.code === "too_small" &&
    issue.minimum === 1 &&
    (issue.origin === "string" || issue.origin === "array")
  ) {
    return "Required"
  }
  if (issue.code === "invalid_format") return "Not in the expected format"
  return issue.message
}

export function pathLabel(path: ReadonlyArray<PropertyKey>): string {
  return path.length === 0 ? "Brick" : path.map(String).join(".")
}

export function fieldDomId(path: string): string {
  return `brick-field-${path.replaceAll(".", "-")}`
}

// Drops what an optional field holds when it's cleared: nothing, or an empty
// list or object. Required ones that end up empty are flagged by the schema.
export function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune)
  if (typeof value !== "object" || value === null) return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    const pruned = prune(entry)
    if (pruned === undefined) continue
    if (Array.isArray(pruned) && pruned.length === 0) continue
    if (
      typeof pruned === "object" &&
      pruned !== null &&
      !Array.isArray(pruned) &&
      Object.keys(pruned).length === 0
    ) {
      continue
    }
    result[key] = pruned
  }
  return result
}

// Sets a value deep in the Brick without changing anything else.
export function setIn<T>(
  target: T,
  path: ReadonlyArray<string | number>,
  value: unknown
): T {
  if (path.length === 0) return value as T
  const [head, ...rest] = path
  if (Array.isArray(target)) {
    const copy = [...target]
    copy[head as number] = setIn(copy[head as number], rest, value)
    return copy as T
  }
  const source = (target ?? {}) as Record<string, unknown>
  return {
    ...source,
    [head as string]: setIn(source[head as string], rest, value),
  } as T
}

export const kindLabels: Record<BrickV2Kind, string> = {
  "game-server": "Game server",
  app: "App",
  database: "Database",
}

// Whether a kind can run a way of deploying: only apps are static sites.
export function deployAllowed(
  kind: BrickV2Kind,
  type: BrickV2DeployType
): boolean {
  return type !== "static" || kind === "app"
}

// Switches how it deploys, keeping what both ways share.
export function convertDeploy(
  deploy: BrickV2Deploy,
  type: BrickV2DeployType
): BrickV2Deploy {
  if (deploy.type === type) return deploy
  const run =
    deploy.type === "static"
      ? {}
      : {
          env: deploy.env,
          hostname: deploy.hostname,
          memory: deploy.memory,
          ports: deploy.ports,
          ready: deploy.ready,
          stop: deploy.stop,
        }
  const container =
    deploy.type === "image" || deploy.type === "dockerfile"
      ? {
          command: deploy.command,
          files: deploy.files,
          user: deploy.user,
          volumes: deploy.volumes,
        }
      : {}
  if (type === "image") return { type, image: "", ...run, ...container }
  if (type === "dockerfile") {
    return { type, path: "Dockerfile", ...run, ...container }
  }
  if (type === "compose") return { type, path: "compose.yaml", ...run }
  return { type, root: "." }
}

export function changeKind(brick: BrickV2, kind: BrickV2Kind): BrickV2 {
  const { game, database, ...rest } = brick
  const deploy = deployAllowed(kind, brick.deploy.type)
    ? brick.deploy
    : convertDeploy(brick.deploy, "image")
  const ports = deploy.type === "static" ? [] : (deploy.ports ?? [])
  return {
    ...rest,
    kind,
    deploy,
    ...(kind === "game-server" ? { game: game ?? "" } : {}),
    ...(kind === "database"
      ? {
          database: database ?? {
            port: ports[0]?.name ?? "",
            connection: "",
          },
        }
      : {}),
  }
}

// A new Brick of a kind that deploys a way, filled in enough to start from.
export function starterBrick(
  kind: BrickV2Kind,
  type: BrickV2DeployType
): BrickV2 {
  const base = {
    $schema: BRICK_V2_SCHEMA_URL,
    format: BRICK_V2_FORMAT,
    id: "",
    name: "",
    kind: "app",
    summary: "",
    author: "",
    deploy: convertDeploy({ type: "image", image: "" }, type),
  } as BrickV2
  const brick = changeKind(base, kind)
  if (brick.deploy.type === "static") return brick
  const port =
    kind === "game-server"
      ? { name: "game", port: 25565 }
      : kind === "database"
        ? { name: "db", port: 5432 }
        : { name: "web", port: 8080 }
  const deploy = { ...brick.deploy, ports: [port] } as BrickV2Deploy
  if (
    (deploy.type === "image" || deploy.type === "dockerfile") &&
    kind !== "app"
  ) {
    deploy.volumes = ["/data"]
  }
  return {
    ...brick,
    deploy,
    ...(brick.database
      ? { database: { ...brick.database, port: port.name } }
      : {}),
  }
}

// The dialogs the workspace opens to edit one part of the Brick.
export type CreatorPanel =
  | { kind: "input"; index: number }
  | {
      kind:
        | "env"
        | "ports"
        | "volumes"
        | "files"
        | "ready"
        | "address"
        | "stop"
        | "command"
        | "source"
        | "connection"
        | "backups"
    }

// Where to fix an issue: the dialog that edits it, or the field on the
// canvas that does.
export function panelFor(
  path: string
): { panel: CreatorPanel } | { field: string } {
  const [head, second, third] = path.split(".")
  if (head === "inputs" && second !== undefined) {
    return { panel: { kind: "input", index: Number(second) } }
  }
  if (head === "database") {
    return {
      panel: {
        kind:
          second === "backup" || second === "restore"
            ? "backups"
            : "connection",
      },
    }
  }
  if (head === "deploy") {
    const byField: Record<string, CreatorPanel["kind"]> = {
      env: "env",
      ports: "ports",
      volumes: "volumes",
      files: "files",
      ready: "ready",
      hostname: "address",
      stop: "stop",
      command: "command",
      user: "command",
      dockerfile: "source",
      compose: "source",
    }
    const kind = second === undefined ? undefined : byField[second]
    if (kind) return { panel: { kind } as CreatorPanel }
    return { field: third === undefined ? path : `deploy.${second}` }
  }
  return { field: head ?? "" }
}
