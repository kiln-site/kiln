import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import type { BackupRepositoryAccessGrant } from "@workspace/contracts"

import { RelayBackupError } from "../effect/errors.js"
import {
  withResticBridge,
  type ResticRepositoryAccess,
} from "./restic-bridge.js"

// A bucket, as the bridge reaches one: over HTTPS, with requests Hearth
// signed. It keeps objects by their path and remembers what was asked of
// it.
const bucket = vi.hoisted(() => ({
  asked: [] as Array<{
    method: string | undefined
    signal: AbortSignal | undefined
    url: string
  }>,
  /** What it answers every request with, in place of serving it. */
  refuses: null as { body: string; status: number } | null,
  /** Leaves a read unanswered, as a slow one is. */
  silent: false,
  objects: new Map<string, Buffer>(),
}))

vi.mock("node:https", async (importOriginal) => {
  const https = await importOriginal<typeof import("node:https")>()
  const { PassThrough, Writable } = await import("node:stream")
  const request = (
    url: URL,
    options: {
      headers?: Record<string, string>
      method?: string
      signal?: AbortSignal
    },
    respond: (response: unknown) => void
  ) => {
    bucket.asked.push({
      method: options.method,
      signal: options.signal,
      url: url.toString(),
    })
    const sent: Array<Buffer> = []
    const body = new Writable({
      write(chunk: Buffer, _encoding, written) {
        sent.push(chunk)
        written()
      },
    })
    const answer = (
      statusCode: number,
      content?: Buffer | string,
      headers: Record<string, string> = {}
    ) => {
      const response = Object.assign(new PassThrough(), {
        headers:
          content === undefined
            ? headers
            : { "content-length": String(content.length), ...headers },
        statusCode,
      })
      respond(response)
      response.end(options.method === "HEAD" ? undefined : content)
    }
    body.once("finish", () => {
      if (bucket.silent) return
      if (bucket.refuses) {
        return answer(bucket.refuses.status, bucket.refuses.body)
      }
      const key = decodeURIComponent(url.pathname)
      if (options.method === "PUT") {
        bucket.objects.set(key, Buffer.concat(sent))
        return answer(200)
      }
      if (options.method === "DELETE") {
        bucket.objects.delete(key)
        return answer(204)
      }
      const object = bucket.objects.get(key)
      if (!object) return answer(404)
      const range = /^bytes=(\d+)-(\d+)$/u.exec(options.headers?.range ?? "")
      if (!range) return answer(200, object)
      const part = object.subarray(Number(range[1]), Number(range[2]) + 1)
      return answer(206, part, {
        "content-range": `bytes ${range[1]}-${range[2]}/${object.length}`,
      })
    })
    return Object.assign(body, { setTimeout: () => body })
  }
  return { ...https, default: { ...https, request }, request }
})

afterEach(() => {
  bucket.asked.length = 0
  bucket.objects.clear()
  bucket.refuses = null
  bucket.silent = false
})

const pack = "ab".repeat(32)
const other = "cd".repeat(32)

// A Hearth that signs whatever is asked, as it files a repository's
// objects: under one folder, a pack under its name's first two characters.
// It lists a folder itself, `pageSize` files at a time.
function signing(pageSize = 1000) {
  const asked: Array<Parameters<ResticRepositoryAccess>[0]> = []
  const access: ResticRepositoryAccess = async (request) => {
    asked.push(request)
    const grant = (
      method: BackupRepositoryAccessGrant["method"],
      path: string
    ): BackupRepositoryAccessGrant => ({
      allowPrivateNetwork: false,
      headers: {},
      method,
      status: "granted",
      url: `https://bucket.example.com/${path}`,
    })
    if (request.method === "LIST") {
      const from = Number(request.continuationToken ?? 0)
      const files = [...bucket.objects]
        .filter(([key]) => key.startsWith(`/repo/${request.type}/`))
        .map(([key, object]) => ({
          name: key.slice(key.lastIndexOf("/") + 1),
          size: object.length,
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
      return {
        files: files.slice(from, from + pageSize),
        next: from + pageSize < files.length ? String(from + pageSize) : null,
        status: "listed",
      }
    }
    const key =
      request.name === null
        ? `repo/${request.type}`
        : request.type === "data"
          ? `repo/data/${request.name.slice(0, 2)}/${request.name}`
          : `repo/${request.type}/${request.name}`
    return grant(request.method, key)
  }
  return { access, asked }
}

describe("restic's bridge to a repository in a bucket", () => {
  it("stores, reads in part, and removes a file with one signed request each", () => {
    const { access, asked } = signing()
    return withResticBridge(access, async (repository) => {
      const stored = await fetch(`${repository}data/${pack}`, {
        body: "0123456789",
        method: "POST",
      })
      expect(stored.status).toBe(200)
      expect(bucket.objects.get(`/repo/data/ab/${pack}`)?.toString()).toBe(
        "0123456789"
      )

      const head = await fetch(`${repository}data/${pack}`, { method: "HEAD" })
      expect(head.status).toBe(200)
      expect(head.headers.get("content-length")).toBe("10")

      const part = await fetch(`${repository}data/${pack}`, {
        headers: { range: "bytes=2-4" },
      })
      expect(part.status).toBe(206)
      expect(await part.text()).toBe("234")

      const removed = await fetch(`${repository}data/${pack}`, {
        method: "DELETE",
      })
      expect(removed.status).toBe(200)
      expect(bucket.objects.size).toBe(0)
      // restic takes a missing file as missing, not as the bucket failing.
      const gone = await fetch(`${repository}data/${pack}`, { method: "HEAD" })
      expect(gone.status).toBe(404)

      expect(asked.map(({ method, type }) => `${method} ${type}`)).toEqual([
        "PUT data",
        "HEAD data",
        "GET data",
        "DELETE data",
        "HEAD data",
      ])
    })
  })

  it("stores and reads the repository's config, which has no name", () => {
    const { access } = signing()
    return withResticBridge(access, async (repository) => {
      // Making a repository makes nothing in a bucket.
      expect(
        (await fetch(`${repository}?create=true`, { method: "POST" })).status
      ).toBe(200)
      await fetch(`${repository}config`, { body: "config", method: "POST" })
      expect(bucket.objects.get("/repo/config")?.toString()).toBe("config")
      expect(await (await fetch(`${repository}config`)).text()).toBe("config")
    })
  })

  it("lists a folder from every page Hearth reads of it", () => {
    const { access, asked } = signing(1)
    bucket.objects.set(`/repo/snapshots/${pack}`, Buffer.from("one"))
    bucket.objects.set(`/repo/snapshots/${other}`, Buffer.from("three"))
    return withResticBridge(access, async (repository) => {
      const listed = await fetch(`${repository}snapshots/`, {
        headers: { accept: "application/vnd.x.restic.rest.v2" },
      })
      expect(listed.headers.get("content-type")).toBe(
        "application/vnd.x.restic.rest.v2"
      )
      expect(await listed.json()).toEqual([
        { name: pack, size: 3 },
        { name: other, size: 5 },
      ])
      expect(asked.map((request) => request.continuationToken)).toEqual([
        undefined,
        "1",
      ])
      // The bucket itself is asked nothing: Hearth read it.
      expect(bucket.asked).toEqual([])
    })
  })

  // restic reports only the status it was answered with. A refusal goes
  // back as one, which restic doesn't try again, and what the bucket said
  // is kept for the run's failure: it is how a full bucket is told from a
  // broken one, and how a read is tried again without a lock.
  it("answers a write the bucket refuses as refused, and keeps what the bucket said", () => {
    const { access } = signing()
    bucket.refuses = {
      body: "<Error><Code>AccessDenied</Code><Message>Cannot upload files, storage cap exceeded.</Message><RequestId>1</RequestId></Error>",
      status: 403,
    }
    return withResticBridge(access, async (repository, bridge) => {
      const answer = await fetch(`${repository}locks/${pack}`, {
        body: "lock",
        method: "POST",
      })
      expect(answer.status).toBe(403)
      expect(bridge.turnedDown()).toBe(
        "The bucket answered HTTP 403: AccessDenied: Cannot upload files, storage cap exceeded."
      )
      expect(bridge.refused.aborted).toBe(false)

      // A bucket with no room says so its own way. restic takes that as
      // final too, where an unavailable bucket is tried for minutes.
      bucket.refuses = {
        body: "<Error><Code>XMinioStorageFull</Code><Message>Storage backend has reached its minimum free drive threshold.</Message></Error>",
        status: 507,
      }
      const full = await fetch(`${repository}locks/${pack}`, {
        body: "lock",
        method: "POST",
      })
      expect(full.status).toBe(507)
      expect(bridge.turnedDown()).toContain("XMinioStorageFull")
    })
  })

  it("asks Hearth for no more pages of a listing restic has given up on", async () => {
    const { access, asked } = signing(1)
    for (const name of [pack, other, "ef".repeat(32)]) {
      bucket.objects.set(`/repo/snapshots/${name}`, Buffer.from("x"))
    }
    const giveUp = new AbortController()
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await withResticBridge(
      // The first page takes long enough for restic to give up meanwhile.
      async (request) => {
        const page = await access(request)
        await held
        return page
      },
      async (repository) => {
        const listing = fetch(`${repository}snapshots/`, {
          signal: giveUp.signal,
        }).then(
          () => "answered",
          () => "given up"
        )
        await vi.waitFor(() => expect(asked).toHaveLength(1))
        giveUp.abort()
        expect(await listing).toBe("given up")
        // The bridge sees the request end before the page arrives.
        await new Promise((resolve) => setTimeout(resolve, 20))
        release()
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(asked).toHaveLength(1)
      }
    )
  })

  it("stops asking the bucket for a read restic has given up on", () => {
    const { access } = signing()
    bucket.silent = true
    return withResticBridge(access, async (repository) => {
      const giveUp = new AbortController()
      const reading = fetch(`${repository}data/${pack}`, {
        signal: giveUp.signal,
      }).then(
        () => "answered",
        () => "given up"
      )
      await vi.waitFor(() => expect(bucket.asked).toHaveLength(1))
      giveUp.abort()
      expect(await reading).toBe("given up")
      await vi.waitFor(() =>
        expect(bucket.asked[0]?.signal?.aborted).toBe(true)
      )
    })
  })

  it("ends the run with why Hearth refused, and sends nothing to the bucket", async () => {
    const refusal = RelayBackupError.make({
      code: "storage_access_refused",
      operation: "repository.access",
      reason: "Hearth refused access to the backup repository",
    })
    let aborted: unknown = null
    await withResticBridge(
      () => Promise.reject(refusal),
      async (repository, hearth) => {
        const answer = await fetch(`${repository}data/${pack}`, {
          body: "0123456789",
          method: "POST",
        })
        expect(answer.status).toBe(502)
        aborted = hearth.refused.aborted ? hearth.refused.reason : null
      }
    )
    expect(aborted).toBe(refusal)
    expect(bucket.asked).toEqual([])
  })

  // After a write that failed, restic removes the file before it tries
  // again. Hearth lets a backup remove no data, and a refusal ends the run:
  // the removal of what the bucket never stored is answered here.
  it("has restic try again while Hearth is away, and carries on once it is back", async () => {
    const { access, asked } = signing()
    const unreachable = RelayBackupError.make({
      code: "hearth_unreachable",
      operation: "repository.access",
      reason: "Hearth couldn't be reached",
    })
    let hearthAway = true
    await withResticBridge(
      (request) => (hearthAway ? Promise.reject(unreachable) : access(request)),
      async (repository, hearth) => {
        const store = () =>
          fetch(`${repository}data/${pack}`, {
            body: "0123456789",
            method: "POST",
          })
        // Unavailable is what restic tries again; the run isn't ended.
        expect((await store()).status).toBe(503)
        expect(hearth.refused.aborted).toBe(false)
        expect(hearth.away()).toBe(unreachable)
        hearthAway = false
        const cleared = await fetch(`${repository}data/${pack}`, {
          method: "DELETE",
        })
        expect(cleared.status).toBe(200)
        expect(asked).toEqual([])
        expect(hearth.refused.aborted).toBe(false)
        expect((await store()).status).toBe(200)
        expect(hearth.away()).toBeNull()
      }
    )
    expect(bucket.objects.size).toBe(1)
  })

  it("asks Hearth nothing for a request without its secret path, or for anything that isn't a file of a repository", () => {
    const { access, asked } = signing()
    return withResticBridge(access, async (repository) => {
      const url = new URL(repository)
      const statuses = await Promise.all(
        [
          `${url.origin}/data/${pack}`,
          `${url.origin}/wrong-secret/data/${pack}`,
          `${repository}data/not-a-file-name`,
          `${repository}data/${pack}/more`,
          `${repository}elsewhere/${pack}`,
          `${repository}config/${pack}`,
          `${repository}data/..%2F..%2Fother/${pack}`,
        ].map(async (address) => (await fetch(address)).status)
      )
      expect(statuses).toEqual([404, 404, 404, 404, 404, 404, 404])
      expect(asked).toEqual([])
      expect(bucket.asked).toEqual([])
    })
  })
})
