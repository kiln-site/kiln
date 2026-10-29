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
    if (args[0] === "volume" && ["inspect", "create"].includes(args[1])) {
      return success()
    }
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
    }
    if (["container", "network", "volume"].includes(args[0])) {
      if (args[1] === "ls") {
        const [label, value] = args[args.indexOf("--filter") + 1]
          .replace(/^label=/u, "")
          .split("=")
        const format = args[args.indexOf("--format") + 1]
        return success(
          [...resources]
            .filter(
              ([, resource]) =>
                resource.kind === args[0] && resource.labels[label] === value
            )
            .map(([id, resource]) =>
              format
                .replace("{{.ID}}", id)
                .replace("{{.Name}}", id)
                .replace(
                  '{{.Label "com.docker.compose.project"}}',
                  resource.labels["com.docker.compose.project"] ?? ""
                )
                .trim()
            )
            .join("\n")
        )
      }
      if (args[1] === "rm") {
        for (const id of args.slice(2).filter((arg) => !arg.startsWith("-"))) {
          if (resources.get(id)?.kind !== args[0]) {
            return {
              status: 1,
              stdout: "",
              stderr: `No such ${args[0]}: ${id}`,
            }
          }
          resources.delete(id)
        }
        return success()
      }
    }
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
  resource("our-game", "container", { "kiln.relay.owner": "kiln-repo-cleanup" })
  resource("other-game", "container", { "kiln.relay.owner": "kiln-other" })
  git(worktree, "switch", "-c", "fix/another-task")
  await command("destroy")
  assert.equal(projects.size, 0)
  assert.deepEqual([...resources.keys()], ["other-game"])
})

test("destroy removes the volumes and networks the Relay and its Apps' Compose projects made, and nobody else's", async () => {
  await command("up")
  const appId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  const otherAppId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  const ours = { "kiln.relay.owner": "kiln-repo-cleanup" }
  const app = `kiln-repo-cleanup-kiln-app-${appId}`
  resource("our-app-web", "container", {
    ...ours,
    "com.docker.compose.project": app,
  })
  resource("kiln-repo-cleanup-kiln-db-1234-data", "volume", ours)
  resource("kiln-repo-cleanup-kiln-db-1234-network", "network", ours)
  resource(`${app}_data`, "volume", { "com.docker.compose.project": app })
  resource(`${app}_default`, "network", { "com.docker.compose.project": app })
  // Another stack's, a real Relay's, and Compose projects of their own.
  resource("kiln-other-kiln-db-1234-data", "volume", {
    "kiln.relay.owner": "kiln-other",
  })
  resource(`kiln-other-kiln-app-${appId}_default`, "network", {
    "com.docker.compose.project": `kiln-other-kiln-app-${appId}`,
  })
  resource("kiln-kiln-db-1234-data", "volume", {})
  resource(`kiln-repo-cleanup-kiln-app-${otherAppId}_data`, "volume", {
    "com.docker.compose.project": `kiln-repo-cleanup-kiln-app-${otherAppId}-other`,
  })

  await command("destroy")

  assert.deepEqual([...resources.keys()].sort(), [
    "kiln-kiln-db-1234-data",
    `kiln-other-kiln-app-${appId}_default`,
    "kiln-other-kiln-db-1234-data",
    `kiln-repo-cleanup-kiln-app-${otherAppId}_data`,
  ])
})

test("a colliding checkout cannot start or destroy another checkout's project", async () => {
  projects.set("kiln-repo-cleanup", root)
  resource("other-game", "container", {
    "kiln.relay.owner": "kiln-repo-cleanup",
  })
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
  resource("primary-game", "container", {})
  await assert.rejects(command("destroy"), /exit 1/u)
  assert.equal(projects.get("kiln"), root)
  assert.ok(resources.has("primary-game"))
  assert.match(output.join("\n"), /Refusing to destroy unscoped/u)
})

// Something on the Docker host, with its labels.
function resource(id, kind, labels) {
  resources.set(id, { kind, labels })
}

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
