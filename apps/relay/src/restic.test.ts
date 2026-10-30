import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"

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

  respond(output: { exitCode?: number; stderr?: string }): void {
    queueMicrotask(() => {
      this.stdout.end("")
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
