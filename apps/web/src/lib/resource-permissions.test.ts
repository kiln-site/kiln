import { Effect, Layer } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { describe, expect, it } from "vite-plus/test"

import { Database } from "@/effect/database"
import { grantHasPermission } from "@/lib/permissions"
import {
  effectiveScopePermissions,
  loadResourceGrantsEffect,
  type ResourceScope,
} from "@/lib/resource-permissions"

const scope: ResourceScope = {
  relayId: "relay",
  resourceType: "instance",
  resourceId: "server",
}
const row = (id: string, resourceType = "instance", resourceId = "server") => ({
  id,
  relay_id: "relay",
  resource_type: resourceType,
  resource_id: resourceId,
  role: "admin",
})
const selection = (accessId: string, key: string) => ({
  access_id: accessId,
  selection_kind: "permission",
  selection_key: key,
})

function fixture(reads: ReadonlyArray<ReadonlyArray<unknown>>) {
  const queries: string[] = []
  let index = 0
  const layer = Layer.succeed(Database)({
    execute: () => Effect.die("Authorization reads must not mutate state"),
    transaction: () => Effect.die("Authorization reads must not lock state"),
    queryRows: <T extends RowDataPacket>(_operation: string, sql: string) =>
      Effect.sync(() => {
        queries.push(sql)
        if (index >= reads.length)
          throw new Error("Unexpected extra authorization query")
        return reads[index++] as ReadonlyArray<T>
      }),
  })
  return { layer, queries }
}

describe("effective resource authority", () => {
  it("keeps an explicitly empty grant empty even when its legacy role was admin", async () => {
    const data = fixture([[row("empty")], [], []])
    const grants = await Effect.runPromise(
      loadResourceGrantsEffect("user", "relay").pipe(Effect.provide(data.layer))
    )
    expect(grants[0]?.permissions).toEqual([])
    expect(grantHasPermission(grants[0]!, "instance.files.read")).toBe(false)
    expect(effectiveScopePermissions(grants, scope).size).toBe(0)
  })

  it("unions live preset selections with Relay inheritance and only the matching child scope", async () => {
    const grants = [
      row("relay-access", "relay", "relay"),
      row("server-access"),
      row("other-access", "instance", "other"),
    ]
    const before = fixture([
      grants,
      [
        selection("relay-access", "instance.files.read"),
        selection("server-access", "instance.console.read"),
        selection("other-access", "instance.delete"),
      ],
      [],
    ])
    const first = effectiveScopePermissions(
      await Effect.runPromise(
        loadResourceGrantsEffect("user", "relay").pipe(
          Effect.provide(before.layer)
        )
      ),
      scope
    )
    expect(first.has("instance.files.read")).toBe(true)
    expect(first.has("instance.console.read")).toBe(true)
    expect(first.has("instance.delete")).toBe(false)
    // A preset edit is observed on the next authorization read without changing
    // the membership rows or retaining an expanded permissions snapshot.
    const after = fixture([
      grants,
      [
        selection("relay-access", "instance.files.read"),
        selection("server-access", "instance.files.write"),
      ],
      [],
    ])
    const next = effectiveScopePermissions(
      await Effect.runPromise(
        loadResourceGrantsEffect("user", "relay").pipe(
          Effect.provide(after.layer)
        )
      ),
      scope
    )
    expect(next.has("instance.console.read")).toBe(false)
    expect(next.has("instance.files.write")).toBe(true)
    expect(after.queries[1]).toContain("preset_selection")
  })

  it("preserves owner authority without an access assignment and queries only active assignments", async () => {
    const data = fixture([[], [row("server", "instance", "server")]])
    const grants = await Effect.runPromise(
      loadResourceGrantsEffect("owner", "relay").pipe(
        Effect.provide(data.layer)
      )
    )
    expect(data.queries[0]).toContain("g.state = 'active'")
    expect(grants).toHaveLength(1)
    expect(grants[0]?.source).toBe("owner")
    expect(
      effectiveScopePermissions(grants, scope).has("instance.delete")
    ).toBe(true)
    expect(
      effectiveScopePermissions(grants, { ...scope, resourceId: "other" }).size
    ).toBe(0)
  })

  it("filters unsupported Redis and Valkey dump authority from explicit, preset ALL, and owner grants in three queries", async () => {
    const data = fixture([
      [
        { ...row("redis", "database", "redis"), engine: "redis" },
        { ...row("valkey", "database", "valkey"), engine: "valkey" },
        { ...row("postgres", "database", "postgres"), engine: "postgres" },
      ],
      [
        selection("redis", "database.dump.export"),
        selection("redis", "database.read"),
        {
          access_id: "valkey",
          selection_kind: "collection",
          selection_key: "all",
        },
        selection("postgres", "database.dump.export"),
      ],
      [{ ...row("owned-redis", "database", "owned-redis"), engine: "redis" }],
    ])
    const grants = await Effect.runPromise(
      loadResourceGrantsEffect("user", "relay").pipe(Effect.provide(data.layer))
    )
    expect(data.queries).toHaveLength(3)
    expect(data.queries[0]).toContain("d.database_id = g.resource_id")
    for (const id of ["redis", "valkey", "owner:database:owned-redis"]) {
      const grant = grants.find((grant) => grant.id === id)
      expect(grant?.permissions).toContain("database.read")
      expect(grant?.permissions).not.toContain("database.dump.export")
      expect(grant?.permissions).not.toContain("database.dump.import")
    }
    expect(
      grants.find((grant) => grant.id === "postgres")?.permissions
    ).toContain("database.dump.export")
  })

  it("deduplicates permissions shared by many live presets before validation", async () => {
    const data = fixture([
      [row("access")],
      Array.from({ length: 1000 }, () =>
        selection("access", "instance.files.read")
      ),
      [],
    ])
    const grants = await Effect.runPromise(
      loadResourceGrantsEffect("user", "relay").pipe(Effect.provide(data.layer))
    )
    expect(
      grants[0]?.permissions.filter(
        (permission) => permission === "instance.files.read"
      )
    ).toHaveLength(1)
    expect(data.queries[1]?.match(/g\.state = 'active'/gu)).toHaveLength(3)
  })
})
