import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Readable } from "node:stream"

import type { BackupRecoveryPasswords } from "@workspace/contracts"
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test"

import {
  createResticDriver,
  validateStagingTree,
  type ResticDriverLocation,
  type ResticSpawn,
} from "./restic.js"
import { RelayBackupError } from "./effect/errors.js"

const testDirectory = mkdtempSync(join(tmpdir(), "kiln-restic-"))
const s3Location: ResticDriverLocation = {
  kind: "s3",
  repositoryId: "66666666-6666-4666-8666-666666666666",
}

afterEach(() => {
  vi.unstubAllEnvs()
})

afterAll(() => {
  rmSync(testDirectory, { force: true, recursive: true })
})

describe("restic staging validation", () => {
  it("drops symlinks with a warning instead of failing the restore", async () => {
    const staging = join(testDirectory, "symlink-staging")
    await mkdir(join(staging, "world"), { recursive: true })
    await writeFile(join(staging, "world", "level.dat"), "ok")
    await symlink("/etc/passwd", join(staging, "link"))
    const checked = await validateStagingTree(staging, { diskBytes: 10_000 })
    expect(checked.logicalBytes).toBe(2)
    expect(checked.warnings).toHaveLength(1)
    expect(checked.warnings[0]).toContain("link")
    expect(existsSync(join(staging, "link"))).toBe(false)
    expect(existsSync(join(staging, "world", "level.dat"))).toBe(true)
  })
})

describe("restic S3 driver", () => {
  it("sanitizes the restic environment and keeps secrets out of argv", async () => {
    vi.stubEnv("AWS_SESSION_TOKEN", "leaked-session")
    vi.stubEnv("HTTPS_PROXY", "http://evil.example:8080")
    vi.stubEnv("HTTP_PROXY", "http://evil.example:8080")
    const cacheDirectory = join(testDirectory, "restic-cache")
    const { processes, spawn } = fakeRestic((restic) => restic.respond({}))
    await createResticDriver({ cacheDirectory, spawn }).forget({
      location: s3Location,
      password: "repo-secret",
      signal: new AbortController().signal,
      snapshotId: "abcdef12",
    })
    const call = processes[0]
    expect(call).toBeDefined()
    if (!call) return
    expect(call.env.AWS_SESSION_TOKEN).toBeUndefined()
    expect(call.env.HTTP_PROXY).toBeUndefined()
    expect(call.env.HTTPS_PROXY).toBeUndefined()
    expect(call.env.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(call.env.RESTIC_PASSWORD).toBe("repo-secret")
    expect(call.env.RESTIC_REPOSITORY).toMatch(
      /^rest:http:\/\/127\.0\.0\.1:\d+\/[\w-]{43}\/$/u
    )
    expect(call.env.RESTIC_CACHE_DIR).toBe(cacheDirectory)
    expect(existsSync(cacheDirectory)).toBe(true)
    expect(call.args.join(" ")).not.toContain("repo-secret")
  })

  it("adds each recovery password once, under a name of its own", async () => {
    const keys: Array<{ password: string; userName: string }> = [
      { password: "repo-secret", userName: "root" },
    ]
    const { processes, spawn } = fakeRestic((restic) => {
      if (restic.args.includes("add")) {
        const option = (name: string) =>
          restic.args[restic.args.indexOf(name) + 1] ?? ""
        keys.push({
          password: readFileSync(option("--new-password-file"), "utf8"),
          userName: option("--user"),
        })
      }
      restic.respond({
        stdout: JSON.stringify(keys.map(({ userName }) => ({ userName }))),
      })
    })
    const add = (passwords: BackupRecoveryPasswords) =>
      // A driver of its own, as after the Relay restarts.
      createResticDriver({ spawn }).addPasswords({
        location: s3Location,
        password: "repo-secret",
        passwords,
        signal: new AbortController().signal,
      })
    const kiln = { holder: "kiln", password: "from-recovery-code" } as const
    const owner = { holder: "destination", password: "owners" } as const
    await add([kiln, owner])
    await add([kiln, owner])
    expect(keys.map(({ password }) => password)).toEqual([
      "repo-secret",
      "from-recovery-code",
      "owners",
    ])
    // Another recovery code opens it too.
    await add([{ ...kiln, password: "another-code" }, owner])
    expect(keys.map(({ password }) => password)).toContain("another-code")
    expect(keys).toHaveLength(4)
    const argv = processes.flatMap(({ args }) => args).join(" ")
    expect(argv).not.toContain("from-recovery-code")
  })

  // As a prune leaves one when it can't reach the bucket to remove it.
  it("opens a repository a dead lock was left in", async () => {
    let locked = true
    const { spawn } = fakeRestic((restic) => {
      if (restic.args.includes("unlock")) locked = false
      restic.respond({ exitCode: locked ? 11 : 0 })
    })
    const snapshots = await createResticDriver({ spawn }).openForBackup({
      location: s3Location,
      password: "repo-secret",
      signal: new AbortController().signal,
      tag: "task:1",
    })
    expect(snapshots).toEqual([])
  })

  it("redacts repository secrets from restic stderr", async () => {
    const { spawn } = fakeRestic((restic) =>
      restic.respond({
        exitCode: 1,
        stderr: `Fatal: could not open ${restic.env.RESTIC_REPOSITORY} with repo-secret`,
      })
    )
    const failure = await createResticDriver({ spawn })
      .backup({
        location: s3Location,
        password: "repo-secret",
        signal: new AbortController().signal,
        source: { cwd: testDirectory, excludes: [], paths: ["instance"] },
        tags: ["task:1"],
      })
      .then(
        () => null,
        (cause: unknown) => cause
      )
    expect(failure).toBeInstanceOf(RelayBackupError)
    const reason = failure instanceof RelayBackupError ? failure.reason : ""
    expect(reason).toBe("Fatal: could not open the bucket with [redacted]")
  })
})

describe("a backup read from a stream", () => {
  // restic saves what it was given once its input ends, whole or not.
  const saved = async (name: string, source: () => Readable) => {
    const snapshot = join(testDirectory, name)
    const script = `
      const chunks = []
      process.stdin.on("data", (chunk) => chunks.push(chunk))
      process.stdin.on("end", () => {
        require("node:fs").writeFileSync(${JSON.stringify(snapshot)}, Buffer.concat(chunks))
        console.log(JSON.stringify({ message_type: "summary", snapshot_id: "abcdef12", total_bytes_processed: 1 }))
      })`
    const backup = createResticDriver({
      spawn: (_command, _args, options) =>
        spawn(process.execPath, ["-e", script], options),
    }).backup({
      location: { kind: "local", path: testDirectory },
      password: "repo-secret",
      signal: new AbortController().signal,
      source: { filename: "database.sql", open: source },
      tags: ["task:1"],
    })
    const outcome = await backup.then(
      () => "saved",
      (cause: unknown) => (cause as Error).message
    )
    return {
      outcome,
      snapshot: existsSync(snapshot) ? readFileSync(snapshot, "utf8") : null,
    }
  }

  it("keeps all of it", async () => {
    expect(
      await saved("whole", () => Readable.from(["-- dump\n", "rows"]))
    ).toEqual({ outcome: "saved", snapshot: "-- dump\nrows" })
  })

  it("keeps nothing of one that fails partway", async () => {
    const { outcome, snapshot } = await saved("broken", () =>
      Readable.from(
        (async function* () {
          yield "-- dump\n"
          throw new Error("the dump was cut short")
        })()
      )
    )
    expect(outcome).toContain("the dump was cut short")
    expect(snapshot).toBeNull()
  })
})

/** A fake restic process at the child-process boundary. */
class FakeResticProcess {
  readonly child: ReturnType<ResticSpawn>
  readonly stderr = new PassThrough()
  readonly stdout = new PassThrough()

  constructor(
    readonly args: ReadonlyArray<string>,
    readonly env: NodeJS.ProcessEnv
  ) {
    this.child = Object.assign(new EventEmitter(), {
      kill: () => true,
      stderr: this.stderr,
      stdin: new PassThrough(),
      stdout: this.stdout,
    }) as unknown as ReturnType<ResticSpawn>
  }

  respond(output: {
    exitCode?: number
    stderr?: string
    stdout?: string
  }): void {
    queueMicrotask(() => {
      this.stdout.end(output.stdout ?? "")
      this.stderr.end(output.stderr ?? "")
      this.child.emit("close", output.exitCode ?? 0)
    })
  }
}

function fakeRestic(behaviour: (restic: FakeResticProcess) => void): {
  processes: Array<FakeResticProcess>
  spawn: ResticSpawn
} {
  const processes: Array<FakeResticProcess> = []
  return {
    processes,
    spawn: (_command, args, options) => {
      const restic = new FakeResticProcess([...args], { ...options.env })
      processes.push(restic)
      behaviour(restic)
      return restic.child
    },
  }
}
