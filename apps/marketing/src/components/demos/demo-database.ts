import type {
  DatabaseChange,
  DatabaseColumn,
  DatabaseMutateResult,
  DatabaseOverview,
  DatabaseQueryResult,
  DatabaseRows,
  DatabaseTable,
  DatabaseValue,
} from "@workspace/contracts"

import type { DatabaseSource } from "@/components/database-viewer/database-source"

type Row = Record<string, DatabaseValue>

interface DemoTable {
  columns: Array<DatabaseColumn>
  name: string
  rows: Array<Row>
}

function column(
  name: string,
  type: string,
  options: { key?: number; nullable?: boolean; value?: string } = {}
): DatabaseColumn {
  return {
    defaultValue: options.value ?? null,
    generated: false,
    name,
    nullable: options.nullable ?? false,
    primaryKey: options.key ?? 0,
    type,
  }
}

const players = [
  ["5d1f9a3c-8b2e-4c71-a0f4-2e9b7c6d1a08", "mossy_mae", "admin"],
  ["0b7e4f21-93ac-4d5e-8f16-7a2c9e0d3b54", "redstone_ryan", "builder"],
  ["c4a8e2d0-5f19-4b73-9e6a-1d3f7b2c8a95", "nether_nik", "default"],
  ["4bc3ca20-bf26-410d-a0b4-06ecfb1decd7", "cobblequeen", "moderator"],
  ["e91f0c6b-2d48-4a37-b5e8-3c7a1f9d0e62", "oak_and_ash", "builder"],
  ["7a2d5e9c-1b3f-4c80-96d4-8e0f2a7b5c13", "tnt_tom", "default"],
  ["f3b6a8d1-7c2e-49f5-a0b3-5d9e1c4f7a28", "creeperkeeper", "default"],
] as const

const permissionColumns = (owner: DatabaseColumn) => [
  column("id", "INTEGER", { key: 1 }),
  owner,
  column("permission", "VARCHAR(200)"),
  column("value", "BOOLEAN"),
  column("server", "VARCHAR(36)"),
  column("world", "VARCHAR(64)"),
  column("expiry", "BIGINT"),
  column("contexts", "VARCHAR(200)"),
]

const permission = (
  id: number,
  owner: [string, string],
  node: string,
  value = true,
  expiry = 0
): Row => ({
  id,
  [owner[0]]: owner[1],
  permission: node,
  value,
  server: "global",
  world: "global",
  expiry,
  contexts: "{}",
})

// LuckPerms' SQLite schema, for the players in the console demo.
function demoTables(): Array<DemoTable> {
  const groups = ["default", "builder", "moderator", "admin"]
  return [
    {
      name: "luckperms_players",
      columns: [
        column("uuid", "VARCHAR(36)", { key: 1 }),
        column("username", "VARCHAR(16)"),
        column("primary_group", "VARCHAR(36)"),
      ],
      rows: players.map(([uuid, username, group]) => ({
        uuid,
        username,
        primary_group: group,
      })),
    },
    {
      name: "luckperms_user_permissions",
      columns: permissionColumns(column("uuid", "VARCHAR(36)")),
      rows: players.flatMap(([uuid, , group], index) => [
        permission(index * 2 + 1, ["uuid", uuid], `group.${group}`),
        ...(group === "default"
          ? []
          : [
              permission(
                index * 2 + 2,
                ["uuid", uuid],
                "essentials.fly",
                true,
                group === "builder" ? 1_793_836_800 : 0
              ),
            ]),
      ]),
    },
    {
      name: "luckperms_groups",
      columns: [column("name", "VARCHAR(36)", { key: 1 })],
      rows: groups.map((name) => ({ name })),
    },
    {
      name: "luckperms_group_permissions",
      columns: permissionColumns(column("name", "VARCHAR(36)")),
      rows: [
        ["default", "essentials.home"],
        ["default", "essentials.sethome"],
        ["default", "essentials.spawn"],
        ["builder", "group.default"],
        ["builder", "worldedit.selection.*"],
        ["builder", "worldedit.region.*"],
        ["moderator", "group.builder"],
        ["moderator", "essentials.kick"],
        ["moderator", "essentials.mute"],
        ["admin", "group.moderator"],
        ["admin", "*"],
      ].map(([group, node], index) =>
        permission(index + 1, ["name", group!], node!)
      ),
    },
    {
      name: "luckperms_tracks",
      columns: [
        column("name", "VARCHAR(36)", { key: 1 }),
        column("groups", "TEXT"),
      ],
      rows: [{ name: "staff", groups: '["builder","moderator","admin"]' }],
    },
  ]
}

const delay = () => new Promise((resolve) => window.setTimeout(resolve, 90))

// A database source for Hearth's viewer, kept in this tab: browse, sort,
// search, edit, and run simple SELECTs against the tables above.
export function createDemoDatabaseSource(path: string): DatabaseSource {
  const tables = demoTables()
  const find = (name: string) => {
    const table = tables.find((candidate) => candidate.name === name)
    if (!table) throw new Error(`No such table: ${name}`)
    return table
  }
  const keyOf = (table: DemoTable, row: Row) =>
    Object.fromEntries(
      table.columns
        .filter((column) => column.primaryKey > 0)
        .map((column) => [column.name, row[column.name] ?? null])
    )
  const matches = (row: Row, key: Row) =>
    Object.entries(key).every(([name, value]) => row[name] === value)

  return {
    canQuery: true,
    canWrite: true,
    queryKey: ["demo-database", path],
    async overview(): Promise<DatabaseOverview> {
      await delay()
      return {
        engine: "sqlite",
        engineVersion: "3.46.1",
        modifiedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
        readOnly: false,
        sizeBytes: 98_304,
        tables: tables.map((table): DatabaseTable => ({
          columns: table.columns,
          kind: "table",
          name: table.name,
          rowIdentity: "primary-key",
          sql: null,
        })),
      }
    },
    async rows({ limit, offset, search, sort, table: name }) {
      await delay()
      const table = find(name)
      const query = search?.trim().toLowerCase()
      let rows = query
        ? table.rows.filter((row) =>
            Object.values(row).some((value) =>
              String(value).toLowerCase().includes(query)
            )
          )
        : [...table.rows]
      if (sort) {
        const direction = sort.direction === "asc" ? 1 : -1
        rows = rows.sort(
          (left, right) =>
            String(left[sort.column]).localeCompare(
              String(right[sort.column]),
              undefined,
              { numeric: true }
            ) * direction
        )
      }
      const page = rows.slice(offset, offset + limit)
      return {
        columns: table.columns.map(({ name, type }) => ({ name, type })),
        keys: page.map((row) => keyOf(table, row)),
        offset,
        rows: page.map((row) =>
          table.columns.map((column) => row[column.name] ?? null)
        ),
        total: rows.length,
        totalCapped: false,
      } satisfies DatabaseRows
    },
    async query(sql): Promise<DatabaseQueryResult> {
      const startedAt = performance.now()
      await delay()
      const select =
        /^\s*select\s+(.+?)\s+from\s+(\w+)(?:\s+limit\s+(\d+))?\s*;?\s*$/iu.exec(
          sql
        )
      if (!select) {
        throw new Error(
          "This demo runs SELECT … FROM a table. Hearth runs any SQL."
        )
      }
      const [, list, name, limit] = select
      const table = find(name!)
      const names =
        list!.trim() === "*"
          ? table.columns.map((column) => column.name)
          : list!.split(",").map((part) => part.trim())
      for (const columnName of names) {
        if (!table.columns.some((column) => column.name === columnName))
          throw new Error(`No such column: ${columnName}`)
      }
      const rows = table.rows.slice(0, limit ? Number(limit) : undefined)
      return {
        changes: null,
        columns: names.map((columnName) => ({
          name: columnName,
          type:
            table.columns.find((column) => column.name === columnName)?.type ??
            null,
        })),
        durationMs: performance.now() - startedAt,
        rows: rows.map((row) =>
          names.map((columnName) => row[columnName] ?? null)
        ),
        truncated: false,
      }
    },
    async mutate(name, changes: Array<DatabaseChange>) {
      await delay()
      const table = find(name)
      for (const change of changes) {
        if (change.kind === "insert") {
          table.rows.push({ ...change.values })
          continue
        }
        const index = table.rows.findIndex((row) => matches(row, change.key))
        if (index === -1) continue
        if (change.kind === "delete") table.rows.splice(index, 1)
        else table.rows[index] = { ...table.rows[index], ...change.values }
      }
      return {
        applied: changes.length,
        conflicts: [],
      } satisfies DatabaseMutateResult
    },
  }
}
