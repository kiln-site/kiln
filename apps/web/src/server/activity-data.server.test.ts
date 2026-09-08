import { beforeEach, describe, expect, it, vi } from "vite-plus/test"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { getActivityForUser } from "@/server/activity-data.server"

const mocks = vi.hoisted(() => ({
  grants: vi.fn(),
  query: vi.fn(),
  rpc: vi.fn(),
}))
vi.mock("@/lib/access-control", () => ({
  isPlatformAdmin: (user: AuthenticatedUser) => user.role === "admin",
  listUserGrants: mocks.grants,
}))
vi.mock("@/lib/account-policy", () => ({ requireEligibleAccount: vi.fn() }))
vi.mock("@/lib/database", () => ({ databasePool: { query: mocks.query } }))
vi.mock("@/lib/database-config", () => ({
  databaseTable: (name: string) => name,
}))
vi.mock("@/lib/relay-connection", () => ({ relayRpc: mocks.rpc }))
vi.mock("@/lib/relay-registry", () => ({
  listPersistedRelays: async () => [
    { id: "relay-a", name: "Relay A", enabled: true },
    { id: "relay-b", name: "Relay B", enabled: true },
  ],
}))

const user = { id: "viewer", role: "user" } as AuthenticatedUser
const records = [
  {
    id: "relay-event",
    details: { operation: "relay.rename", subject: "relay-actor" },
  },
  {
    id: "server-a-event",
    details: {
      instanceId: "server-a",
      operation: "instance.rename",
      subject: "actor-a",
    },
  },
  {
    id: "server-b-event",
    details: {
      instanceId: "server-b",
      operation: "instance.rename",
      subject: "actor-b",
    },
  },
].map((record) => ({
  ...record,
  event: "control.mutation",
  clientId: null,
  requestId: null,
  occurredAt: 1,
}))
function grant(
  permissions: string[],
  resourceType = "relay",
  resourceId = "relay-a",
  relayId = "relay-a"
) {
  return { permissions, resourceType, resourceId, relayId }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.grants.mockResolvedValue([])
  mocks.rpc.mockImplementation(async (_relay, operation) => {
    if (operation === "relay.audit.list") return records
    throw new Error("Snapshot unavailable")
  })
  mocks.query.mockImplementation(async (sql: string, params: string[][]) => [
    sql.includes("FROM user")
      ? params[0]!.map((id) => ({ id, name: id, email: `${id}@example.test` }))
      : ["server-a", "server-b"].map((id) => ({
          relay_id: "relay-a",
          instance_id: id,
          display_name: id,
        })),
  ])
})

describe("Activity permission boundary", () => {
  it.each([
    [
      "Relay audit reader",
      [grant(["relay.audit.read"])],
      ["relay-event", "server-a-event", "server-b-event"],
      ["relay-actor", "actor-a", "actor-b"],
    ],
    [
      "Relay instance reader",
      [grant(["instance.read"])],
      ["server-a-event", "server-b-event"],
      ["actor-a", "actor-b"],
    ],
    [
      "child instance reader",
      [grant(["instance.read"], "instance", "server-a")],
      ["server-a-event"],
      ["actor-a"],
    ],
    [
      "database reader",
      [grant(["database.read"], "database", "database-a")],
      [],
      [],
    ],
    ["ungranted reader", [], [], []],
  ] as const)(
    "limits records and actor lookup for a %s",
    async (_label, grants, ids, actors) => {
      mocks.grants.mockResolvedValue(grants)
      const result = await getActivityForUser(user, {})
      expect(result.entries.map((entry) => entry.id)).toEqual(
        ids.map((id) => `relay-a:${id}`)
      )
      const actorQuery = mocks.query.mock.calls.find(([sql]) =>
        sql.includes("FROM user")
      )
      expect(actorQuery?.[1][0] ?? []).toEqual(actors)
      expect(result.entries.map((entry) => entry.actor.email)).toEqual(
        actors.map((id) => `${id}@example.test`)
      )
      expect(result.relays.map((relay) => relay.id)).toEqual(
        ids.length ? ["relay-a"] : []
      )
    }
  )

  it("filters child records even when the Relay returns other events", async () => {
    mocks.grants.mockResolvedValue([
      grant(["instance.read"], "instance", "server-a"),
    ])
    const result = await getActivityForUser(user, {})
    expect(mocks.rpc).toHaveBeenCalledWith(
      expect.anything(),
      "relay.audit.list",
      { limit: 2000, instanceIds: ["server-a"] },
      10000
    )
    expect(result.servers.map((server) => server.id)).toEqual(["server-a"])
    expect(result.entries).toHaveLength(1)
  })

  it("does not carry Relay audit authority into another Relay with a child grant", async () => {
    mocks.grants.mockResolvedValue([
      grant(["relay.audit.read"]),
      grant(["instance.read"], "instance", "server-a", "relay-b"),
    ])
    const result = await getActivityForUser(user, {})
    expect(result.entries.map((entry) => entry.id)).toEqual([
      "relay-a:relay-event",
      "relay-a:server-a-event",
      "relay-a:server-b-event",
      "relay-b:server-a-event",
    ])
  })

  it("allows platform admins to read every Relay's activity without grants", async () => {
    const result = await getActivityForUser({ ...user, role: "admin" }, {})
    expect(result.entries).toHaveLength(6)
    expect(mocks.grants).not.toHaveBeenCalled()
  })
})
