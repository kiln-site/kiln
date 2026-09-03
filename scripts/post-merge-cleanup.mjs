import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { developmentStackName } from "./dev-docker-helpers.mjs"

const arguments_ = process.argv.slice(2)
const pr = arguments_.find((argument) => !argument.startsWith("-"))
const dryRun = arguments_.includes("--dry-run")
const apply = arguments_.includes("--yes")

if (!pr || dryRun === apply) {
  fail(
    "Usage: pnpm cleanup:merged <pr-number> --dry-run | --yes"
  )
}

const repo = capture(
  "git",
  ["rev-parse", "--show-toplevel"],
  process.cwd()
)
const prInfo = JSON.parse(
  capture("gh", [
    "pr",
    "view",
    pr,
    "--json",
    "state,mergedAt,headRefName,headRefOid,baseRefName",
  ])
)

if (prInfo.state !== "MERGED" || !prInfo.mergedAt) {
  fail(`PR ${pr} is not merged.`)
}
if (prInfo.baseRefName !== "main") {
  fail(`PR ${pr} targets ${prInfo.baseRefName}, not main.`)
}

const branch = prInfo.headRefName
const worktrees = parseWorktrees(capture("git", ["worktree", "list", "--porcelain"]))
const targetWorktree = worktrees.find((worktree) => worktree.branch === branch)
const existingMainWorktree = worktrees.find((worktree) => worktree.branch === "main")

if (targetWorktree) {
  const targetHead = capture("git", ["-C", targetWorktree.path, "rev-parse", "HEAD"])
  if (targetHead !== prInfo.headRefOid) {
    fail(
      `Worktree ${targetWorktree.path} is not at the merged PR head ${prInfo.headRefOid}.`
    )
  }
  ensureClean(targetWorktree.path, "feature worktree")
}

let mainWorktree = existingMainWorktree?.path
let temporaryMainWorktree = false

if (!mainWorktree) {
  if (dryRun) {
    console.log("main is not checked out; --yes would use a temporary main worktree.")
  } else {
    mainWorktree = mkdtempSync(join(tmpdir(), "kiln-post-merge-main-"))
    temporaryMainWorktree = true
    run("git", ["worktree", "add", mainWorktree, "main"], repo)
  }
}

try {
  if (mainWorktree) ensureClean(mainWorktree, "main worktree")

  if (targetWorktree) {
    const stack = developmentStackName(targetWorktree.path)
    run("pnpm", ["dev:docker:destroy"], targetWorktree.path)
    cleanupDockerResources(stack)
  } else {
    console.log(`No worktree checked out for ${branch}; skipping worktree removal.`)
  }

  if (mainWorktree) {
    run("git", ["-C", mainWorktree, "pull", "--ff-only", "origin", "main"], repo)
  }

  if (targetWorktree && mainWorktree) {
    run("git", ["-C", mainWorktree, "worktree", "remove", targetWorktree.path], repo)
  }

  if (localBranchExists(branch)) {
    run("git", ["-C", mainWorktree ?? repo, "branch", "-D", branch], repo)
  } else {
    console.log(`Local branch ${branch} is already absent.`)
  }

  if (remoteBranchExists(branch)) {
    run("git", ["-C", mainWorktree ?? repo, "push", "origin", "--delete", branch], repo)
  } else {
    console.log(`Remote branch origin/${branch} is already absent.`)
  }
} finally {
  if (temporaryMainWorktree && mainWorktree) {
    run("git", ["worktree", "remove", "--force", mainWorktree], repo)
    rmSync(mainWorktree, { force: true, recursive: true })
  }
}

console.log(dryRun ? "Dry run complete; no changes were made." : "Post-merge cleanup complete.")

function parseWorktrees(output) {
  return output
    .split(/\n\n/u)
    .map((entry) => {
      const path = entry.match(/^worktree (.+)$/mu)?.[1]
      const branch = entry.match(/^branch refs\/heads\/(.+)$/mu)?.[1]
      return path && branch ? { branch, path } : null
    })
    .filter(Boolean)
}

function cleanupDockerResources(stack) {
  const containers = dockerRows(["container", "ls", "--all"], stack)
  const networks = dockerRows(["network", "ls"], stack)
  const volumes = dockerRows(["volume", "ls"], stack)

  console.log(
    `Docker leftovers for ${stack}: ${containers.length} container(s), ${networks.length} network(s), ${volumes.length} volume(s).`
  )

  if (containers.length > 0) {
    run("docker", ["container", "rm", "--force", ...containers.map((row) => row.id)], repo)
  }
  if (networks.length > 0) {
    run("docker", ["network", "rm", ...networks.map((row) => row.id)], repo)
  }
  if (volumes.length > 0) {
    run("docker", ["volume", "rm", ...volumes.map((row) => row.name)], repo)
  }
}

function dockerRows(command, stack) {
  const volumeList = command[0] === "volume"
  const format = volumeList ? "{{.Name}}" : "{{.ID}}\t{{.Name}}"
  const output = capture("docker", [...command, "--format", format])
  if (volumeList) {
    return output
      .split("\n")
      .filter((name) => name.startsWith(stack + "-") || name.startsWith(stack + "_"))
      .map((name) => ({ id: name, name }))
  }
  return output
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const [id, name] = row.split("\t")
      return { id, name }
    })
    .filter(({ name }) => name.startsWith(`${stack}-`) || name.startsWith(`${stack}_`))
}

function ensureClean(path, label) {
  const status = capture("git", ["-C", path, "status", "--porcelain"])
  if (status) fail(`Refusing to remove dirty ${label}: ${path}`)
}

function localBranchExists(name) {
  return commandStatus("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]) === 0
}

function remoteBranchExists(name) {
  const result = command("git", ["ls-remote", "--heads", "origin", `refs/heads/${name}`])
  if (result.status !== 0) fail(result.stderr || `Could not inspect origin/${name}.`)
  return Boolean(result.stdout.trim())
}

function capture(command_, arguments_, cwd = repo) {
  const result = command(command_, arguments_, cwd)
  if (result.status !== 0) fail(result.stderr || `${command_} ${arguments_.join(" ")} failed.`)
  return result.stdout.trim()
}

function command(command_, arguments_, cwd = repo) {
  return spawnSync(command_, arguments_, {
    cwd,
    encoding: "utf8",
    env: process.env,
  })
}

function commandStatus(command_, arguments_, cwd = repo) {
  return command(command_, arguments_, cwd).status
}

function run(command_, arguments_, cwd = repo) {
  console.log("$", command_, ...arguments_)
  if (dryRun) return
  const result = command(command_, arguments_, cwd)
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    fail(`${command_} ${arguments_.join(" ")} failed.`)
  }
  process.stdout.write(result.stdout)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
