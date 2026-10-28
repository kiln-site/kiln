import { backupTargetSchema } from "@workspace/contracts"
import { z } from "zod"

// What Hearth catalogs, authorizes, and asks Relays to back up: game
// servers, databases, and Kiln. Relays also back up Apps' folders and
// volumes; Hearth takes them once it can authorize them.
export const hearthBackupTargetSchema = backupTargetSchema.extend({
  kind: z.enum(["instance", "database", "platform"]),
})

export type HearthBackupTarget = z.infer<typeof hearthBackupTargetSchema>
