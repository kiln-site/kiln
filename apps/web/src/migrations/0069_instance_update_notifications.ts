import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// The notification that an image has a newer release was an App's by name
// (`app.image-update`) while only Apps updated. It is every instance's
// now, so the ones already stored take its new name, in their kind, the
// key that tells one update's notification from another's, and what they
// say. What people chose about them carries over where settings are read
// (`formerNotificationKinds`).
export const instanceUpdateNotifications: Migration = {
  id: 69,
  name: "instance_update_notifications",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = databaseTableName("notification")
    yield* sql.unsafe(`UPDATE \`${table}\`
   SET kind = 'instance.image-update',
       source_key = CONCAT('instance.image-update:', SUBSTRING(source_key, 18)),
       data = JSON_SET(data, '$.kind', 'instance.image-update')
 WHERE kind = 'app.image-update'`)
  }),
}
