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

// The bucket, as the bridge reaches one over HTTPS: here it only refuses.
const bucket = vi.hoisted(() => ({
  refuses: null as { body: string; status: number } | null,
}))

vi.mock("node:https", async (importOriginal) => {
  const https = await importOriginal<typeof import("node:https")>()
  const { PassThrough, Writable } = await import("node:stream")
  const request = (
    _url: URL,
    _options: unknown,
    respond: (response: unknown) => void
  ) => {
    const body = new Writable({
      write(_chunk, _encoding, written) {
        written()
      },
    })
    body.once("finish", () => {
      const response = Object.assign(new PassThrough(), {
        headers: {},
        statusCode: bucket.refuses?.status ?? 200,
      })
      respond(response)
      response.end(bucket.refuses?.body)
    })
    return Object.assign(body, { setTimeout: () => body })
  }
  return { ...https, default: { ...https, request }, request }
})

const testDirectory = mkdtempSync(join(tmpdir(), "kiln-restic-"))
// A repository in a bucket: restic is given no key, only a bridge on this
// machine that asks Hearth for each request.
const s3Location: ResticDriverLocation = {
  access: () => Promise.reject(new Error("Nothing was asked of Hearth")),
  kind: "s3",
  repositoryId: null,
}

afterEach(() => {
  vi.unstubAllEnvs()
  bucket.refuses = null
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

describe("restic with a repository in a bucket", () => {
  it("gives restic no key and no bucket, only the bridge's address", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "leaked-key")
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "leaked-secret")
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
    expect(
      Object.keys(call.env).filter((name) => /^AWS_|PROXY$/iu.test(name))
    ).toEqual([])
    expect(call.env.RESTIC_PASSWORD).toBe("repo-secret")
    expect(call.env.RESTIC_REPOSITORY).toMatch(
      /^rest:http:\/\/127\.0\.0\.1:\d+\/[\w-]{43}\/$/u
    )
    expect(call.env.RESTIC_CACHE_DIR).toBe(cacheDirectory)
    expect(existsSync(cacheDirectory)).toBe(true)
    expect(call.args.join(" ")).not.toContain("repo-secret")
  })

  it("keeps the repository's password, and the bridge's address, out of what restic said", async () => {
    const { spawn } = fakeRestic((restic) =>
      restic.respond({
        exitCode: 1,
        // As restic says a request to the repository failed, and names it.
        stderr: `Fatal: wrong password repo-secret\nGet "${restic.env.RESTIC_REPOSITORY!.slice("rest:".length)}config": EOF\n${restic.env.RESTIC_REPOSITORY}`,
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
    expect(reason).not.toContain("repo-secret")
    expect(reason).not.toContain("127.0.0.1")
    expect(reason).toContain("[redacted]")
  })

  it("fails with Hearth's refusal, whatever restic made of it", async () => {
    const refusal = RelayBackupError.make({
      code: "storage_access_refused",
      operation: "repository.access",
      reason: "Hearth refused access to the backup repository: no such task",
    })
    // restic, as far as it matters here: it asks the bridge for the
    // repository's config, and exits as it does when it can't open one.
    const { spawn } = fakeRestic((restic) => {
      void fetch(`${restic.env.RESTIC_REPOSITORY!.slice("rest:".length)}config`)
        .then((answer) => answer.arrayBuffer())
        .finally(() =>
          restic.respond({
            exitCode: 1,
            stderr: "Fatal: unable to open config",
          })
        )
    })
    const failure = await createResticDriver({ spawn })
      .forget({
        location: { ...s3Location, access: () => Promise.reject(refusal) },
        password: "repo-secret",
        signal: new AbortController().signal,
        snapshotId: "abcdef12",
      })
      .then(
        () => null,
        (cause: unknown) => cause
      )
    expect(failure).toBe(refusal)
  })

  // A bucket at its storage cap still serves what it holds, so a restore
  // or download must still work there.
  it("reads without a lock when the bucket refuses the lock file", async () => {
    bucket.refuses = {
      body: "<Error><Code>AccessDenied</Code><Message>Cannot upload files, storage cap exceeded.</Message></Error>",
      status: 403,
    }
    const { processes, spawn } = fakeRestic((restic) => {
      if (restic.args.includes("--no-lock")) {
        return restic.respond({ stdout: '{"total_size":42}\n' })
      }
      // restic, as far as it matters here: it writes its lock first, and
      // says which status that was answered with.
      void fetch(
        `${restic.env.RESTIC_REPOSITORY!.slice("rest:".length)}locks/${"ab".repeat(32)}`,
        { body: "lock", method: "POST" }
      ).then((answer) =>
        restic.respond({
          exitCode: 1,
          stderr: `Fatal: unable to create lock in backend: unexpected HTTP response (${answer.status}): ${answer.status} Forbidden`,
        })
      )
    })
    const size = await createResticDriver({ spawn }).stats({
      location: {
        ...s3Location,
        access: async () => ({
          allowPrivateNetwork: false,
          headers: {},
          method: "PUT",
          status: "granted",
          url: "https://bucket.example.com/repo/locks/lock",
        }),
      },
      password: "repo-secret",
      signal: new AbortController().signal,
      snapshotId: "abcdef12",
    })
    expect(size).toEqual({ totalSize: 42 })
    expect(processes.map(({ args }) => args.includes("--no-lock"))).toEqual([
      false,
      true,
    ])
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
