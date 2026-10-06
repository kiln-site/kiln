import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { rejects } from "node:assert/strict"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterAll, assert, describe, it } from "@effect/vitest"

import {
  createResticDriver,
  isUnsupportedExcludePattern,
  parseResticJsonLine,
  progressFromResticStatus,
  resticDriverLocation,
  resticRepositoryString,
  summaryFromResticJson,
  translateExcludePatterns,
  validateStagingTree,
  resticSnapshotSelector,
  type ResticDriverLocation,
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

afterAll(() => {
  rmSync(testDirectory, { force: true, recursive: true })
})

describe("restic JSON parsing", () => {
  it("reads status and summary lines", () => {
    assert.deepStrictEqual(
      progressFromResticStatus(
        parseResticJsonLine(
          '{"message_type":"status","bytes_done":10,"total_bytes":40}'
        )
      ),
      { bytesCompleted: 10, bytesTotal: 40 }
    )
    assert.deepStrictEqual(
      summaryFromResticJson(
        parseResticJsonLine(
          '{"message_type":"summary","snapshot_id":"abc12345","total_bytes_processed":40}'
        )
      ),
      { snapshotId: "abc12345", totalBytesProcessed: 40 }
    )
    assert.isNull(parseResticJsonLine("not-json"))
    assert.isNull(progressFromResticStatus({ message_type: "verbose_status" }))
  })
})

describe("restic exclude translation", () => {
  it("translates the supported subset and warns on unsupported patterns", () => {
    const translated = translateExcludePatterns([
      "# comment",
      "",
      ".DS_Store",
      "logs/**",
      "*.pid",
      "!keep.txt",
      "cache[0-9]",
      "build/{tmp,out}",
    ])
    assert.deepStrictEqual(translated.excludes, [
      ".DS_Store",
      "**/.DS_Store",
      "logs/**",
      "*.pid",
      "**/*.pid",
    ])
    assert.include(translated.warnings[0] ?? "", "negation")
    assert.include(translated.warnings[1] ?? "", "cache[0-9]")
    assert.include(translated.warnings[2] ?? "", "build/{tmp,out}")
    assert.isTrue(isUnsupportedExcludePattern("!(foo)"))
    assert.isFalse(isUnsupportedExcludePattern("world/**"))
  })
})

describe("restic driver", () => {
  it("passes --no-cache instead of an empty RESTIC_CACHE_DIR", async () => {
    let args: Array<string> | undefined
    let env: NodeJS.ProcessEnv | undefined
    const spawn: ResticSpawn = (_command, received, options) => {
      args = [...received]
      env = options.env
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const child = new EventEmitter() as ReturnType<ResticSpawn>
      child.stdout = stdout
      child.stderr = stderr
      child.stdin = new PassThrough()
      child.kill = () => true
      queueMicrotask(() => {
        stdout.end()
        stderr.end()
        child.emit("close", 0)
      })
      return child
    }
    const driver = createResticDriver({ spawn })
    await driver.catConfig({
      password: "secret",
      location: { kind: "local", path: join(testDirectory, "repo") },
      signal: new AbortController().signal,
    })
    assert.strictEqual(args?.[0], "--no-cache")
    assert.isUndefined(env?.RESTIC_CACHE_DIR)
  })

  it("kills restic when the command promise rejects while the process is running", async () => {
    let killed: string | undefined
    const spawn: ResticSpawn = () => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const child = new EventEmitter() as ReturnType<ResticSpawn>
      child.stdout = stdout
      child.stderr = stderr
      child.stdin = new PassThrough()
      child.kill = (signal) => {
        killed = String(signal ?? "SIGTERM")
        queueMicrotask(() => {
          stdout.end()
          stderr.end()
          child.emit("close", 1)
        })
        return true
      }
      queueMicrotask(() => {
        stdout.write(
          '{"message_type":"status","bytes_done":10,"total_bytes":99}\n'
        )
      })
      return child
    }
    const driver = createResticDriver({ spawn })
    let thrown = false
    try {
      await driver.backup({
        cwd: testDirectory,
        excludes: [],
        onProgress: () => {
          throw new Error("too large")
        },
        password: "secret",
        path: "instance",
        location: { kind: "local", path: join(testDirectory, "repo") },
        signal: new AbortController().signal,
        tags: ["task:1"],
      })
    } catch {
      thrown = true
    }
    assert.isTrue(thrown)
    assert.strictEqual(killed, "SIGTERM")
  })

  it("kills restic when abort wins the spawn-to-listener race", async () => {
    const abort = new AbortController()
    let killed: string | undefined
    const spawn: ResticSpawn = () => {
      abort.abort()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const child = new EventEmitter() as ReturnType<ResticSpawn>
      child.stdout = stdout
      child.stderr = stderr
      child.stdin = new PassThrough()
      child.kill = (signal) => {
        killed = String(signal ?? "SIGTERM")
        queueMicrotask(() => {
          stdout.end()
          stderr.end()
          child.emit("close", 1)
        })
        return true
      }
      return child
    }
    const driver = createResticDriver({ spawn })

    await rejects(
      driver.catConfig({
        location: s3Location,
        password: "secret",
        signal: abort.signal,
      }),
      RelayBackupError
    )
    assert.strictEqual(killed, "SIGTERM")
  })

  it("escalates an ignored abort to SIGKILL", async () => {
    const abort = new AbortController()
    const signals: Array<string> = []
    const spawn: ResticSpawn = () => {
      abort.abort()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const child = new EventEmitter() as ReturnType<ResticSpawn>
      child.stdout = stdout
      child.stderr = stderr
      child.stdin = new PassThrough()
      child.kill = (signal) => {
        const received = String(signal ?? "SIGTERM")
        signals.push(received)
        if (received === "SIGKILL") {
          queueMicrotask(() => {
            stdout.end()
            stderr.end()
            child.emit("close", 1)
          })
        }
        return true
      }
      return child
    }
    const driver = createResticDriver({ spawn, terminateTimeoutMs: 10 })

    await rejects(
      driver.catConfig({
        location: s3Location,
        password: "secret",
        signal: abort.signal,
      }),
      RelayBackupError
    )
    assert.deepStrictEqual(signals, ["SIGTERM", "SIGKILL"])
  })

  it("does not wait for restic streams to reach EOF after abort", async () => {
    const abort = new AbortController()
    let stdout: PassThrough | undefined
    let stderr: PassThrough | undefined
    const spawn: ResticSpawn = () => {
      abort.abort()
      stdout = new PassThrough()
      stderr = new PassThrough()
      const child = new EventEmitter() as ReturnType<ResticSpawn>
      child.stdout = stdout
      child.stderr = stderr
      child.stdin = new PassThrough()
      child.kill = () => {
        queueMicrotask(() => child.emit("close", 1))
        return true
      }
      return child
    }
    const driver = createResticDriver({ spawn, terminateTimeoutMs: 10 })

    await rejects(
      driver.catConfig({
        location: s3Location,
        password: "secret",
        signal: abort.signal,
      }),
      RelayBackupError
    )
    stdout?.end()
    stderr?.end()
  })

  it("reports abort when it arrives after a successful child exit", async () => {
    const abort = new AbortController()
    let killed = 0
    let stdout: PassThrough | undefined
    let stderr: PassThrough | undefined
    const spawn: ResticSpawn = () => {
      stdout = new PassThrough()
      stderr = new PassThrough()
      const child = new EventEmitter() as ReturnType<ResticSpawn>
      child.stdout = stdout
      child.stderr = stderr
      child.stdin = new PassThrough()
      child.kill = () => {
        killed += 1
        return true
      }
      queueMicrotask(() => {
        stdout?.write("{}")
        child.emit("close", 0)
        abort.abort()
      })
      return child
    }
    const driver = createResticDriver({ spawn, terminateTimeoutMs: 10 })

    await rejects(
      driver.catConfig({
        location: s3Location,
        password: "secret",
        signal: abort.signal,
      }),
      RelayBackupError
    )
    assert.strictEqual(killed, 0)
    stdout?.end()
    stderr?.end()
  })

  it("reuses a snapshot tagged with the task id", async () => {
    const spawn = fakeResticSpawn([
      {
        match: (args) => args.includes("cat"),
        stdout: "{}",
      },
      {
        match: (args) => args.includes("--tag") && args.includes("task:task-1"),
        stdout: JSON.stringify([{ id: "abcdef12" }]),
      },
      {
        match: (args) => args.includes("stats"),
        stdout: JSON.stringify({ total_size: 2048 }),
      },
    ])
    const driver = createResticDriver({ spawn })
    const snapshots = await driver.snapshotsByTag({
      password: "secret",
      location: { kind: "local", path: join(testDirectory, "repo") },
      signal: new AbortController().signal,
      tag: "task:task-1",
    })
    assert.deepStrictEqual(snapshots, [{ id: "abcdef12" }])
    const stats = await driver.stats({
      password: "secret",
      location: { kind: "local", path: join(testDirectory, "repo") },
      signal: new AbortController().signal,
      snapshotId: "abcdef12",
    })
    assert.strictEqual(stats.totalSize, 2048)
  })

  it("treats a missing snapshot as a successful forget", async () => {
    const spawn = fakeResticSpawn([
      {
        exitCode: 1,
        match: (args) => args.includes("forget"),
        stderr: 'Fatal: no matching ID found for sequence "deadbeef"',
      },
    ])
    const driver = createResticDriver({ spawn })
    await driver.forget({
      password: "secret",
      location: { kind: "local", path: join(testDirectory, "repo") },
      signal: new AbortController().signal,
      snapshotId: "deadbeef",
    })
  })
})

describe("restic staging validation", () => {
  it("accepts a regular file tree without warnings", async () => {
    const valid = join(testDirectory, "valid-staging")
    await mkdir(join(valid, "world"), { recursive: true })
    await writeFile(join(valid, "world", "level.dat"), "ok")
    const checked = await validateStagingTree(valid, { diskBytes: 10_000 })
    assert.strictEqual(checked.entries, 2)
    assert.strictEqual(checked.logicalBytes, 2)
    assert.deepStrictEqual(checked.warnings, [])
  })

  it("drops symlinks with a warning instead of failing the restore", async () => {
    const staging = join(testDirectory, "symlink-staging")
    await mkdir(join(staging, "world"), { recursive: true })
    await writeFile(join(staging, "world", "level.dat"), "ok")
    await symlink("/etc/passwd", join(staging, "link"))
    const checked = await validateStagingTree(staging, { diskBytes: 10_000 })
    assert.strictEqual(checked.logicalBytes, 2)
    assert.strictEqual(checked.warnings.length, 1)
    assert.include(checked.warnings[0] ?? "", "link")
    assert.isFalse(existsSync(join(staging, "link")))
    assert.isTrue(existsSync(join(staging, "world", "level.dat")))
  })
})

describe("restic path layout", () => {
  it("dumps the snapshot subfolder as a zip rooted at /", async () => {
    let dumpArgs: Array<string> | undefined
    const spawn: ResticSpawn = (_command, args) => {
      dumpArgs = [...args]
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const child = new EventEmitter() as ReturnType<ResticSpawn>
      child.stdout = stdout
      child.stderr = stderr
      child.stdin = new PassThrough()
      child.kill = () => true
      queueMicrotask(() => {
        stdout.end()
        stderr.end()
        child.emit("close", 0)
      })
      return child
    }
    const driver = createResticDriver({ spawn })
    const destination = join(testDirectory, "export.zip")
    await driver.dumpZip({
      destination,
      password: "secret",
      location: { kind: "local", path: join(testDirectory, "repo") },
      selector: resticSnapshotSelector(
        "abcdef12",
        "/data/instances/server-one"
      ),
      signal: new AbortController().signal,
    })
    assert.deepStrictEqual(dumpArgs, [
      "--no-cache",
      "dump",
      "-a",
      "zip",
      "abcdef12:/data/instances/server-one",
      "/",
    ])
  })
})

describe("restic S3 driver", () => {
  it("builds an s3 repository URL from the stored prefix", () => {
    assert.strictEqual(
      resticRepositoryString(s3Location),
      "s3:https://s3.example.com/kiln-backups/team/kiln/relay/restic/instance/srv/repo"
    )
    assert.deepStrictEqual(
      resticDriverLocation({ dataDirectory: "/data" } as never, "instance-1", {
        ...s3Location,
        kind: "s3",
      }),
      s3Location
    )
  })

  it("fails like a missing password when S3 credentials are absent", () => {
    try {
      resticDriverLocation({ dataDirectory: "/data" } as never, "instance-1", {
        allowPrivateNetwork: false,
        bucket: "kiln-backups",
        endpoint: "https://s3.example.com",
        forcePathStyle: true,
        kind: "s3",
        region: "us-east-1",
        repositoryPrefix: "team/repo",
      })
      assert.fail("expected missing credentials")
    } catch (cause) {
      assert.isTrue(cause instanceof RelayBackupError)
      assert.strictEqual(
        cause instanceof RelayBackupError ? cause.code : null,
        "repository_credentials_missing"
      )
    }
  })

  it("sanitizes the restic environment and pins S3 options", async () => {
    const previousSession = process.env.AWS_SESSION_TOKEN
    const previousProxy = process.env.HTTPS_PROXY
    process.env.AWS_SESSION_TOKEN = "leaked-session"
    process.env.HTTPS_PROXY = "http://evil.example:8080"
    const calls: Array<{
      args: Array<string>
      env: NodeJS.ProcessEnv
    }> = []
    try {
      const spawn: ResticSpawn = (_command, received, options) => {
        calls.push({ args: [...received], env: { ...options.env } })
        return succeedingChild()
      }
      const driver = createResticDriver({
        cacheDirectory: join(testDirectory, "restic-cache"),
        spawn,
      })
      await driver.catConfig({
        location: s3Location,
        password: "repo-secret",
        signal: new AbortController().signal,
      })
    } finally {
      if (previousSession === undefined) delete process.env.AWS_SESSION_TOKEN
      else process.env.AWS_SESSION_TOKEN = previousSession
      if (previousProxy === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = previousProxy
    }
    const call = calls[0]
    assert.isDefined(call)
    if (!call) return
    assert.deepStrictEqual(call.args.slice(0, 4), [
      "-o",
      "s3.region=us-east-1",
      "-o",
      "s3.bucket-lookup=path",
    ])
    assert.strictEqual(call.env.AWS_SESSION_TOKEN, undefined)
    assert.strictEqual(
      call.env.AWS_SECRET_ACCESS_KEY,
      s3Location.secretAccessKey
    )
    assert.strictEqual(call.env.RESTIC_PASSWORD, "repo-secret")
    assert.strictEqual(
      call.env.RESTIC_REPOSITORY,
      resticRepositoryString(s3Location)
    )
    assert.strictEqual(
      call.env.RESTIC_CACHE_DIR,
      join(testDirectory, "restic-cache")
    )
    assert.match(
      call.env.HTTPS_PROXY ?? "",
      /^http:\/\/user:[^@]+@127\.0\.0\.1:\d+$/u
    )
    assert.isUndefined(call.env.HTTP_PROXY)
  })

  it("treats restic exit 10 as a missing repository and 12 as a wrong password", async () => {
    const driver = createResticDriver({
      spawn: fakeResticSpawn([
        {
          exitCode: 10,
          match: (args) => args.includes("cat"),
          stderr: "Fatal: repository does not exist",
        },
      ]),
    })
    const missing = await driver.catConfig({
      location: { kind: "local", path: join(testDirectory, "repo") },
      password: "secret",
      signal: new AbortController().signal,
    })
    assert.strictEqual(missing, "missing")

    const wrongPassword = createResticDriver({
      spawn: fakeResticSpawn([
        {
          exitCode: 12,
          match: (args) => args.includes("cat"),
          stderr: "Fatal: wrong password",
        },
      ]),
    })
    try {
      await wrongPassword.catConfig({
        location: { kind: "local", path: join(testDirectory, "repo") },
        password: "secret",
        signal: new AbortController().signal,
      })
      assert.fail("expected wrong password")
    } catch (cause) {
      assert.isTrue(cause instanceof RelayBackupError)
      assert.strictEqual(
        cause instanceof RelayBackupError ? cause.code : null,
        "restic_wrong_password"
      )
    }
  })

  it("unlocks S3 repositories before mutating commands but not before init", async () => {
    const commands: Array<string> = []
    const spawn: ResticSpawn = (_command, args) => {
      const command = args.includes("unlock")
        ? "unlock"
        : args.includes("init")
          ? "init"
          : args.includes("forget")
            ? "forget"
            : args.join(" ")
      commands.push(command)
      return succeedingChild()
    }
    const driver = createResticDriver({ spawn })
    const signal = new AbortController().signal
    await driver.init({ location: s3Location, password: "secret", signal })
    assert.deepStrictEqual(commands, ["init"])
    commands.length = 0
    await driver.forget({
      location: s3Location,
      password: "secret",
      signal,
      snapshotId: "deadbeef",
    })
    assert.deepStrictEqual(commands, ["unlock", "forget"])
  })

  it("redacts repository secrets from restic stderr", async () => {
    const driver = createResticDriver({
      spawn: fakeResticSpawn([
        {
          exitCode: 1,
          match: (args) => args.includes("backup"),
          stderr:
            "Fatal: could not use AKIAEXAMPLE or wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY with repo-secret",
        },
      ]),
    })
    try {
      await driver.backup({
        cwd: testDirectory,
        excludes: [],
        location: s3Location,
        password: "repo-secret",
        path: "instance",
        signal: new AbortController().signal,
        tags: ["task:1"],
      })
      assert.fail("expected backup failure")
    } catch (cause) {
      assert.isTrue(cause instanceof RelayBackupError)
      const reason = cause instanceof RelayBackupError ? cause.reason : ""
      assert.isFalse(reason.includes("AKIAEXAMPLE"))
      assert.isFalse(
        reason.includes("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
      )
      assert.isFalse(reason.includes("repo-secret"))
      assert.include(reason, "[redacted]")
    }
  })

  it("reports S3 cache cleanup failures to its caller", async () => {
    const driver = createResticDriver({
      spawn: fakeResticSpawn([
        {
          exitCode: 1,
          match: (args) => args.includes("cache"),
          stderr: "cache cleanup failed",
        },
      ]),
    })
    await rejects(
      driver.cacheCleanup({
        location: s3Location,
        password: "secret",
        signal: new AbortController().signal,
      }),
      RelayBackupError
    )
  })
})

function succeedingChild(): ReturnType<ResticSpawn> {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = new EventEmitter() as ReturnType<ResticSpawn>
  child.stdout = stdout
  child.stderr = stderr
  child.stdin = new PassThrough()
  child.kill = () => true
  queueMicrotask(() => {
    stdout.end()
    stderr.end()
    child.emit("close", 0)
  })
  return child
}

function fakeResticSpawn(
  responses: Array<{
    exitCode?: number
    match: (args: ReadonlyArray<string>) => boolean
    stderr?: string
    stdout?: string
  }>
): ResticSpawn {
  return (_command, args, options) => {
    const response = responses.find((candidate) => candidate.match(args))
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ReturnType<ResticSpawn>
    child.stdout = stdout
    child.stderr = stderr
    child.stdin = new PassThrough()
    child.kill = () => true
    queueMicrotask(() => {
      stdout.end(response?.stdout ?? "")
      stderr.end(response?.stderr ?? "")
      child.emit("close", response?.exitCode ?? 0)
    })
    void options
    return child
  }
}
