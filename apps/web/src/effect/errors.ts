import { Schema } from "effect"

export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
  "DatabaseError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  }
) {
  override get message() {
    return `Database operation ${this.operation} failed`
  }
}

export class FilePinLimitError extends Schema.TaggedError<FilePinLimitError>()(
  "FilePinLimitError",
  { limit: Schema.Number }
) {
  override get message() {
    return `This server already has ${this.limit} pinned files`
  }
}

export class BackupLimitError extends Schema.TaggedError<BackupLimitError>()(
  "BackupLimitError",
  {
    kind: Schema.Literals(["quantity", "size"]),
    limit: Schema.Number,
    used: Schema.Number,
  }
) {
  override get message() {
    return this.kind === "quantity"
      ? `This resource has reached its ${this.limit} backup limit`
      : "This resource does not have enough backup storage remaining"
  }
}

export class BackupStorageError extends Schema.TaggedError<BackupStorageError>()(
  "BackupStorageError",
  {
    code: Schema.String,
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {
  override get message() {
    return this.reason
  }
}

export class CacheError extends Schema.TaggedError<CacheError>()(
  "CacheError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  }
) {
  override get message() {
    return `Cache operation ${this.operation} failed`
  }
}

export class CredentialError extends Schema.TaggedError<CredentialError>()(
  "CredentialError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  }
) {
  override get message() {
    return `Credential operation ${this.operation} failed`
  }
}

export class CliAccessError extends Schema.TaggedError<CliAccessError>()(
  "CliAccessError",
  {
    code: Schema.Literals([
      "access_denied",
      "authentication_required",
      "authorization_pending",
      "conflict",
      "expired_token",
      "forbidden",
      "invalid_grant",
      "invalid_request",
      "not_found",
      "rate_limited",
      "relay_operation_failed",
      "relay_unavailable",
      "sftp_unavailable",
      "slow_down",
      "unexpected_error",
    ]),
    message: Schema.String,
    retryable: Schema.Boolean,
    detail: Schema.optional(Schema.String),
    requestId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export class AuthenticationError extends Schema.TaggedError<AuthenticationError>()(
  "AuthenticationError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export class RelayUnavailableError extends Schema.TaggedError<RelayUnavailableError>()(
  "RelayUnavailableError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.String),
    requestId: Schema.optional(Schema.String),
    retryable: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export class RelayResponseError extends Schema.TaggedError<RelayResponseError>()(
  "RelayResponseError",
  {
    message: Schema.String,
    status: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export class PermissionDeniedError extends Schema.TaggedError<PermissionDeniedError>()(
  "PermissionDeniedError",
  { message: Schema.String }
) {}

export class ResourceNotFoundError extends Schema.TaggedError<ResourceNotFoundError>()(
  "ResourceNotFoundError",
  {
    resource: Schema.String,
    message: Schema.String,
  }
) {}

export class ExternalServiceError extends Schema.TaggedError<ExternalServiceError>()(
  "ExternalServiceError",
  {
    service: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export class TailscaleOrchestrationError extends Schema.TaggedError<TailscaleOrchestrationError>()(
  "TailscaleOrchestrationError",
  {
    phase: Schema.Literals([
      "validation",
      "apply",
      "dns",
      "prepare",
      "rollback",
      "finalize",
      "cleanup",
    ]),
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {
  override get message() {
    return this.reason
  }
}

export type AppError =
  | AuthenticationError
  | BackupLimitError
  | BackupStorageError
  | CacheError
  | CliAccessError
  | CredentialError
  | DatabaseError
  | ExternalServiceError
  | FilePinLimitError
  | PermissionDeniedError
  | RelayResponseError
  | RelayUnavailableError
  | ResourceNotFoundError
  | TailscaleOrchestrationError
