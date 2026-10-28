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
import { pushSubscriptions } from "./0021_push_subscriptions"
import { resourceOwners } from "./0022_resource_owners"
import { notificationDelivery } from "./0023_notification_delivery"
import { defaultKilnBackups } from "./0024_default_kiln_backups"
import { backupRetentionDays } from "./0025_backup_retention_days"
import { relayJoins } from "./0026_relay_joins"
import { security } from "./0027_security"
import { kilnFavorite } from "./0028_kiln_favorite"
import { serverMigrations } from "./0029_server_migrations"
import { linkedBackups } from "./0030_linked_backups"
import { securityReports } from "./0031_security_reports"
import { icons } from "./0032_icons"
import { relayControlDial } from "./0033_relay_control_dial"
import { relayJoinPairing } from "./0034_relay_join_pairing"
import { cloudflareConnections } from "./0035_cloudflare_connections"
import { operations } from "./0036_operations"
import { operationProgress } from "./0037_operation_progress"
import { relayDatabaseConnectionImport } from "./0038_relay_database_connection_import"
import { tailscaleMemberIds } from "./0039_tailscale_member_ids"
import { backupResourceTargets } from "./0042_backup_resource_targets"
import { scheduleProjectionGenerations } from "./0043_schedule_projection_generations"
import { resourceDeletions } from "./0044_resource_deletions"
import { backupBatches } from "./0045_backup_batches"
import { scheduleAppTargets } from "./0046_schedule_app_targets"

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
  pushSubscriptions,
  resourceOwners,
  notificationDelivery,
  defaultKilnBackups,
  backupRetentionDays,
  relayJoins,
  security,
  kilnFavorite,
  serverMigrations,
  linkedBackups,
  securityReports,
  icons,
  relayControlDial,
  relayJoinPairing,
  cloudflareConnections,
  operations,
  operationProgress,
  relayDatabaseConnectionImport,
  tailscaleMemberIds,
  backupResourceTargets,
  scheduleProjectionGenerations,
  resourceDeletions,
  backupBatches,
  scheduleAppTargets,
]
