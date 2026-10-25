import { assert, layer } from "@effect/vitest"
import type { RelaySecurityTargets } from "@workspace/contracts"
import { Effect } from "effect"

import type { GrypeFinding } from "@/effect/grype"
import {
  recordFindingsEffect,
  recordInventoryEffect,
  syncSecurityTargetsEffect,
  pendingSecurityAnnouncementsEffect,
  recordSecurityAnnouncementsEffect,
} from "@/effect/security"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, selectRows } from "@/test/seed"

const image = `sha256:${"a".repeat(64)}`
const appId = "b".repeat(40)

const report = (
  containers: RelaySecurityTargets["containers"]
): RelaySecurityTargets => ({
  containers,
  host: { architecture: null, docker: null, kernel: null, os: null },
  scanner: "syft 1.55.0",
})

const php = report([
  {
    component: "app",
    image: "php:8.3.0-fpm-alpine",
    imageId: image,
    resource: { id: appId, type: "app" },
    running: true,
  },
])

const finding = (
  vulnerabilityId: string,
  fixState: GrypeFinding["fixState"]
): GrypeFinding => ({
  cvss: null,
  description: null,
  epss: null,
  findingKey: vulnerabilityId.padEnd(64, "0").slice(0, 64),
  fixState,
  fixedVersion: fixState === "fixed" ? "8.3.5" : null,
  knownExploited: false,
  location: "/usr/local/bin/php",
  packageName: "php-fpm",
  packageSource: "php",
  packageType: "binary",
  packageVersion: "8.3.0",
  risk: 1,
  severity: 4,
  url: null,
  vulnerabilityId,
})

// What's news, as the worker finds it before delivering it.
const pending = Effect.map(
  pendingSecurityAnnouncementsEffect("relay-a"),
  ({ announcements }) =>
    announcements.flatMap((announcement) =>
      announcement.findings.map(
        (item) =>
          `${announcement.resourceType}:${item.vulnerabilityId}:${item.fixable ? "fixed" : "open"}${item.knownExploited ? ":exploited" : ""}`
      )
    )
)

// What's news, recorded as told once it's delivered.
const announced = Effect.gen(function* () {
  const news = yield* pending
  const { changes } = yield* pendingSecurityAnnouncementsEffect("relay-a")
  yield* recordSecurityAnnouncementsEffect("relay-a", changes)
  return news
})

const seedInventory = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay("relay-a")
  yield* syncSecurityTargetsEffect("relay-a", php)
  yield* recordInventoryEffect("relay-a", image, {
    collectedAt: 1,
    distro: "Alpine Linux v3.19",
    document: Buffer.from("{}"),
    generator: "syft 1.55.0",
    packageCount: 1,
  })
})

describeMysql("security", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "announces each vulnerability once it's delivered, and again once it can be fixed, is exploited, or comes back",
      () =>
        Effect.gen(function* () {
          yield* seedInventory

          yield* recordFindingsEffect("relay-a", image, 1, [
            finding("CVE-1", "not-fixed"),
            finding("CVE-2", "fixed"),
          ])
          // Until it's recorded as delivered, it's news every time.
          assert.deepStrictEqual((yield* pending).sort(), [
            "app:CVE-1:open",
            "app:CVE-2:fixed",
          ])
          assert.deepStrictEqual((yield* announced).sort(), [
            "app:CVE-1:open",
            "app:CVE-2:fixed",
          ])
          // Checking the same findings against newer data is no news.
          yield* recordFindingsEffect("relay-a", image, 2, [
            finding("CVE-1", "not-fixed"),
            finding("CVE-2", "fixed"),
          ])
          assert.deepStrictEqual(yield* announced, [])

          // A fix coming out is.
          yield* recordFindingsEffect("relay-a", image, 3, [
            finding("CVE-1", "fixed"),
            finding("CVE-2", "fixed"),
          ])
          assert.deepStrictEqual(yield* announced, ["app:CVE-1:fixed"])

          // So is its being exploited.
          yield* recordFindingsEffect("relay-a", image, 4, [
            finding("CVE-1", "fixed"),
            { ...finding("CVE-2", "fixed"), knownExploited: true },
          ])
          assert.deepStrictEqual(yield* announced, [
            "app:CVE-2:fixed:exploited",
          ])

          // One that goes away is forgotten, so it's news when it returns.
          yield* recordFindingsEffect("relay-a", image, 5, [
            { ...finding("CVE-2", "fixed"), knownExploited: true },
          ])
          assert.deepStrictEqual(yield* announced, [])
          yield* recordFindingsEffect("relay-a", image, 6, [
            finding("CVE-1", "fixed"),
            { ...finding("CVE-2", "fixed"), knownExploited: true },
          ])
          assert.deepStrictEqual(yield* announced, ["app:CVE-1:fixed"])
        })
    )

    it.effect(
      "forgets an image's inventory and findings once nothing runs it",
      () =>
        Effect.gen(function* () {
          yield* seedInventory
          yield* recordFindingsEffect("relay-a", image, 1, [
            finding("CVE-1", "fixed"),
          ])
          yield* announced

          yield* syncSecurityTargetsEffect("relay-a", report([]))

          const inventories = yield* selectRows<{ sbom_key: string }>(
            "security_sbom"
          )
          assert.deepStrictEqual(
            inventories.map((row) => row.sbom_key),
            ["host"]
          )
          assert.strictEqual((yield* selectRows("security_finding")).length, 0)
          assert.strictEqual((yield* selectRows("security_alert")).length, 0)
        })
    )
  })
})
