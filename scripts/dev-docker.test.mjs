import assert from "node:assert/strict"
import { spawnSync as realSpawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test, vi } from "vite-plus/test"

// Replace only the external Docker boundary; Git and the script's files are real.
const boundary = vi.hoisted(() => ({ docker: null }))
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal()
  return {
    ...original,
    spawnSync: (executable, args, options) =>
      executable === "docker"
        ? boundary.docker(args, options)
        : original.spawnSync(executable, args, options),
  }
})

let directory
let root
let worktree
let projects
let resources
let output
let engine

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "kiln-dev-")))
  root = join(directory, "repo")
  worktree = join(directory, "worktree")
  git(directory, "init", "--initial-branch=main", root)
  git(
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "Initial"
  )
  git(root, "worktree", "add", "-b", "chore/repo-cleanup", worktree)
  writeFileSync(
    join(root, ".env"),
    [
      "DB_PASSWORD=test-secret",
      "BETTER_AUTH_SECRETS=1:test-secret",
      "KILN_RELAY_BOOTSTRAP_TOKEN=test-secret",
      "KILN_PLATFORM_BACKUP_KEY=test-secret",
    ].join("\n")
  )
  projects = new Map()
  resources = new Map()
  output = []
  engine = "Docker Engine - Community"
  boundary.docker = (args, options) => {
    const success = (stdout = "") => ({ status: 0, stdout, stderr: "" })
    if (args[0] === "info") return success(engine)
    if (args[0] === "volume") return success()
    if (args[0] === "compose") {
      const project = args[args.indexOf("--project-name") + 1]
      if (args.includes("up")) projects.set(project, options.cwd)
      if (args.includes("down")) projects.delete(project)
      return success()
    }
    if (args[0] === "container" && args[1] === "ls") {
      const filter = args[args.indexOf("--filter") + 1]
      const project = filter.replace("label=com.docker.compose.project=", "")
      if (filter.startsWith("label=com.docker.compose.project=")) {
        return success(projects.get(project) ?? "")
      }
      const owner = filter.replace("label=kiln.relay.owner=", "")
      return success(
        [...resources]
          .filter(([, value]) => value === owner)
          .map(([id]) => id)
          .join("\n")
      )
    }
    if (args[0] === "container" && args[1] === "rm") {
      for (const id of args.slice(3)) resources.delete(id)
      return success()
    }
    if (args[0] === "network" && args[1] === "ls") return success()
    throw new Error(`Unexpected Docker operation: ${args.join(" ")}`)
  }
  vi.spyOn(process, "cwd").mockReturnValue(worktree)
  vi.spyOn(console, "log").mockImplementation((...args) =>
    output.push(args.join(" "))
  )
  vi.spyOn(console, "error").mockImplementation((...args) =>
    output.push(args.join(" "))
  )
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`)
  })
  for (const name of [
    "KILN_DEV_PROJECT",
    "KILN_DEV_NETWORK",
    "KILN_DEV_WEB_PORT",
    "KILN_DEV_MYSQL_PORT",
    "KILN_DEV_SFTP_PORT",
  ]) {
    vi.stubEnv(name, "")
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

test("cleanup after a branch switch removes the original stack and only its Relay resources", async () => {
  await command("up")
  assert.ok(projects.has("kiln-repo-cleanup"))
  resources.set("our-game", "kiln-repo-cleanup")
  resources.set("other-game", "kiln-other")
  git(worktree, "switch", "-c", "fix/another-task")
  await command("destroy")
  assert.equal(projects.size, 0)
  assert.deepEqual([...resources.keys()], ["other-game"])
})

test("a colliding checkout cannot start or destroy another checkout's project", async () => {
  projects.set("kiln-repo-cleanup", root)
  resources.set("other-game", "kiln-repo-cleanup")
  for (const action of ["up", "destroy"]) {
    await assert.rejects(command(action), /exit 1/u)
    assert.equal(projects.get("kiln-repo-cleanup"), root)
    assert.ok(resources.has("other-game"))
  }
  assert.match(output.join("\n"), /belongs to another checkout/u)
  vi.stubEnv("KILN_DEV_PROJECT", "kiln-my-checkout")
  await command("up")
  assert.equal(projects.get("kiln-my-checkout"), worktree)
})

test("primary checkout destroy preserves unscoped Relay resources", async () => {
  vi.mocked(process.cwd).mockReturnValue(root)
  projects.set("kiln", root)
  resources.set("primary-game", "")
  await assert.rejects(command("destroy"), /exit 1/u)
  assert.equal(projects.get("kiln"), root)
  assert.ok(resources.has("primary-game"))
  assert.match(output.join("\n"), /Refusing to destroy unscoped/u)
})

test("standard Docker prints a usable localhost URL without requiring OrbStack DNS", async () => {
  vi.stubEnv("KILN_DEV_WEB_PORT", "3007")
  await command("url")
  assert.equal(output.pop(), "http://localhost:3007")
  engine = "OrbStack"
  await command("url")
  assert.equal(output.pop(), "https://kiln-repo-cleanup.orb.local")
  vi.stubEnv("KILN_DEV_NETWORK", "localhost")
  await command("url")
  assert.equal(output.pop(), "http://localhost:3007")
})

async function command(action) {
  vi.resetModules()
  vi.spyOn(process, "argv", "get").mockReturnValue([
    process.execPath,
    "dev-docker.mjs",
    action,
  ])
  await import("./dev-docker.mjs")
}

function git(cwd, ...args) {
  const result = realSpawnSync("git", args, { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
}
