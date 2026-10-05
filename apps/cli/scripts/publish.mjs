import { execFile } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { dist, packageName, platforms, version } from "./distribution.mjs"

const execFileAsync = promisify(execFile)

async function runNpm(args) {
  const command = execFileAsync("npm", args, { encoding: "utf8" })
  if (args[0] === "publish") {
    command.child.stdout.pipe(process.stdout)
    command.child.stderr.pipe(process.stderr)
  }
  return (await command).stdout
}

export async function publishPackages(run = runNpm) {
  async function publish(name, source) {
    try {
      const published = await run(["view", `${name}@${version}`, "version"])
      // Older npm versions print nothing for an unpublished version. The
      // printed version can differ from ours by registry normalization.
      if (published.trim()) {
        console.log(`${name}@${version} is already published.`)
        return
      }
    } catch {
      // npm publish still rejects network/authentication failures and immutable versions.
    }
    await run(["publish", source, "--access", "public", "--tag", "latest"])
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
