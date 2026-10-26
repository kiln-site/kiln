import {
  relayInstanceNameSchema,
  resourceLimitsSchema,
} from "@workspace/contracts"
import { z } from "zod"

/** What someone chose to carry over when copying a game server. */
export const serverMigrationOptionsSchema = z.object({
  /**
   * A full backup of the old server first: to an S3 destination, the Relay
   * itself (null), or wherever its backups go by default (left out).
   */
  backup: z.object({ storageId: z.uuid().nullable().optional() }).nullable(),
  /** The old server's people get the same access to the copy. */
  copyAccess: z.boolean(),
  /** The copy's activity includes the old server's history. */
  keepActivity: z.boolean(),
  /** The old server's full backups restore to the copy too. */
  linkBackups: z.boolean().default(false),
  /** A move hands the old server's managed domains to the copy. */
  moveDomain: z.boolean(),
  /** A move gives the copy the old server's web routes. */
  moveWebRoutes: z.boolean(),
  /** The old server stops while its files are copied, then starts again. */
  stopSource: z.boolean(),
  /**
   * A finished move deletes the old server once a final full backup of it
   * has finished: to an S3 destination, the Relay itself (null), or
   * wherever its backups go by default (left out).
   */
  deleteSource: z
    .object({ storageId: z.uuid().nullable().optional() })
    .nullable()
    .default(null),
  /** The copy's limits, when they differ from the old server's. */
  limits: resourceLimitsSchema.nullable().default(null),
})
export type ServerMigrationOptions = z.infer<
  typeof serverMigrationOptionsSchema
>

export const serverReferenceSchema = z.object({
  instanceId: z.string().regex(/^[a-f0-9]{40}$/u),
  relayId: z.string().min(1).max(64),
})

export const startServerMigrationInputSchema = serverReferenceSchema.extend({
  destinationRelayId: z.string().min(1).max(64),
  mode: z.enum(["duplicate", "migrate"]),
  name: relayInstanceNameSchema,
  options: serverMigrationOptionsSchema,
})
