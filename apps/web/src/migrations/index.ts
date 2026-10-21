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
import { scheduleContinueOnFailure } from "./0011_schedule_continue_on_failure"
import { instanceDirectory } from "./0012_instance_directory"
import { incrementalBackupArtifacts } from "./0013_incremental_backup_artifacts"
import { instanceDomainOptOut } from "./0014_instance_domain_opt_out"
import { domainZones } from "./0015_domain_zones"
import { githubSync } from "./0016_github_sync"
import { auditEvents } from "./0017_audit_events"
import { appDeployments } from "./0018_app_deployments"
import { backupErrorCodes } from "./0019_backup_error_codes"
import { appImageUpdates } from "./0020_app_image_updates"

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
  scheduleContinueOnFailure,
  instanceDirectory,
  incrementalBackupArtifacts,
  instanceDomainOptOut,
  domainZones,
  githubSync,
  auditEvents,
  appDeployments,
  backupErrorCodes,
  appImageUpdates,
]
