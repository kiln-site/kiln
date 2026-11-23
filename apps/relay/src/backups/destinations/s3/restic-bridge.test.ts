import type { BackupRepositoryAccessRequest } from "@workspace/contracts"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import {
  askHearthForRepositoryAccess,
  withResticBridge,
  type ResticRepositoryAccess,
} from "./restic-bridge.js"

// A bucket, faked where the Relay leaves the machine: objects by their path.
const bucket = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  refuses: null as { body: string; status: number } | null,
  unreachable: null as Error | null,
  requests: [] as Array<{ lookup: unknown; method?: string }>,
}))

vi.mock("node:https", async (importOriginal) => {
  const https = await importOriginal<typeof import("node:https")>()
  const { PassThrough, Writable } = await import("node:stream")
  const request = (
    url: URL,
    options: {
      headers: Record<string, string>
      lookup?: unknown
      method?: string
    },
    respond: (response: unknown) => void
  ) => {
    bucket.requests.push({ lookup: options.lookup, method: options.method })
    const sent: Array<Buffer> = []
    const answer = (
      statusCode: number,
      content: Buffer | string = "",
      headers: Record<string, string> = {}
    ) => {
      const response = Object.assign(new PassThrough(), {
        headers: { "content-length": String(content.length), ...headers },
        statusCode,
      })
      respond(response)
      response.end(options.method === "HEAD" ? undefined : content)
    }
    const body = new Writable({
      write(chunk: Buffer, _encoding, written) {
        sent.push(chunk)
        written()
      },
      final(finished) {
        finished()
        const object = bucket.objects.get(url.pathname)
        const range = /^bytes=(\d+)-(\d+)$/u.exec(options.headers.range ?? "")
        if (bucket.unreachable) {
          this.emit("error", bucket.unreachable)
        } else if (bucket.refuses) {
          answer(bucket.refuses.status, bucket.refuses.body)
        } else if (options.method === "PUT") {
          bucket.objects.set(url.pathname, Buffer.concat(sent))
          answer(200)
        } else if (options.method === "DELETE") {
          bucket.objects.delete(url.pathname)
          answer(204)
        } else if (!object) {
          answer(404, "<Error><Code>NoSuchKey</Code></Error>")
        } else if (range) {
          answer(206, object.subarray(Number(range[1]), Number(range[2]) + 1), {
            "content-range": `bytes ${range[1]}-${range[2]}/${object.length}`,
          })
        } else {
          answer(200, object)
        }
      },
    })
    return Object.assign(body, { setTimeout: () => body })
  }
  return { ...https, default: { ...https, request }, request }
})

afterEach(() => {
  vi.useRealTimers()
  bucket.objects.clear()
  bucket.refuses = null
  bucket.unreachable = null
  bucket.requests.length = 0
})

const repositoryId = "66666666-6666-4666-8666-666666666666"
const pack = `data/${"ab".repeat(32)}`

/** A Hearth that signs whatever it's asked, and lists two files a page. */
function hearth(options: { allowPrivateNetwork?: boolean } = {}) {
  const asked: Array<BackupRepositoryAccessRequest> = []
  const access: ResticRepositoryAccess = async (request) => {
    asked.push(request)
    if (request.method !== "LIST") {
      return {
        allowPrivateNetwork: options.allowPrivateNetwork ?? false,
        status: "signed",
        url: `https://bucket.example.com/${request.file}`,
      }
    }
    const files = [...bucket.objects]
      .filter(([path]) => path.startsWith(`/${request.folder}/`))
      .map(([path, content]) => ({
        name: path.split("/").at(-1)!,
        size: content.length,
      }))
    const from = Number(request.after ?? 0)
    return {
      files: files.slice(from, from + 2),
      next: files.length > from + 2 ? String(from + 2) : null,
      status: "listed",
    }
  }
  return { access, asked }
}

function bridged<T>(
  access: ResticRepositoryAccess,
  use: (url: string) => Promise<T>
) {
  return withResticBridge(access, repositoryId, (url) =>
    use(url.slice("rest:".length))
  )
}

describe("restic bridge", () => {
  it("carries what restic reads, writes, lists and deletes", async () => {
    const { access, asked } = hearth()
    await bridged(access, async (url) => {
      expect(
        (await fetch(`${url}?create=true`, { method: "POST" })).status
      ).toBe(200)
      expect((await fetch(`${url}config`, { method: "HEAD" })).status).toBe(404)
      const packs = ["1", "2", "3"].map((digit) => digit.repeat(64))
      for (const name of packs) {
        const sent = await fetch(`${url}data/${name}`, {
          body: `pack ${name}`,
          method: "POST",
        })
        expect(sent.status).toBe(200)
      }
      // Every page of the listing.
      const listed = await fetch(`${url}data/`)
      expect(listed.headers.get("content-type")).toBe(
        "application/vnd.x.restic.rest.v2"
      )
      expect(await listed.json()).toEqual(
        packs.map((name) => ({ name, size: 69 }))
      )
      const part = await fetch(`${url}data/${packs[0]}`, {
        headers: { range: "bytes=5-8" },
      })
      expect(part.status).toBe(206)
      expect(part.headers.get("content-range")).toBe("bytes 5-8/69")
      expect(await part.text()).toBe("1111")
      // 204 from a bucket, which restic would take for a failure.
      const deleted = await fetch(`${url}data/${packs[0]}`, {
        method: "DELETE",
      })
      expect(deleted.status).toBe(200)
      expect([...bucket.objects.keys()]).toEqual(
        packs.slice(1).map((name) => `/data/${name}`)
      )
    })
    expect(
      asked.every((request) => request.repositoryId === repositoryId)
    ).toBe(true)
  })

  it("asks Hearth once for a file read in many ranges", async () => {
    bucket.objects.set(`/${pack}`, Buffer.from("content"))
    const { access, asked } = hearth()
    await bridged(access, async (url) => {
      for (let index = 0; index < 5; index += 1) {
        await (
          await fetch(`${url}${pack}`, {
            headers: { range: `bytes=${index}-${index}` },
          })
        ).text()
      }
    })
    expect(bucket.requests).toHaveLength(5)
    expect(asked).toHaveLength(1)
  })

  it("answers only its secret path, and only for a repository's files", async () => {
    const { access, asked } = hearth()
    await bridged(access, async (url) => {
      const origin = new URL(url).origin
      for (const path of [
        `${origin}/${pack}`,
        `${origin}/wrong/${pack}`,
        `${url}data/..%2f..%2fother`,
        `${url}other/`,
      ]) {
        expect((await fetch(path)).status).toBe(404)
      }
    })
    expect(asked).toHaveLength(0)
  })

  it("says why the bucket or Hearth turned a request down", async () => {
    const { access } = hearth()
    await bridged(access, async (url) => {
      bucket.refuses = {
        body: "<Error><Code>AccessDenied</Code><Message>Cannot upload files, storage cap exceeded</Message></Error>",
        status: 403,
      }
      const capped = await fetch(`${url}${pack}`, { body: "x", method: "POST" })
      expect([capped.status, capped.statusText]).toEqual([
        403,
        "AccessDenied: Cannot upload files, storage cap exceeded",
      ])
      // Not a file that isn't there, which restic takes for a repository it
      // is to make, or one with nothing left to delete.
      bucket.refuses = {
        body: "<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>",
        status: 404,
      }
      const missing = await fetch(`${url}config`, { method: "HEAD" })
      expect([missing.status, missing.statusText]).toEqual([
        403,
        "NoSuchBucket: The specified bucket does not exist",
      ])
      // One that may pass: restic tries a 500 again.
      bucket.refuses = { body: "", status: 503 }
      expect((await fetch(`${url}${pack}`)).status).toBe(500)
    })
    // As Node fails for an endpoint with several addresses.
    bucket.unreachable = Object.assign(new AggregateError([]), {
      code: "ECONNREFUSED",
    })
    await bridged(access, async (url) => {
      const unreachable = await fetch(`${url}${pack}`)
      expect([unreachable.status, unreachable.statusText]).toEqual([
        500,
        "S3 storage couldn't be reached: ECONNREFUSED",
      ])
    })
    await bridged(
      async () => ({ reason: "no such repository", status: "refused" }),
      async (url) => {
        const refused = await fetch(`${url}${pack}`)
        expect([refused.status, refused.statusText]).toEqual([
          403,
          "Hearth refused: no such repository",
        ])
      }
    )
  })

  it("lets restic wait out a Hearth that restarts, but not one that stays away", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    bucket.objects.set(`/${pack}`, Buffer.from("content"))
    const { access } = hearth()
    let away = true
    await bridged(
      async (request) => {
        if (!away) return access(request)
        // A Hearth that fails to answer and one that isn't there.
        if (request.method === "DELETE") throw new Error("closed")
        return null
      },
      async (url) => {
        const status = async () => (await fetch(`${url}${pack}`)).status
        expect(await status()).toBe(500)
        vi.setSystemTime(Date.now() + 90_000)
        expect(
          (await fetch(`${url}${pack}`, { method: "DELETE" })).status
        ).toBe(500)
        away = false
        expect(await status()).toBe(200)
        away = true
        vi.setSystemTime(Date.now() + 6 * 60_000)
        // Away afresh, not since the first time.
        expect(await status()).toBe(500)
        vi.setSystemTime(Date.now() + 2 * 60_000 + 1)
        const given = await fetch(`${url}${pack}`)
        expect([given.status, given.statusText]).toEqual([
          403,
          "Hearth couldn't be reached",
        ])
      }
    )
  })

  it("keeps to public addresses unless the destination allows private ones", async () => {
    bucket.objects.set(`/${pack}`, Buffer.from("content"))
    for (const allowPrivateNetwork of [false, true]) {
      bucket.requests.length = 0
      await bridged(
        hearth({ allowPrivateNetwork }).access,
        async (url) => void (await (await fetch(`${url}${pack}`)).text())
      )
      expect(bucket.requests[0]?.lookup === undefined).toBe(allowPrivateNetwork)
    }
    await bridged(
      async () => ({
        allowPrivateNetwork: false,
        status: "signed",
        url: "https://10.0.0.1/object",
      }),
      async (url) => {
        expect((await fetch(`${url}${pack}`)).status).toBe(500)
      }
    )
  })
})

describe("asking Hearth for repository access", () => {
  const signed = {
    allowPrivateNetwork: false,
    status: "signed",
    url: "https://bucket.example.com/config",
  }
  const refused = { reason: "not mine", status: "refused" }
  const ask = (payloads: ReadonlyArray<unknown>) =>
    askHearthForRepositoryAccess(
      async () => payloads.map((payload) => ({ payload })),
      { file: "config", method: "GET", repositoryId }
    )

  it("takes the Hearth whose repository it is over one it isn't", async () => {
    expect(await ask([refused, signed])).toEqual(signed)
    expect(await ask([refused, null])).toEqual(refused)
    expect(await ask(["nonsense"])).toBeNull()
    expect(await ask([])).toBeNull()
  })
})
