import { describe, expect, it } from "vite-plus/test"
import { Effect } from "effect"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"

import type { DatabaseTransaction } from "@/effect/database"
import { advanceAuthorizationRevisionEffect } from "./authorization-revision"

const successfulWrite = {
  affectedRows: 1,
  changedRows: 0,
  fieldCount: 0,
  info: "",
  insertId: 0,
  serverStatus: 0,
  warningStatus: 0,
} as ResultSetHeader

describe("authorization revisions", () => {
  it("locks and advances the subject before coalescing delivery intent", async () => {
    const statements: Array<{ sql: string; values: ReadonlyArray<unknown> }> =
      []
    const transaction: DatabaseTransaction = {
      execute: (sql, values) =>
        Effect.sync(() => {
          statements.push({ sql, values: values ?? [] })
          return successfulWrite
        }),
      queryRows: <TRow extends RowDataPacket>(
        sql: string,
        values?: Array<boolean | Buffer | Date | null | number | string>
      ) =>
        Effect.sync(() => {
          statements.push({ sql, values: values ?? [] })
          return [{ revision: "8" }] as unknown as ReadonlyArray<TRow>
        }),
    }

    const change = await Effect.runPromise(
      advanceAuthorizationRevisionEffect(transaction, {
        targets: [
          {
            relayId: "relay-one",
            scope: { instanceId: "instance-one", kind: "instance" },
          },
          {
            relayId: "relay-one",
            scope: { instanceId: "instance-one", kind: "instance" },
          },
        ],
        userId: "user-one",
      })
    )

    expect(change).toEqual({ relayIds: ["relay-one"], revision: 9 })
    expect(statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("authorization_subject"),
      expect.stringContaining("FOR UPDATE"),
      expect.stringContaining("SET revision = ?"),
      expect.stringContaining("GREATEST(desired_revision"),
    ])
    expect(statements[3]!.values).toEqual([
      "relay-one",
      "user-one",
      "instance",
      "instance-one",
      9,
    ])
  })
})
