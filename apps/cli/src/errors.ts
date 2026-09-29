import { Schema } from "effect"

export class CliCommandError extends Schema.TaggedError<CliCommandError>()(
  "CliCommandError",
  {
    code: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
    exitCode: Schema.Number,
    requestId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export function commandError(input: {
  cause?: unknown
  code: string
  exitCode?: number
  message: string
  requestId?: string
  retryable?: boolean
}): CliCommandError {
  return CliCommandError.make({
    code: input.code,
    message: input.message,
    retryable: input.retryable ?? false,
    exitCode: input.exitCode ?? 1,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  })
}
