import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import type { AppMount } from "@workspace/contracts"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import {
  createAppRecordEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { requireMigrationPermissions } from "@/lib/resource-migration-kinds/registry.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows, insertUser } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
afterAll(() => disposeAppRuntime())

const oldRelay = "1".repeat(12)
const newRelay = "2".repeat(12)
const appId = "a".repeat(12)

const mover: AuthenticatedUser = {
  email: "mover@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id: "mover",
  isDevelopmentBypass: false,
  name: "Mover",
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
}

// Granted on a Relay, as App permissions are: for every App on it.
const grant = (relayId: string, permissions: ReadonlyArray<AccessPermission>) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({
      id,
      relayId,
      resourceId: relayId,
      resourceType: "relay",
      state: "active",
      userId: mover.id,
    })
    yield* allow(id, permissions)
    return id
  })

const allow = (grantId: string, permissions: ReadonlyArray<AccessPermission>) =>
  insertRows(
    "access_selection",
    permissions.map((permission) => ({
      access_id: grantId,
      selection_kind: "permission",
      selection_key: permission,
    }))
  )

const nodePath: AppMount = {
  id: "nodepath01",
  readOnly: false,
  service: null,
  source: { path: "/var/run/docker.sock", type: "host" },
  target: "/var/run/docker.sock",
}

const copyIt = Effect.promise(() =>
  requireMigrationPermissions(mover, {
    destination: { relayId: newRelay },
    kind: "app",
    mode: "duplicate",
    options: {
      backup: null,
      copyAccess: false,
      deleteSource: null,
      keepActivity: false,
      limits: null,
      linkBackups: false,
      moveDomain: false,
      moveWebRoutes: false,
      stopSource: false,
    },
    source: { id: appId, relayId: oldRelay },
  }).then(
    () => null,
    (error: unknown) => error
  )
)

describeMysql("moving and duplicating an App", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "takes on the Relay it goes to what making an App with its settings takes",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertUser(mover.id)
          yield* insertUser("owner")
          yield* insertRelay(oldRelay, { created_by: "owner" })
          yield* insertRelay(newRelay, { created_by: "owner" })
          // Someone may manage the App, and make Apps where its copy goes,
          // but neither change the node's files there nor publish on it.
          yield* grant(oldRelay, [
            "app.read",
            "app.manage",
            "instance.files.read",
          ])
          const there = yield* grant(newRelay, ["app.read", "app.create"])
          yield* createAppRecordEffect({
            appId,
            createdBy: mover.id,
            name: "Website",
            relayId: oldRelay,
          })

          // Settings that carry nothing of the node's copy as they are.
          assert.isNull(yield* copyIt)

          // A path on the node reaches anything there, and its Compose file
          // can mount one too: the copy would carry both to the new node.
          for (const change of [
            { mounts: [nodePath] },
            { compose: "services:\n  web:\n    image: nginx\n" },
            {
              ports: [
                {
                  containerPort: 80,
                  hostPort: 8080,
                  protocol: "tcp" as const,
                },
              ],
            },
          ]) {
            yield* updateAppConfigEffect(oldRelay, appId, (config) => ({
              ...config,
              compose: "",
              mounts: [],
              ports: [],
              ...change,
            }))
            const refused = yield* copyIt
            assert.match(String(refused), /PermissionDeniedError|permission/u)
          }

          yield* allow(there, ["relay.files.write", "app.manage"])
          yield* updateAppConfigEffect(oldRelay, appId, (config) => ({
            ...config,
            compose: "services:\n  web:\n    image: nginx\n",
            mounts: [nodePath],
          }))
          assert.isNull(yield* copyIt)
        })
    )
  })
})
