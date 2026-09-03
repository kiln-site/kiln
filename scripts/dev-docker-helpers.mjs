import { createHash } from "node:crypto"
import { basename, resolve } from "node:path"

export function developmentStackName(worktreePath) {
  const slug =
    basename(worktreePath)
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 30) || "worktree"
  const hash = createHash("sha256")
    .update(resolve(worktreePath))
    .digest("hex")
    .slice(0, 6)
  return `hearth-${slug}-${hash}`
}

export function developmentRelayName(worktreePath) {
  const shortId = createHash("sha256")
    .update(resolve(worktreePath))
    .digest("hex")
    .slice(0, 8)
  return `D001-${shortId}`
}

export function ensureDockerVolume(volumeName, execute) {
  const inspect = () => execute(["volume", "inspect", volumeName])
  if (inspect().status === 0) return

  const created = execute(["volume", "create", volumeName])
  if (created.status === 0 || inspect().status === 0) return

  const detail = created.stderr?.trim()
  throw new Error(
    detail
      ? `Could not create Docker volume ${volumeName}: ${detail}`
      : `Could not create Docker volume ${volumeName}.`
  )
}
