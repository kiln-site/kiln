import {
  instanceIdSchema,
  relayIdSchema,
  relayVolumeIdSchema,
  resourceLimitsSchema,
} from "@workspace/contracts"
import { z } from "zod"

import { deleteConfirmationSchema } from "@/lib/delete-confirmation"

/**
 * The kinds of resource that can be moved or duplicated, by the name lanes,
 * deletions and permissions give each: a game server is an `instance`.
 */
export const migratedKindSchema = z.enum([
  "instance",
  "database",
  "app",
  "volume",
])
export type MigratedKindName = z.infer<typeof migratedKindSchema>

/** What someone chose to carry over when copying a resource. */
export const resourceMigrationOptionsSchema = z.object({
  /**
   * A full backup of the old one first: to an S3 destination, or the Relay
   * itself (null).
   */
  backup: z.object({ storageId: instanceIdSchema.nullable() }).nullable(),
  /** The old one's people get the same access to the copy. */
  copyAccess: z.boolean(),
  /** The copy's activity includes the old one's history. */
  keepActivity: z.boolean(),
  /** The old one's full backups restore to the copy too. */
  linkBackups: z.boolean().default(false),
  /** A move hands the old one's managed domains to the copy. */
  moveDomain: z.boolean(),
  /** A move gives the copy the old one's web routes. */
  moveWebRoutes: z.boolean(),
  /** The old one stops while it is copied, then starts again. */
  stopSource: z.boolean(),
  /**
   * A finished move deletes the old one once a final full backup of it has
   * finished: to an S3 destination, or the Relay itself (null).
   */
  deleteSource: z
    .object({ storageId: instanceIdSchema.nullable() })
    .nullable()
    .default(null),
  /** The copy's limits, when they differ from the old one's. */
  limits: resourceLimitsSchema.nullable().default(null),
})
export type ResourceMigrationOptions = z.infer<
  typeof resourceMigrationOptionsSchema
>

/** One resource: an instance by its 12-character ID, a volume by its own. */
export const resourceReferenceSchema = z.object({
  id: z.union([instanceIdSchema, relayVolumeIdSchema]),
  kind: migratedKindSchema,
  relayId: relayIdSchema,
})
export type ResourceReference = z.infer<typeof resourceReferenceSchema>

export const startResourceMigrationInputSchema = resourceReferenceSchema.extend(
  {
    /**
     * A move that deletes the old one asks what deleting it does: its name
     * and the account password. Kept apart from `options`, which the
     * migration stores.
     */
    confirmation: deleteConfirmationSchema.optional(),
    destinationRelayId: relayIdSchema,
    mode: z.enum(["duplicate", "migrate"]),
    /** The copy's name, which its kind checks as it makes it. */
    name: z.string().trim().min(1).max(120),
    options: resourceMigrationOptionsSchema,
  }
)
