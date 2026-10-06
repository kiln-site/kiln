import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"

import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test"

import {
  createResticDriver,
  resticDriverLocation,
  resticSnapshotSelector,
  translateExcludePatterns,
  validateStagingTree,
  type ResticDriverLocation,
  type ResticProgress,
  type ResticSpawn,
} from "./restic.js"
import { RelayBackupError } from "./effect/errors.js"

const testDirectory = mkdtempSync(join(tmpdir(), "kiln-restic-"))
const s3Location: ResticDriverLocation = {
  accessKeyId: "AKIAEXAMPLE",
  allowPrivateNetwork: true,
  bucket: "kiln-backups",
  endpoint: "https://s3.example.com",
  forcePathStyle: true,
  kind: "s3",
  region: "us-east-1",
  repositoryPrefix: "team/kiln/relay/restic/instance/srv/repo",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
}
const localLocation: ResticDriverLocation = {
  kind: "local",
  path: join(testDirectory, "repo"),
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

afterAll(() => {
  rmSync(testDirectory, { force: true, recursive: true })
})

describe("restic exclude translation", () => {
  it("translates the supported subset and skips unsupported patterns", () => {
    const translated = translateExcludePatterns([
      "# comment",
      "",
      ".DS_Store",
      "logs/**",
      "*.pid",
      "!keep.txt",
      "cache[0-9]",
      "build/{tmp,out}",
      "*.@(log|tmp)",
    ])
    expect(translated.excludes).toEqual([
      ".DS_Store",
      "**/.DS_Store",
      "logs/**",
      "*.pid",
      "**/*.pid",
    ])
    expect(translated.warnings).toHaveLength(4)
    for (const pattern of [
      "!keep.txt",
      "cache[0-9]",
      "build/{tmp,out}",
      "*.@(log|tmp)",
    ]) {
      expect(
        translated.warnings.some((warning) => warning.includes(pattern))
      ).toBe(true)
    }
  })
})

describe("restic driver", () => {
  it("reports backup progress and the snapshot from restic's JSON stream", async () => {
    const { spawn } = fakeRestic((restic) => {
      queueMicrotask(() => {
        restic.stdout.write('{"message_type":"status","bytes_do')
        restic.stdout.write('ne":10,"total_bytes":40}\nnot-json\n')
        restic.stdout.write('{"message_type":"verbose_status"}\n')
        restic.finish(0, {
          stdout:
            '{"message_type":"summary","snapshot_id":"abc12345","total_bytes_processed":40}',
        })
      })
    })
    const progress: Array<ResticProgress> = []
    const summary = await createResticDriver({ spawn }).backup({
      cwd: testDirectory,
      excludes: [],
      location: localLocation,
      onProgress: (next) => progress.push(next),
      password: "secret",
      path: "instance",
      signal: new AbortController().signal,
      tags: ["task:1"],
    })
    expect(summary).toEqual({ snapshotId: "abc12345", totalBytesProcessed: 40 })
    expect(progress).toEqual([{ bytesCompleted: 10, bytesTotal: 40 }])
  })

  it("fails a backup that exits cleanly without reporting a snapshot", async () => {
    const { spawn } = fakeRestic((restic) => restic.respond({ exitCode: 0 }))
    await expect(
      createResticDriver({ spawn }).backup({
        cwd: testDirectory,
        excludes: [],
        location: localLocation,
        password: "secret",
        path: "instance",
        signal: new AbortController().signal,
        tags: ["task:1"],
      })
    ).rejects.toMatchObject({ code: "restic_backup_summary_missing" })
  })

  it("kills restic when the command promise rejects while the restic is running", async () => {
    const { processes, spawn } = fakeRestic((restic) => {
      restic.onSignal = () => restic.finish(1)
      queueMicrotask(() => {
        restic.stdout.write(
          '{"message_type":"status","bytes_done":10,"total_bytes":99}\n'
        )
      })
    })
    await expect(
      createResticDriver({ spawn }).backup({
        cwd: testDirectory,
        excludes: [],
        location: localLocation,
        onProgress: () => {
          throw new Error("too large")
        },
        password: "secret",
        path: "instance",
        signal: new AbortController().signal,
        tags: ["task:1"],
      })
    ).rejects.toThrow("too large")
    expect(processes[0]?.signals).toContain("SIGTERM")
    expect(processes[0]?.exited).toBe(true)
  })

  it("kills restic when abort wins the spawn-to-listener race", async () => {
    const abort = new AbortController()
    const { processes, spawn } = fakeRestic((restic) => {
      abort.abort()
      restic.onSignal = () => restic.finish(1)
    })
    await expect(
      createResticDriver({ spawn }).catConfig({
        location: s3Location,
        password: "secret",
        signal: abort.signal,
      })
    ).rejects.toMatchObject({ code: "restic_command_aborted" })
    expect(processes[0]?.signals).toContain("SIGTERM")
    expect(processes[0]?.exited).toBe(true)
  })

  it("force-kills restic when it ignores cancellation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const abort = new AbortController()
    const { processes, spawn } = fakeRestic((restic) => {
      abort.abort()
      restic.onSignal = (signal) => {
        if (signal === "SIGKILL") restic.finish(1)
      }
    })
    const cancelled = createResticDriver({ spawn }).catConfig({
      location: localLocation,
      password: "secret",
      signal: abort.signal,
    })
    await advanceUntilSettled(cancelled)
    await expect(cancelled).rejects.toMatchObject({
      code: "restic_command_aborted",
    })
    expect(processes[0]?.signals).toContain("SIGKILL")
    expect(processes[0]?.exited).toBe(true)
  })

  it("does not wait for restic streams to reach EOF after abort", async () => {
    const abort = new AbortController()
    const { processes, spawn } = fakeRestic((restic) => {
      abort.abort()
      restic.onSignal = () => restic.exit(1)
    })
    try {
      await expect(
        createResticDriver({ spawn }).catConfig({
          location: s3Location,
          password: "secret",
          signal: abort.signal,
        })
      ).rejects.toMatchObject({ code: "restic_command_aborted" })
    } finally {
      processes[0]?.stdout.end()
      processes[0]?.stderr.end()
    }
  })

  it("reports abort when it arrives after a successful child exit", async () => {
    const abort = new AbortController()
    const { processes, spawn } = fakeRestic((restic) => {
      queueMicrotask(() => {
        restic.stdout.write("{}")
        restic.exit(0)
        abort.abort()
      })
    })
    try {
      await expect(
        createResticDriver({ spawn }).catConfig({
          location: s3Location,
          password: "secret",
          signal: abort.signal,
        })
      ).rejects.toMatchObject({ code: "restic_command_aborted" })
      expect(processes[0]?.signals).toEqual([])
    } finally {
      processes[0]?.stdout.end()
      processes[0]?.stderr.end()
    }
  })

  it("finds a snapshot by tag and reads its restore size", async () => {
    const { spawn } = fakeRestic((restic) => {
      if (restic.command === "snapshots" && restic.args.includes("task:1")) {
        restic.respond({ stdout: JSON.stringify([{ id: "abcdef12" }]) })
      } else if (restic.command === "stats") {
        restic.respond({ stdout: JSON.stringify({ total_size: 2048 }) })
      } else {
        restic.respond({ stdout: "[]" })
      }
    })
    const driver = createResticDriver({ spawn })
    const snapshots = await driver.snapshotsByTag({
      location: localLocation,
      password: "secret",
      signal: new AbortController().signal,
      tag: "task:1",
    })
    expect(snapshots).toEqual([{ id: "abcdef12" }])
    const stats = await driver.stats({
      location: localLocation,
      password: "secret",
      signal: new AbortController().signal,
      snapshotId: "abcdef12",
    })
    expect(stats.totalSize).toBe(2048)
  })

  it("treats a missing snapshot as a successful forget", async () => {
    const { spawn } = fakeRestic((restic) =>
      restic.respond({
        exitCode: 1,
        stderr: 'Fatal: no matching ID found for sequence "deadbeef"',
      })
    )
    await expect(
      createResticDriver({ spawn }).forget({
        location: localLocation,
        password: "secret",
        signal: new AbortController().signal,
        snapshotId: "deadbeef",
      })
    ).resolves.toBeUndefined()
  })

  it("exports the instance directory of a snapshot as a zip", async () => {
    const archive = Buffer.from("PK\u0003\u0004fake-zip-body")
    const selector = resticSnapshotSelector(
      "abcdef12",
      "/data/instances/server-one"
    )
    const { spawn } = fakeRestic((restic) => {
      const dumpsInstanceRoot =
        restic.command === "dump" &&
        restic.args.includes(selector) &&
        restic.args.at(-1) === "/"
      restic.respond(
        dumpsInstanceRoot
          ? { stdout: archive }
          : { exitCode: 1, stderr: "Fatal: path not found in snapshot" }
      )
    })
    const destination = join(testDirectory, "exports", "export.zip")
    const exported = await createResticDriver({ spawn }).dumpZip({
      destination,
      location: localLocation,
      password: "secret",
      selector,
      signal: new AbortController().signal,
    })
    expect(await readFile(destination)).toEqual(archive)
    expect(exported).toEqual({
      bytes: archive.byteLength,
      checksumSha256: createHash("sha256").update(archive).digest("hex"),
    })
  })

  it("treats restic exit 10 as a missing repository and 12 as a wrong password", async () => {
    const missing = fakeRestic((restic) =>
      restic.respond({
        exitCode: 10,
        stderr: "Fatal: repository does not exist",
      })
    )
    await expect(
      createResticDriver({ spawn: missing.spawn }).catConfig({
        location: localLocation,
        password: "secret",
        signal: new AbortController().signal,
      })
    ).resolves.toBe("missing")

    const wrongPassword = fakeRestic((restic) =>
      restic.respond({ exitCode: 12, stderr: "Fatal: wrong password" })
    )
    await expect(
      createResticDriver({ spawn: wrongPassword.spawn }).catConfig({
        location: localLocation,
        password: "secret",
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: "restic_wrong_password" })
  })

  it("runs local repositories without S3 credentials, proxy, or shared cache", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://evil.example:8080")
    vi.stubEnv("AWS_ACCESS_KEY_ID", "leaked-key")
    const cacheDirectory = join(testDirectory, "local-cache")
    const { processes, spawn } = fakeRestic((restic) => restic.respond({}))
    await createResticDriver({ cacheDirectory, spawn }).catConfig({
      location: localLocation,
      password: "repo-secret",
      signal: new AbortController().signal,
    })
    const env = processes[0]?.env ?? {}
    expect(env.RESTIC_REPOSITORY).toBe(join(testDirectory, "repo"))
    expect(env.RESTIC_PASSWORD).toBe("repo-secret")
    expect(env.RESTIC_CACHE_DIR).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(existsSync(cacheDirectory)).toBe(false)
  })
})

describe("restic staging validation", () => {
  it("accepts a regular file tree without warnings", async () => {
    const valid = join(testDirectory, "valid-staging")
    await mkdir(join(valid, "world"), { recursive: true })
    await writeFile(join(valid, "world", "level.dat"), "ok")
    const checked = await validateStagingTree(valid, { diskBytes: 10_000 })
    expect(checked).toEqual({ entries: 2, logicalBytes: 2, warnings: [] })
  })

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
  it("fails like a missing password when S3 credentials are absent", () => {
    expect(() =>
      resticDriverLocation({ dataDirectory: "/data" } as never, "instance-1", {
        allowPrivateNetwork: false,
        bucket: "kiln-backups",
        endpoint: "https://s3.example.com",
        forcePathStyle: true,
        kind: "s3",
        region: "us-east-1",
        repositoryPrefix: "team/repo",
      })
    ).toThrow(
      expect.objectContaining({ code: "repository_credentials_missing" })
    )
  })

  it("sanitizes the restic environment and keeps secrets out of argv", async () => {
    vi.stubEnv("AWS_SESSION_TOKEN", "leaked-session")
    vi.stubEnv("HTTPS_PROXY", "http://evil.example:8080")
    vi.stubEnv("HTTP_PROXY", "http://evil.example:8080")
    const cacheDirectory = join(testDirectory, "restic-cache")
    const { processes, spawn } = fakeRestic((restic) => restic.respond({}))
    await createResticDriver({ cacheDirectory, spawn }).catConfig({
      location: s3Location,
      password: "repo-secret",
      signal: new AbortController().signal,
    })
    const call = processes[0]
    expect(call).toBeDefined()
    if (!call) return
    expect(call.env.AWS_SESSION_TOKEN).toBeUndefined()
    expect(call.env.HTTP_PROXY).toBeUndefined()
    expect(call.env.HTTPS_PROXY).toMatch(
      /^http:\/\/user:[^@]+@127\.0\.0\.1:\d+$/u
    )
    expect(call.env.AWS_ACCESS_KEY_ID).toBe(s3Location.accessKeyId)
    expect(call.env.AWS_SECRET_ACCESS_KEY).toBe(s3Location.secretAccessKey)
    expect(call.env.RESTIC_PASSWORD).toBe("repo-secret")
    expect(call.env.RESTIC_REPOSITORY).toBe(
      "s3:https://s3.example.com/kiln-backups/team/kiln/relay/restic/instance/srv/repo"
    )
    expect(call.env.RESTIC_CACHE_DIR).toBe(cacheDirectory)
    expect(existsSync(cacheDirectory)).toBe(true)
    const argv = call.args.join(" ")
    for (const secret of [
      "repo-secret",
      s3Location.accessKeyId,
      s3Location.secretAccessKey,
    ]) {
      expect(argv).not.toContain(secret)
    }
  })

  it("clears stale S3 locks before mutating commands without breaking init", async () => {
    const repository = { initialized: false, locked: false }
    const { spawn } = fakeRestic((restic) => {
      if (restic.command === "init") {
        repository.initialized = true
        restic.respond({})
        return
      }
      if (!repository.initialized) {
        restic.respond({
          exitCode: 10,
          stderr: "Fatal: repository does not exist",
        })
        return
      }
      if (restic.command === "unlock") {
        repository.locked = false
        restic.respond({})
        return
      }
      restic.respond(
        repository.locked
          ? {
              exitCode: 11,
              stderr: "Fatal: unable to create lock: repository is locked",
            }
          : {}
      )
    })
    const driver = createResticDriver({ spawn })
    const signal = new AbortController().signal
    await driver.init({ location: s3Location, password: "secret", signal })
    expect(repository.initialized).toBe(true)

    repository.locked = true
    await expect(
      driver.forget({
        location: s3Location,
        password: "secret",
        signal,
        snapshotId: "deadbeef",
      })
    ).resolves.toBeUndefined()
  })

  it("redacts repository secrets from restic stderr", async () => {
    const { spawn } = fakeRestic((restic) =>
      restic.respond({
        exitCode: 1,
        stderr:
          "Fatal: could not use AKIAEXAMPLE or wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY with repo-secret",
      })
    )
    const failure = await createResticDriver({ spawn })
      .backup({
        cwd: testDirectory,
        excludes: [],
        location: s3Location,
        password: "repo-secret",
        path: "instance",
        signal: new AbortController().signal,
        tags: ["task:1"],
      })
      .then(
        () => null,
        (cause: unknown) => cause
      )
    expect(failure).toBeInstanceOf(RelayBackupError)
    const reason = failure instanceof RelayBackupError ? failure.reason : ""
    expect(reason).not.toContain("AKIAEXAMPLE")
    expect(reason).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
    expect(reason).not.toContain("repo-secret")
    expect(reason).toContain("[redacted]")
  })

  it("reports S3 cache cleanup failures to its caller", async () => {
    const { spawn } = fakeRestic((restic) =>
      restic.respond({ exitCode: 1, stderr: "cache cleanup failed" })
    )
    await expect(
      createResticDriver({ spawn }).cacheCleanup({
        location: s3Location,
        password: "secret",
        signal: new AbortController().signal,
      })
    ).rejects.toBeInstanceOf(RelayBackupError)
  })
})

/** A fake restic restic at the child-restic boundary. */
class FakeResticProcess {
  readonly child: ReturnType<ResticSpawn>
  readonly command: string | undefined
  readonly signals: Array<string> = []
  readonly stderr = new PassThrough()
  readonly stdout = new PassThrough()
  exited = false
  onSignal: (signal: string) => void = () => undefined

  constructor(
    readonly args: ReadonlyArray<string>,
    readonly env: NodeJS.ProcessEnv
  ) {
    this.command = resticSubcommand(args)
    this.child = Object.assign(new EventEmitter(), {
      kill: (signal?: NodeJS.Signals | number) => {
        const received = String(signal ?? "SIGTERM")
        this.signals.push(received)
        queueMicrotask(() => this.onSignal(received))
        return true
      },
      stderr: this.stderr,
      stdin: new PassThrough(),
      stdout: this.stdout,
    }) as unknown as ReturnType<ResticSpawn>
  }

  /** Emits the exit event without closing stdio. */
  exit(code: number): void {
    if (this.exited) return
    this.exited = true
    this.child.emit("close", code)
  }

  /** Closes stdio with optional final output, then exits. */
  finish(code: number, output: { stderr?: string; stdout?: string } = {}) {
    this.stdout.end(output.stdout ?? "")
    this.stderr.end(output.stderr ?? "")
    this.exit(code)
  }

  respond(output: {
    exitCode?: number
    stderr?: string
    stdout?: string | Buffer
  }): void {
    queueMicrotask(() => {
      this.stdout.end(output.stdout ?? "")
      this.stderr.end(output.stderr ?? "")
      this.exit(output.exitCode ?? 0)
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

function resticSubcommand(args: ReadonlyArray<string>): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (arg === "-o") {
      index += 1
      continue
    }
    if (!arg.startsWith("-")) return arg
  }
  return undefined
}

async function advanceUntilSettled(promise: Promise<unknown>): Promise<void> {
  let settled = false
  promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  for (let step = 0; step < 120 && !settled; step += 1) {
    await vi.advanceTimersByTimeAsync(1_000)
  }
}
