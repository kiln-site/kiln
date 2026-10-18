import { execFile } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { dist, packageName, platforms, version } from "./distribution.mjs"

const execFileAsync = promisify(execFile)
const retryDelay = 10_000
const visibilityTimeout = 5 * 60_000
const provenanceAttempts = 3

function delay(milliseconds = retryDelay) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function runNpm(args, options) {
  const command = execFileAsync("npm", args, {
    encoding: "utf8",
    timeout: 10 * 60_000,
    ...options,
  })
  if (args[0] === "publish") {
    command.child.stdout.pipe(process.stdout)
    command.child.stderr.pipe(process.stderr)
  }
  return (await command).stdout
}

export async function publishPackages(run = runNpm) {
  async function isPublished(name, timeout = retryDelay) {
    try {
      const published = await run(["view", `${name}@${version}`, "version"], {
        timeout,
      })
      // Older npm versions print nothing for an unpublished version. The
      // printed version can differ from ours by registry normalization.
      return Boolean(published.trim())
    } catch {
      return false
    }
  }

  async function waitForPublished(name, cause) {
    console.log(`Waiting for ${name}@${version} to become available on npm.`)
    const deadline = Date.now() + visibilityTimeout
    while (true) {
      const budget = deadline - Date.now()
      if (budget <= 0) break
      // Include slow registry reads in the budget and terminate a stuck npm view.
      if (await isPublished(name, Math.min(retryDelay, budget))) return
      const remaining = deadline - Date.now()
      if (remaining > 0) await delay(Math.min(retryDelay, remaining))
    }
    throw new Error(
      `${name}@${version} is still unavailable after 5 minutes. Rerun publishing after npm finishes processing it.`,
      { cause }
    )
  }

  async function publish(name, source) {
    if (await isPublished(name)) {
      console.log(`${name}@${version} is already published.`)
      return
    }
    for (let attempt = 1; attempt <= provenanceAttempts; attempt += 1) {
      try {
        await run(["publish", source, "--access", "public", "--tag", "latest"])
      } catch (error) {
        const output = `${error.message}\n${error.stderr ?? ""}`
        if (output.includes("Cannot publish over previously staged version")) {
          // npm accepted an earlier upload but has not exposed it to npm view.
          // Do not upload it again or publish the launcher until it is visible.
          await waitForPublished(name, error)
          return
        }
        if (
          !output.includes("TLOG_CREATE_ENTRY_ERROR") ||
          !output.includes("an equivalent entry already exists") ||
          attempt === provenanceAttempts
        )
          throw error
        console.log(`Retrying provenance generation for ${name}@${version}.`)
        await delay()
        continue
      }
      // Successful uploads can still be queued for registry processing.
      await waitForPublished(name)
      return
    }
  }

  // Finish all in-flight uploads before failing or making the launcher discoverable.
  const results = await Promise.allSettled(
    platforms.map((platform) => {
      const name = `${packageName}-${platform.name}`
      const tarball = `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`
      return publish(name, join(dist, "platform-packages", tarball))
    })
  )
  const failures = results.filter((result) => result.status === "rejected")
  if (failures.length > 0)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Failed to publish native CLI packages"
    )
  await publish(packageName, join(dist, "npm"))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await publishPackages()
