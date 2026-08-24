CREATE TABLE IF NOT EXISTS kiln_relay (
  id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  hostname VARCHAR(253) NOT NULL,
  port SMALLINT UNSIGNED NOT NULL DEFAULT 4100,
  use_tls BOOLEAN NOT NULL DEFAULT TRUE,
  browser_origin VARCHAR(512) NOT NULL,
  relay_public_key TEXT NOT NULL,
  relay_ca_certificate TEXT NULL,
  client_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  client_public_key TEXT NOT NULL,
  client_private_key_ciphertext TEXT NOT NULL,
  client_role ENUM('full_access', 'read_only', 'custom') NOT NULL,
  client_actions JSON NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_connected_at TIMESTAMP(3) NULL,
  last_error VARCHAR(512) NULL,
  managed_ember_count INT UNSIGNED NULL,
  node_arch VARCHAR(32) NULL,
  node_platform VARCHAR(32) NULL,
  node_version VARCHAR(120) NULL,
  created_by VARCHAR(36) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY kiln_relay_endpoint_unique (hostname, port)
);

CREATE TABLE IF NOT EXISTS kiln_setting (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id VARCHAR(36) NULL,
  setting_key VARCHAR(191) NOT NULL,
  setting_value JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY kiln_setting_scope_unique (user_id, setting_key)
);

CREATE TABLE IF NOT EXISTS kiln_custom_brick (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  owner_user_id VARCHAR(36) NOT NULL,
  source_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source VARCHAR(2048) NOT NULL,
  recipe JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY kiln_custom_brick_owner_source_unique (owner_user_id, source_hash),
  KEY kiln_custom_brick_owner_updated_idx (owner_user_id, updated_at)
);

CREATE TABLE IF NOT EXISTS kiln_brick_catalog (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  owner_user_id VARCHAR(36) NOT NULL,
  source_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source VARCHAR(2048) NOT NULL,
  snapshot JSON NOT NULL,
  snapshot_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision_sha VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  revision_url VARCHAR(2048) NULL,
  visibility ENUM('personal', 'community') NOT NULL DEFAULT 'personal',
  published_by VARCHAR(36) NULL,
  published_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY kiln_brick_catalog_owner_source_unique (owner_user_id, source_hash),
  KEY kiln_brick_catalog_visibility_updated_idx (visibility, updated_at),
  KEY kiln_brick_catalog_owner_updated_idx (owner_user_id, updated_at)
);

CREATE TABLE IF NOT EXISTS kiln_instance (
  relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  instance_id CHAR(40) NOT NULL,
  display_name VARCHAR(120) NULL,
  owner_id VARCHAR(36) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (relay_id, instance_id),
  UNIQUE KEY kiln_instance_relay_name_unique (relay_id, display_name),
  CONSTRAINT kiln_instance_relay_fk
    FOREIGN KEY (relay_id) REFERENCES kiln_relay (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kiln_instance_post_provision (
  relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  instance_id CHAR(40) NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_error VARCHAR(512) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (relay_id, instance_id),
  KEY kiln_instance_post_provision_due_idx (next_attempt_at, updated_at),
  CONSTRAINT kiln_instance_post_provision_instance_fk
    FOREIGN KEY (relay_id, instance_id)
    REFERENCES kiln_instance (relay_id, instance_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kiln_database (
  database_id CHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  engine ENUM('mysql', 'mariadb', 'postgres', 'redis', 'valkey') NOT NULL,
  database_name VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  password_ciphertext TEXT NOT NULL,
  created_by VARCHAR(36) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY kiln_database_relay_name_unique (relay_id, name),
  KEY kiln_database_relay_idx (relay_id, created_at),
  CONSTRAINT kiln_database_relay_fk
    FOREIGN KEY (relay_id) REFERENCES kiln_relay (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kiln_tailscale_network (
  id CHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  domain VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  oauth_client_id VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NULL,
  oauth_client_secret_ciphertext TEXT NULL,
  oauth_scopes JSON NULL,
  oauth_tags JSON NULL,
  oauth_last_synced_at TIMESTAMP(3) NULL,
  oauth_last_error VARCHAR(512) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY kiln_tailscale_network_domain_unique (domain)
);

CREATE TABLE IF NOT EXISTS kiln_domain_integration (
  id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  provider ENUM('cloudflare') NOT NULL,
  domain VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  zone_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  zone_name VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  api_token_ciphertext TEXT NOT NULL,
  blacklist_patterns JSON NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_verified_at TIMESTAMP(3) NULL,
  last_error VARCHAR(512) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS kiln_instance_domain (
  relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  instance_id CHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  integration_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  vanity_label VARCHAR(63) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  domain VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  public_host VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  public_port SMALLINT UNSIGNED NOT NULL,
  supports_srv BOOLEAN NOT NULL DEFAULT FALSE,
  srv_service VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  srv_protocol ENUM('tcp', 'udp') NULL,
  address_record_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  address_record_type ENUM('A', 'AAAA', 'CNAME') NULL,
  srv_record_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status ENUM('pending', 'active', 'error') NOT NULL DEFAULT 'pending',
  last_error VARCHAR(512) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (relay_id, instance_id),
  UNIQUE KEY kiln_instance_domain_vanity_unique (domain, vanity_label),
  KEY kiln_instance_domain_status_idx (status, updated_at)
);

CREATE TABLE IF NOT EXISTS kiln_file_activity (
  relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  instance_id CHAR(40) NOT NULL,
  path_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  path VARCHAR(2048) NOT NULL,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  last_viewed_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_edited_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (relay_id, instance_id, path_hash),
  KEY kiln_file_activity_recent_idx (relay_id, instance_id, pinned, last_viewed_at),
  CONSTRAINT kiln_file_activity_instance_fk
    FOREIGN KEY (relay_id, instance_id)
    REFERENCES kiln_instance (relay_id, instance_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kiln_auth_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(36) NULL,
  event VARCHAR(120) NOT NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  metadata JSON NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY kiln_auth_audit_user_created_idx (user_id, created_at)
);

CREATE TABLE IF NOT EXISTS kiln_cli_credential (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  name VARCHAR(120) NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  access_mode ENUM('full_access', 'read_only') NOT NULL,
  expires_at TIMESTAMP(3) NULL,
  last_used_at TIMESTAMP(3) NULL,
  revoked_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY kiln_cli_credential_token_unique (token_hash),
  KEY kiln_cli_credential_user_created_idx (user_id, created_at),
  KEY kiln_cli_credential_expiry_idx (expires_at, revoked_at)
);

CREATE TABLE IF NOT EXISTS kiln_cli_device (
  id CHAR(36) NOT NULL PRIMARY KEY,
  device_code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  client_name VARCHAR(120) NOT NULL,
  status ENUM('pending', 'approved', 'denied') NOT NULL DEFAULT 'pending',
  user_id VARCHAR(36) NULL,
  credential_id CHAR(36) NULL,
  token_ciphertext TEXT NULL,
  access_mode ENUM('full_access', 'read_only') NULL,
  credential_expires_at TIMESTAMP(3) NULL,
  last_polled_at TIMESTAMP(3) NULL,
  authorized_at TIMESTAMP(3) NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY kiln_cli_device_code_unique (device_code_hash),
  UNIQUE KEY kiln_cli_user_code_unique (user_code_hash),
  KEY kiln_cli_device_expiry_idx (expires_at, status),
  CONSTRAINT kiln_cli_device_credential_fk
    FOREIGN KEY (credential_id) REFERENCES kiln_cli_credential (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS kiln_access_grant (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resource_type ENUM('relay', 'instance', 'database') NOT NULL,
  resource_id VARCHAR(64) NOT NULL,
  role ENUM('owner', 'admin', 'operator', 'viewer') NOT NULL,
  granted_by VARCHAR(36) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY kiln_access_grant_scope_unique (user_id, relay_id, resource_type, resource_id),
  KEY kiln_access_grant_relay_resource_idx (relay_id, resource_type, resource_id),
  KEY kiln_access_grant_user_idx (user_id)
);

CREATE TABLE IF NOT EXISTS kiln_invitation (
  id CHAR(36) NOT NULL PRIMARY KEY,
  token_hash CHAR(64) NOT NULL,
  email VARCHAR(320) NOT NULL,
  access_type ENUM('scoped', 'platform_admin', 'relay_creator') NOT NULL DEFAULT 'scoped',
  relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NULL,
  instance_id VARCHAR(64) NULL,
  database_id CHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL,
  role ENUM('owner', 'admin', 'operator', 'viewer') NULL,
  invited_by VARCHAR(36) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  accepted_at TIMESTAMP(3) NULL,
  revoked_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY kiln_invitation_token_unique (token_hash),
  KEY kiln_invitation_email_pending_idx (email, expires_at),
  KEY kiln_invitation_relay_idx (relay_id, created_at)
);

CREATE TABLE IF NOT EXISTS kiln_backup_storage (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  owner_user_id VARCHAR(36) NULL,
  name VARCHAR(120) NOT NULL,
  endpoint VARCHAR(2048) NOT NULL,
  region VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bucket VARCHAR(255) NOT NULL,
  object_prefix VARCHAR(512) NOT NULL DEFAULT '',
  force_path_style BOOLEAN NOT NULL DEFAULT FALSE,
  allow_private_network BOOLEAN NOT NULL DEFAULT FALSE,
  access_key_id_ciphertext TEXT NOT NULL,
  secret_access_key_ciphertext TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  deleting BOOLEAN NOT NULL DEFAULT FALSE,
  last_verified_at TIMESTAMP(3) NULL,
  last_error VARCHAR(512) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY kiln_backup_storage_owner_name_unique (owner_user_id, name),
  KEY kiln_backup_storage_owner_enabled_idx (owner_user_id, enabled, name)
);

CREATE TABLE IF NOT EXISTS kiln_backup_policy (
  relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_kind ENUM('instance', 'database', 'platform') NOT NULL,
  target_id VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  storage_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  exclude_patterns JSON NOT NULL,
  quantity_limit INT UNSIGNED NULL,
  size_limit_bytes BIGINT UNSIGNED NULL,
  admin_quantity_limit INT UNSIGNED NULL,
  admin_size_limit_bytes BIGINT UNSIGNED NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (relay_id, target_kind, target_id),
  KEY kiln_backup_policy_storage_idx (storage_id),
  CONSTRAINT kiln_backup_policy_storage_fk
    FOREIGN KEY (storage_id) REFERENCES kiln_backup_storage (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS kiln_backup_repository (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_kind ENUM('instance', 'database', 'platform') NOT NULL,
  target_id VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  storage_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  storage_key VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'local',
  object_prefix VARCHAR(1024) NULL,
  password_ciphertext TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY kiln_backup_repository_target_storage_unique (relay_id, target_kind, target_id, storage_key),
  KEY kiln_backup_repository_storage_idx (storage_id),
  CONSTRAINT kiln_backup_repository_storage_fk
    FOREIGN KEY (storage_id) REFERENCES kiln_backup_storage (id) ON DELETE RESTRICT,
  CONSTRAINT kiln_backup_repository_storage_key_chk
    CHECK (storage_key = IFNULL(storage_id, 'local'))
);

CREATE TABLE IF NOT EXISTS kiln_backup (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_kind ENUM('instance', 'database', 'platform') NOT NULL,
  target_id VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  storage_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  artifact_kind ENUM('archive', 'database_dump', 'platform_bundle', 'restic_snapshot') NOT NULL,
  backup_mode ENUM('full', 'incremental') NOT NULL DEFAULT 'full',
  reason ENUM('manual', 'pre_restore', 'final_delete', 'scheduled') NOT NULL,
  status ENUM('queued', 'running', 'available', 'failed', 'deleting', 'deleted') NOT NULL,
  name VARCHAR(120) NOT NULL,
  filename VARCHAR(255) NULL,
  object_key VARCHAR(1024) NULL,
  bytes BIGINT UNSIGNED NULL,
  checksum_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  restic_snapshot_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  repository_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  warnings JSON NOT NULL,
  created_by VARCHAR(36) NULL,
  started_at TIMESTAMP(3) NULL,
  completed_at TIMESTAMP(3) NULL,
  deleted_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY kiln_backup_target_created_idx (relay_id, target_kind, target_id, created_at),
  KEY kiln_backup_status_updated_idx (status, updated_at),
  KEY kiln_backup_storage_idx (storage_id),
  KEY kiln_backup_repository_idx (repository_id),
  CONSTRAINT kiln_backup_storage_fk
    FOREIGN KEY (storage_id) REFERENCES kiln_backup_storage (id) ON DELETE RESTRICT,
  CONSTRAINT kiln_backup_repository_fk
    FOREIGN KEY (repository_id) REFERENCES kiln_backup_repository (id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS kiln_backup_artifact (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  backup_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  destination_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  storage_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status ENUM('queued', 'running', 'available', 'failed', 'deleting', 'deleted') NOT NULL,
  filename VARCHAR(255) NULL,
  object_key VARCHAR(1024) NULL,
  bytes BIGINT UNSIGNED NULL,
  checksum_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error TEXT NULL,
  completed_at TIMESTAMP(3) NULL,
  deleted_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY kiln_backup_artifact_destination_unique (backup_id, destination_key),
  KEY kiln_backup_artifact_status_idx (status, updated_at),
  KEY kiln_backup_artifact_storage_idx (storage_id),
  CONSTRAINT kiln_backup_artifact_backup_fk
    FOREIGN KEY (backup_id) REFERENCES kiln_backup (id) ON DELETE CASCADE,
  CONSTRAINT kiln_backup_artifact_storage_fk
    FOREIGN KEY (storage_id) REFERENCES kiln_backup_storage (id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS kiln_backup_copy_task (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  backup_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_artifact_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  destination_artifact_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('queued', 'running', 'succeeded', 'failed') NOT NULL,
  requested_by VARCHAR(36) NOT NULL,
  error TEXT NULL,
  started_at TIMESTAMP(3) NULL,
  finished_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY kiln_backup_copy_task_destination_unique (destination_artifact_id),
  KEY kiln_backup_copy_task_status_updated_idx (status, updated_at),
  CONSTRAINT kiln_backup_copy_task_backup_fk
    FOREIGN KEY (backup_id) REFERENCES kiln_backup (id) ON DELETE CASCADE,
  CONSTRAINT kiln_backup_copy_task_source_artifact_fk
    FOREIGN KEY (source_artifact_id) REFERENCES kiln_backup_artifact (id) ON DELETE CASCADE,
  CONSTRAINT kiln_backup_copy_task_destination_artifact_fk
    FOREIGN KEY (destination_artifact_id) REFERENCES kiln_backup_artifact (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kiln_backup_task (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  backup_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  task_kind ENUM('create', 'restore', 'delete', 'export') NOT NULL,
  status ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled') NOT NULL,
  bytes_completed BIGINT UNSIGNED NOT NULL DEFAULT 0,
  bytes_total BIGINT UNSIGNED NULL,
  phase ENUM('preparing', 'collecting', 'archiving', 'dumping', 'uploading', 'finalizing') NULL,
  current_artifact_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  current_path VARCHAR(2048) NULL,
  reserved_bytes BIGINT UNSIGNED NULL,
  relay_updated_at_ms BIGINT UNSIGNED NULL,
  depends_on_task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error TEXT NULL,
  requested_by VARCHAR(36) NULL,
  started_at TIMESTAMP(3) NULL,
  finished_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY kiln_backup_task_backup_created_idx (backup_id, created_at),
  KEY kiln_backup_task_status_updated_idx (status, updated_at),
  KEY kiln_backup_task_dependency_idx (depends_on_task_id),
  CONSTRAINT kiln_backup_task_backup_fk
    FOREIGN KEY (backup_id) REFERENCES kiln_backup (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kiln_backup_final_delete (
  relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_id VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  backup_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requested_by VARCHAR(36) NOT NULL,
  status ENUM('backing_up', 'deleting', 'failed', 'completed') NOT NULL,
  error TEXT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (relay_id, target_id),
  UNIQUE KEY kiln_backup_final_delete_backup_unique (backup_id),
  KEY kiln_backup_final_delete_status_idx (status, updated_at),
  CONSTRAINT kiln_backup_final_delete_backup_fk
    FOREIGN KEY (backup_id) REFERENCES kiln_backup (id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS kiln_backup_final_database_delete (
  relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_id VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  backup_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requested_by VARCHAR(36) NOT NULL,
  status ENUM('backing_up', 'deleting', 'failed', 'completed') NOT NULL,
  error TEXT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (relay_id, target_id),
  UNIQUE KEY kiln_backup_final_database_delete_backup_unique (backup_id),
  KEY kiln_backup_final_database_delete_status_idx (status, updated_at),
  CONSTRAINT kiln_backup_final_database_delete_backup_fk
    FOREIGN KEY (backup_id) REFERENCES kiln_backup (id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS kiln_backup_download_share (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  download_url_ciphertext TEXT NOT NULL,
  backup_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  backup_name VARCHAR(120) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  bytes BIGINT UNSIGNED NULL,
  checksum_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  artifact_kind ENUM('archive', 'database_dump', 'platform_bundle', 'restic_snapshot') NOT NULL,
  target_kind ENUM('instance', 'database', 'platform') NOT NULL,
  target_id VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_name VARCHAR(120) NOT NULL,
  shared_by VARCHAR(120) NOT NULL,
  backup_created_at TIMESTAMP(3) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY kiln_backup_download_share_expiry_idx (expires_at)
);

CREATE TABLE IF NOT EXISTS kiln_schedule (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  cron_expression VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  timezone VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  created_by VARCHAR(36) NOT NULL,
  deleted_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY kiln_schedule_created_by_idx (created_by, updated_at),
  KEY kiln_schedule_enabled_idx (enabled, updated_at)
);

CREATE TABLE IF NOT EXISTS kiln_schedule_action (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  schedule_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  position SMALLINT UNSIGNED NOT NULL,
  action_type ENUM('console_command', 'backup', 'power', 'wait') NOT NULL,
  action_config JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY kiln_schedule_action_position_unique (schedule_id, position),
  CONSTRAINT kiln_schedule_action_schedule_fk
    FOREIGN KEY (schedule_id) REFERENCES kiln_schedule (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kiln_schedule_target (
  schedule_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_kind ENUM('instance', 'database', 'relay') NOT NULL,
  target_id VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_name VARCHAR(120) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (schedule_id, relay_id, target_kind, target_id),
  KEY kiln_schedule_target_relay_idx (relay_id, target_kind, target_id),
  CONSTRAINT kiln_schedule_target_schedule_fk
    FOREIGN KEY (schedule_id) REFERENCES kiln_schedule (id) ON DELETE CASCADE,
  CONSTRAINT kiln_schedule_target_relay_fk
    FOREIGN KEY (relay_id) REFERENCES kiln_relay (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kiln_schedule_deployment (
  schedule_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  desired_revision INT UNSIGNED NOT NULL,
  acknowledged_revision INT UNSIGNED NULL,
  status ENUM('pending', 'applied', 'error') NOT NULL DEFAULT 'pending',
  next_run_at TIMESTAMP(3) NULL,
  last_error VARCHAR(2000) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (schedule_id, relay_id),
  KEY kiln_schedule_deployment_status_idx (status, updated_at),
  CONSTRAINT kiln_schedule_deployment_schedule_fk
    FOREIGN KEY (schedule_id) REFERENCES kiln_schedule (id) ON DELETE CASCADE,
  CONSTRAINT kiln_schedule_deployment_relay_fk
    FOREIGN KEY (relay_id) REFERENCES kiln_relay (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kiln_schedule_run (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  schedule_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  relay_id CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scheduled_at TIMESTAMP(3) NOT NULL,
  status ENUM('running', 'succeeded', 'partial', 'failed', 'noop', 'interrupted', 'missed') NOT NULL,
  run_json JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY kiln_schedule_run_schedule_idx (schedule_id, scheduled_at DESC),
  KEY kiln_schedule_run_relay_idx (relay_id, scheduled_at DESC),
  CONSTRAINT kiln_schedule_run_relay_fk
    FOREIGN KEY (relay_id) REFERENCES kiln_relay (id) ON DELETE CASCADE
);
