import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { dist, packageName, platforms, version } from "./distribution.mjs"

function publish(name, source) {
  try {
    const published = execFileSync(
      "npm",
      ["view", `${name}@${version}`, "version"],
      { encoding: "utf8", stdio: "pipe" }
    )
    // Older npm versions exit successfully, printing nothing, for an unpublished
    // version. The printed version can differ from ours by registry normalization.
    if (published.trim()) {
      console.log(`${name}@${version} is already published.`)
      return
    }
  } catch {
    // npm publish still rejects network/authentication failures and immutable versions.
  }
  execFileSync(
    "npm",
    ["publish", source, "--access", "public", "--tag", "latest"],
    { stdio: "inherit" }
  )
}

// Publish every optional dependency before making the launcher discoverable.
for (const platform of platforms) {
  const name = `${packageName}-${platform.name}`
  const tarball = `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`
  publish(name, join(dist, "platform-packages", tarball))
}
publish(packageName, join(dist, "npm"))
