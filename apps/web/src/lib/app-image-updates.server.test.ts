import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"

import { recordAppImageCheckEffect } from "@/effect/app-image-updates"
import { createAppRecordEffect } from "@/effect/managed-apps"
import {
  listNotificationsEffect,
  notifyUsersEffect,
} from "@/effect/notifications"
import { resolveAppImageUpdateNotificationsEffect } from "@/lib/app-image-updates.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertUser } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

const relayId = "r".repeat(43)
const appId = "a".repeat(40)
const image = "ghcr.io/kiln-site/marketing:latest"
const digest = (n: number) => `sha256:${String(n).repeat(64)}`

// What a check announces for an image, as the app's deployers get it.
const announce = (n: number) =>
  notifyUsersEffect(["user-a"], `app.image-update:${appId}:${digest(n)}`, {
    digest: digest(n),
    image,
    kind: "app.image-update",
    resource: { id: appId, name: "Website", relayId, type: "app" },
  })

const offered = Effect.map(listNotificationsEffect("user-a"), (inbox) =>
  inbox.flatMap(({ content }) =>
    content.kind === "app.image-update" ? [content.digest] : []
  )
)

describeMysql("App image update notifications", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "keeps only the update on offer now, whichever check finishes last",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertUser("user-a")
          yield* insertRelay(relayId)
          yield* createAppRecordEffect({
            appId,
            createdBy: "user-a",
            name: "Website",
            relayId,
          })
          yield* TestClock.setTime(Date.UTC(2026, 9, 20))

          // One Hearth's check finds image 2; another's, image 3, and
          // announces it before the first gets to clearing.
          yield* recordAppImageCheckEffect(appId, image, {
            appId,
            latestDigest: digest(2),
            runningDigests: [digest(1)],
            status: "checked",
          })
          yield* announce(2)
          yield* recordAppImageCheckEffect(appId, image, {
            appId,
            latestDigest: digest(3),
            runningDigests: [digest(1)],
            status: "checked",
          })
          yield* announce(3)
          yield* resolveAppImageUpdateNotificationsEffect(appId)
          assert.deepStrictEqual(yield* offered, [digest(3)])

          // Deploying the update installs it.
          yield* resolveAppImageUpdateNotificationsEffect(appId, {
            installedDigest: digest(3),
          })
          assert.deepStrictEqual(yield* offered, [])
        })
    )
  })
})
