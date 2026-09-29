import { z } from "zod"

// Engine-agnostic protocol for browsing and editing databases. File-backed
// SQLite is the first engine; managed MySQL/MariaDB/Postgres and H2 files can
// implement the same actions later without changing the viewer.

export const databaseBrowserEngineSchema = z.enum(["sqlite"])

export const DATABASE_BROWSER_MAX_PAGE_ROWS = 500
export const DATABASE_BROWSER_MAX_QUERY_ROWS = 1_000
export const DATABASE_BROWSER_MAX_CHANGES = 500

const identifierSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"), "Invalid identifier")

// JSON cannot carry 64-bit integers or bytes, so those are tagged.
export const databaseBigIntValueSchema = z
  .object({ $bigint: z.string().regex(/^-?\d{1,40}$/u) })
  .strict()

export const databaseBlobValueSchema = z
  .object({
    $blob: z.string().max(4 * 1024 * 1024),
    size: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict()

export const databaseValueSchema = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string().max(16 * 1024 * 1024),
  databaseBigIntValueSchema,
  databaseBlobValueSchema,
])

export const databaseRowKeySchema = z
  .record(identifierSchema, databaseValueSchema)
  .refine((key) => Object.keys(key).length > 0, "Row key is required")

export const databaseColumnSchema = z
  .object({
    defaultValue: z.string().nullable(),
    name: z.string(),
    nullable: z.boolean(),
    // 1-based position inside the primary key, 0 when not part of it.
    primaryKey: z.number().int().nonnegative(),
    type: z.string(),
    generated: z.boolean(),
  })
  .strict()

export const databaseTableSchema = z
  .object({
    columns: z.array(databaseColumnSchema),
    kind: z.enum(["table", "view"]),
    name: z.string(),
    // How rows are addressed for edits. Views and keyless tables are read-only.
    rowIdentity: z.enum(["primary-key", "rowid"]).nullable(),
    sql: z.string().nullable(),
  })
  .strict()

export const databaseOverviewSchema = z
  .object({
    engine: databaseBrowserEngineSchema,
    engineVersion: z.string(),
    modifiedAt: z.string().datetime(),
    readOnly: z.boolean(),
    sizeBytes: z.number().int().nonnegative(),
    tables: z.array(databaseTableSchema),
  })
  .strict()

export const databaseSortSchema = z
  .object({
    column: identifierSchema,
    direction: z.enum(["asc", "desc"]),
  })
  .strict()

export const databaseRowsInputSchema = z
  .object({
    action: z.literal("rows"),
    limit: z.number().int().min(1).max(DATABASE_BROWSER_MAX_PAGE_ROWS),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    search: z.string().max(512).optional(),
    sort: databaseSortSchema.optional(),
    table: identifierSchema,
  })
  .strict()

export const databaseResultColumnSchema = z
  .object({
    name: z.string(),
    type: z.string().nullable(),
  })
  .strict()

export const databaseRowsSchema = z
  .object({
    columns: z.array(databaseResultColumnSchema),
    keys: z.array(databaseRowKeySchema).nullable(),
    offset: z.number().int().nonnegative(),
    rows: z.array(z.array(databaseValueSchema)),
    total: z.number().int().nonnegative(),
    totalCapped: z.boolean(),
  })
  .strict()

export const databaseQueryInputSchema = z
  .object({
    action: z.literal("query"),
    maxRows: z.number().int().min(1).max(DATABASE_BROWSER_MAX_QUERY_ROWS),
    sql: z.string().trim().min(1).max(100_000),
  })
  .strict()

export const databaseQueryResultSchema = z
  .object({
    changes: z.number().int().nonnegative().nullable(),
    columns: z.array(databaseResultColumnSchema),
    durationMs: z.number().nonnegative(),
    rows: z.array(z.array(databaseValueSchema)),
    truncated: z.boolean(),
  })
  .strict()

export const databaseChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("update"),
      key: databaseRowKeySchema,
      // The row as the client loaded it; the Relay only changes a row that
      // still matches (see the Relay's change guards).
      original: z.record(identifierSchema, databaseValueSchema),
      values: z.record(identifierSchema, databaseValueSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("insert"),
      values: z.record(identifierSchema, databaseValueSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("delete"),
      key: databaseRowKeySchema,
      original: z.record(identifierSchema, databaseValueSchema),
    })
    .strict(),
])

export const databaseMutateInputSchema = z
  .object({
    action: z.literal("mutate"),
    changes: z
      .array(databaseChangeSchema)
      .min(1)
      .max(DATABASE_BROWSER_MAX_CHANGES),
    table: identifierSchema,
  })
  .strict()

export const databaseMutateResultSchema = z
  .object({
    applied: z.number().int().nonnegative(),
  })
  .strict()

export const databaseOverviewInputSchema = z
  .object({ action: z.literal("overview") })
  .strict()

export const databaseReadRequestSchema = z.discriminatedUnion("action", [
  databaseOverviewInputSchema,
  databaseRowsInputSchema,
  databaseQueryInputSchema,
])

export const databaseWriteRequestSchema = z.discriminatedUnion("action", [
  databaseMutateInputSchema,
  databaseQueryInputSchema,
])

export const relayFileDatabaseInputSchema = z
  .object({
    instanceId: z.string().regex(/^[a-f0-9]{40}$/u),
    path: z.string().min(1).max(8_192),
  })
  .strict()

export const relayFileDatabaseReadInputSchema =
  relayFileDatabaseInputSchema.extend({ request: databaseReadRequestSchema })

export const relayFileDatabaseWriteInputSchema =
  relayFileDatabaseInputSchema.extend({ request: databaseWriteRequestSchema })

export type DatabaseBrowserEngine = z.infer<typeof databaseBrowserEngineSchema>
export type DatabaseValue = z.infer<typeof databaseValueSchema>
export type DatabaseBlobValue = z.infer<typeof databaseBlobValueSchema>
export type DatabaseRowKey = z.infer<typeof databaseRowKeySchema>
export type DatabaseColumn = z.infer<typeof databaseColumnSchema>
export type DatabaseTable = z.infer<typeof databaseTableSchema>
export type DatabaseOverview = z.infer<typeof databaseOverviewSchema>
export type DatabaseSort = z.infer<typeof databaseSortSchema>
export type DatabaseRowsInput = z.infer<typeof databaseRowsInputSchema>
export type DatabaseRows = z.infer<typeof databaseRowsSchema>
export type DatabaseResultColumn = z.infer<typeof databaseResultColumnSchema>
export type DatabaseQueryInput = z.infer<typeof databaseQueryInputSchema>
export type DatabaseQueryResult = z.infer<typeof databaseQueryResultSchema>
export type DatabaseChange = z.infer<typeof databaseChangeSchema>
export type DatabaseMutateInput = z.infer<typeof databaseMutateInputSchema>
export type DatabaseMutateResult = z.infer<typeof databaseMutateResultSchema>
export type DatabaseReadRequest = z.infer<typeof databaseReadRequestSchema>
export type DatabaseWriteRequest = z.infer<typeof databaseWriteRequestSchema>
export type RelayFileDatabaseReadInput = z.infer<
  typeof relayFileDatabaseReadInputSchema
>
export type RelayFileDatabaseWriteInput = z.infer<
  typeof relayFileDatabaseWriteInputSchema
>
