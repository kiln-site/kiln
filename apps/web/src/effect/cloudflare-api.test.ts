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
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          errors: [],
          result: {
            deletes: [{ id: "old-record" }],
            posts: [
              {
                id: "replacement-record",
                name: "play.kiln.site",
                type: "CNAME",
              },
            ],
          },
          success: true,
        })
    )
    vi.stubGlobal("fetch", fetchMock)

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
      assert.strictEqual(fetchMock.mock.calls.length, 1)
      const [url, init] = fetchMock.mock.calls[0] ?? []
      assert.strictEqual(
        url,
        "https://api.cloudflare.com/client/v4/zones/zone-id/dns_records/batch"
      )
      assert.strictEqual(init?.method, "POST")
      assert.deepEqual(JSON.parse(String(init?.body)), {
        deletes: [{ id: "old-record" }],
        posts: [
          {
            comment: "Managed by Kiln for server instance-id",
            content: "relay.example.com",
            name: "play.kiln.site",
            proxied: false,
            ttl: 1,
            type: "CNAME",
          },
        ],
      })
    })
  })

  it.effect("treats an already-removed DNS record as deleted", () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          errors: [{ code: 81_044, message: "DNS Record does not exist." }],
          result: null,
          success: false,
        },
        { status: 400 }
      )
    )
    vi.stubGlobal("fetch", fetchMock)

    return Effect.gen(function* () {
      yield* deleteCloudflareRecordEffect(
        "api-token",
        "zone-id",
        "missing-record"
      )

      assert.strictEqual(fetchMock.mock.calls.length, 1)
    })
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
