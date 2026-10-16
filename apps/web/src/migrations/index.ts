import type { Migration } from "@/effect/migrations"

import { baseline } from "./0001_baseline"
import { utcInstants } from "./0002_utc_instants"
import { revokeTrustedDevices } from "./0003_revoke_trusted_devices"
import { instanceFavorites } from "./0004_instance_favorites"
import { notifications } from "./0005_notifications"
import { systemUpdateOperations } from "./0006_system_update_operations"
import { systemReleases } from "./0007_system_releases"
import { apps } from "./0008_apps"
import { fileActivityRoots } from "./0009_file_activity_roots"
import { dropSystemUpdateOperations } from "./0010_drop_system_update_operations"

// Append new migrations with the next id. Never edit or reorder applied ones.
export const migrations: ReadonlyArray<Migration> = [
  baseline,
  utcInstants,
  revokeTrustedDevices,
  instanceFavorites,
  notifications,
  systemUpdateOperations,
  systemReleases,
  apps,
  fileActivityRoots,
  dropSystemUpdateOperations,
]
