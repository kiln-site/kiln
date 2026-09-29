import { Schema } from "effect"

export class CommandError extends Schema.TaggedError<CommandError>()(
  "CommandError",
  {
    executable: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export class RelayOperationError extends Schema.TaggedError<RelayOperationError>()(
  "RelayOperationError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  }
) {
  override get message() {
    return `Relay operation ${this.operation} failed`
  }
}

export class MclogsUploadError extends Schema.TaggedError<MclogsUploadError>()(
  "MclogsUploadError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {
  override get message() {
    return this.reason
  }
}

export class BrickRecipeError extends Schema.TaggedError<BrickRecipeError>()(
  "BrickRecipeError",
  {
    code: Schema.String,
    source: Schema.String,
    reason: Schema.String,
  }
) {
  override get message() {
    return `${this.reason} (${this.source})`
  }
}

export class RelayStateError extends Schema.TaggedError<RelayStateError>()(
  "RelayStateError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  }
) {
  override get message() {
    return `Relay state operation ${this.operation} failed`
  }
}

export class RelayIdentityError extends Schema.TaggedError<RelayIdentityError>()(
  "RelayIdentityError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  }
) {
  override get message() {
    return `Relay identity operation ${this.operation} failed`
  }
}

export class RelayTlsError extends Schema.TaggedError<RelayTlsError>()(
  "RelayTlsError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  }
) {
  override get message() {
    return `Relay TLS operation ${this.operation} failed`
  }
}

export class RelayPairingError extends Schema.TaggedError<RelayPairingError>()(
  "RelayPairingError",
  {
    code: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {
  override get message() {
    return this.code
  }
}

export class RelayFilesystemError extends Schema.TaggedError<RelayFilesystemError>()(
  "RelayFilesystemError",
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

export class RelayDatabaseBrowserError extends Schema.TaggedError<RelayDatabaseBrowserError>()(
  "RelayDatabaseBrowserError",
  {
    code: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {
  override get message() {
    return this.reason
  }
}

export class RelayBackupError extends Schema.TaggedError<RelayBackupError>()(
  "RelayBackupError",
  {
    code: Schema.String,
    operation: Schema.String,
    reason: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  }
) {
  override get message() {
    return this.reason
  }
}

export class RelayRemoteFileError extends Schema.TaggedError<RelayRemoteFileError>()(
  "RelayRemoteFileError",
  {
    code: Schema.String,
    source: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {
  override get message() {
    return this.reason
  }
}

export class RelayPortAllocationError extends Schema.TaggedError<RelayPortAllocationError>()(
  "RelayPortAllocationError",
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

export class RelaySystemUpdateError extends Schema.TaggedError<RelaySystemUpdateError>()(
  "RelaySystemUpdateError",
  {
    phase: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    rollbackFailures: Schema.Array(Schema.String),
  }
) {
  override get message() {
    return this.rollbackFailures.length === 0
      ? this.reason
      : `${this.reason}. Rollback also failed: ${this.rollbackFailures.join("; ")}`
  }
}
