import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, vi } from "vite-plus/test"

import {
  deleteCloudflareRecordEffect,
  listCloudflareZonesEffect,
  replaceCloudflareAddressRecordEffect,
} from "@/effect/cloudflare-api"

describe("Cloudflare DNS records", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect("replaces an address record type through the batch API", () => {
    // A stateful stand-in for the zone, so the test asserts the records left
    // behind rather than the request that produced them.
    const zone = new Map<string, Record<string, unknown>>([
      [
        "old-record",
        { content: "203.0.113.10", name: "play.kiln.site", type: "A" },
      ],
    ])
    vi.stubGlobal(
      "fetch",
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const batch = JSON.parse(String(init?.body)) as {
          deletes: ReadonlyArray<{ id: string }>
          posts: ReadonlyArray<Record<string, unknown>>
        }
        for (const { id } of batch.deletes) zone.delete(id)
        const posts = batch.posts.map((record) => {
          zone.set("replacement-record", record)
          return { ...record, id: "replacement-record" }
        })
        return Response.json({ errors: [], result: { posts }, success: true })
      }
    )

    return Effect.gen(function* () {
      const replacement = yield* replaceCloudflareAddressRecordEffect(
        "api-token",
        "zone-id",
        "old-record",
        {
          content: "relay.example.com",
          name: "play.kiln.site",
          type: "CNAME",
        },
        "instance-id"
      )

      assert.strictEqual(replacement.id, "replacement-record")
      assert.deepEqual([...zone.keys()], ["replacement-record"])
      // Game traffic cannot pass through Cloudflare's HTTP proxy.
      assert.deepInclude(zone.get("replacement-record"), {
        content: "relay.example.com",
        name: "play.kiln.site",
        proxied: false,
        type: "CNAME",
      })
    })
  })

  it.effect("treats an already-removed DNS record as deleted", () => {
    vi.stubGlobal("fetch", async () =>
      Response.json(
        {
          errors: [{ code: 81_044, message: "DNS Record does not exist." }],
          result: null,
          success: false,
        },
        { status: 400 }
      )
    )

    return deleteCloudflareRecordEffect(
      "api-token",
      "zone-id",
      "missing-record"
    )
  })

  it.effect("lists every zone the token can reach across pages", () => {
    // A token scoped to an account can reach more zones than one page holds.
    const pages = [
      [{ id: "zone-b", name: "B.site", status: "active" }],
      [
        { id: "zone-a", name: "a.site", status: "active" },
        { id: "zone-c", name: "c.site", status: "pending" },
      ],
    ]
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const page = Number(new URL(String(input)).searchParams.get("page"))
        return Response.json({
          errors: [],
          result: pages[page - 1] ?? [],
          result_info: { total_pages: pages.length },
          success: true,
        })
      })
    )

    return Effect.gen(function* () {
      assert.deepEqual(yield* listCloudflareZonesEffect("api-token"), [
        { id: "zone-a", name: "a.site" },
        { id: "zone-b", name: "b.site" },
      ])
    })
  })
})
