import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertInstance,
  insertRelay,
  insertRows,
  insertUser,
} from "@/test/seed"

import {
  getResourceSecurityHandler,
  getSecurityPackagesHandler,
  getSecurityOverviewHandler,
} from "./security.server"

const signedIn = vi.hoisted(() => ({ id: "viewer" }))
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireEligibleResourceUser: async () => ({
    id: signedIn.id,
    role: "user",
  }),
}))

const relayId = "relay-a"
const imageId = `sha256:${"a".repeat(64)}`
const otherImageId = `sha256:${"b".repeat(64)}`
const viewerGrant = "11111111-1111-4111-8111-111111111111"
const strangerGrant = "22222222-2222-4222-8222-222222222222"

const target = (resourceId: string, sbomKey: string) => ({
  image: "nginx:1.21.0",
  inventory_since: 1,
  observed_at: 1,
  relay_id: relayId,
  resource_id: resourceId,
  resource_type: "instance",
  running: 1,
  sbom_key: sbomKey,
  target_key: `instance:${resourceId}`,
})

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertUser("viewer")
  yield* insertUser("stranger")
  yield* insertRelay(relayId)
  yield* insertInstance(relayId, "server-a", { owner_id: "viewer" })
  yield* insertInstance(relayId, "server-b", { owner_id: "stranger" })
  for (const [id, userId, resourceId] of [
    [viewerGrant, "viewer", "server-a"],
    [strangerGrant, "stranger", "server-b"],
  ] as const) {
    yield* insertGrant({
      id,
      relayId,
      resourceId,
      resourceType: "instance",
      userId,
    })
    yield* insertRows("access_selection", {
      access_id: id,
      selection_key: "instance.read",
      selection_kind: "permission",
    })
  }
  yield* insertRows("security_sbom", [
    {
      document: "{}",
      image: "nginx:1.21.0",
      matched_at: 1,
      matched_db: "1",
      relay_id: relayId,
      sbom_key: imageId,
    },
    { relay_id: relayId, sbom_key: otherImageId },
  ])
  yield* insertRows("security_target", [
    target("server-a", imageId),
    target("server-b", otherImageId),
  ])
  yield* insertRows("security_vulnerability", {
    id: "CVE-2021-23017",
    known_exploited: 1,
    severity: 4,
    updated_at: 1,
  })
  yield* insertRows("security_finding", {
    finding_key: "finding-a",
    first_seen_at: 1,
    fix_state: "fixed",
    fixed_version: "1.21.1",
    package_name: "nginx",
    package_type: "deb",
    package_version: "1.21.0",
    relay_id: relayId,
    sbom_key: imageId,
    severity: 4,
    vulnerability_id: "CVE-2021-23017",
  })
})

const as = <A>(userId: string, run: () => Promise<A>) =>
  Effect.promise(async () => {
    signedIn.id = userId
    return run().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ error, ok: false as const })
    )
  })

afterAll(() => disposeAppRuntime())

describeMysql("what people may see of a resource's vulnerabilities", () => {
  layer(TestDatabase)((it) => {
    const packages = () =>
      getSecurityPackagesHandler({ relayId, sbomKey: imageId })

    it.effect(
      "shows an image's vulnerabilities to who can see what runs it",
      () =>
        Effect.gen(function* () {
          yield* seed
          const seen = yield* as("viewer", packages)
          assert.isTrue(seen.ok)
          if (seen.ok) {
            assert.deepStrictEqual(
              seen.value.flatMap((found) =>
                found.vulnerabilities.map(
                  (vulnerability) => vulnerability.vulnerabilityId
                )
              ),
              ["CVE-2021-23017"]
            )
          }
        })
    )

    it.effect("refuses someone else on the same Relay", () =>
      Effect.gen(function* () {
        yield* seed
        assert.isFalse((yield* as("stranger", packages)).ok)
      })
    )

    it.effect("refuses an image nothing they can see runs", () =>
      Effect.gen(function* () {
        yield* seed
        const seen = yield* as("viewer", () =>
          getSecurityPackagesHandler({ relayId, sbomKey: otherImageId })
        )
        assert.isFalse(seen.ok)
      })
    )

    it.effect("lists only what the viewer can see, with one verdict each", () =>
      Effect.gen(function* () {
        yield* seed
        const seen = yield* as("viewer", () =>
          getSecurityOverviewHandler({ scope: null })
        )
        assert.isTrue(seen.ok)
        if (seen.ok) {
          assert.deepStrictEqual(
            seen.value.items.map((item) => [item.key, item.verdict]),
            [[`${relayId}/${imageId}`, "unsafe"]]
          )
        }
      })
    )

    it.effect("keeps one Relay's findings from hiding another's", () =>
      Effect.gen(function* () {
        yield* seed
        const otherRelay = "relay-b"
        yield* insertRelay(otherRelay)
        yield* insertInstance(otherRelay, "server-c", { owner_id: "viewer" })
        const grant = "33333333-3333-4333-8333-333333333333"
        yield* insertGrant({
          id: grant,
          relayId: otherRelay,
          resourceId: "server-c",
          resourceType: "instance",
          userId: "viewer",
        })
        yield* insertRows("access_selection", {
          access_id: grant,
          selection_key: "instance.read",
          selection_kind: "permission",
        })
        // The same image, which this Relay says holds nothing.
        yield* insertRows("security_sbom", {
          document: "{}",
          image: "nginx:1.21.0",
          matched_at: 1,
          matched_db: "1",
          relay_id: otherRelay,
          sbom_key: imageId,
        })
        yield* insertRows("security_target", {
          ...target("server-c", imageId),
          relay_id: otherRelay,
        })
        const seen = yield* as("viewer", () =>
          getSecurityOverviewHandler({ scope: null })
        )
        assert.isTrue(seen.ok)
        if (seen.ok) {
          assert.deepStrictEqual(
            Object.fromEntries(
              seen.value.items.map((item) => [
                item.inventory.relayId,
                item.verdict,
              ])
            ),
            { [otherRelay]: "clean", [relayId]: "unsafe" }
          )
        }
      })
    )

    it.effect("says nothing of a resource they can't see", () =>
      Effect.gen(function* () {
        yield* seed
        const seen = yield* as("stranger", () =>
          getResourceSecurityHandler({
            scope: `server:${relayId}:server-a`,
          })
        )
        assert.deepStrictEqual(seen, { ok: true, value: null })
      })
    )
  })
})
