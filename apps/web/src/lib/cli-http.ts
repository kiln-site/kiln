import { CliAccessError } from "@/effect/errors"
import { z } from "zod"

const CLI_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const

export function cliJsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: CLI_RESPONSE_HEADERS,
    status,
  })
}

export function cliInvalidRequest(cause: unknown): CliAccessError {
  const detail = cause instanceof z.ZodError ? zodIssueDetail(cause) : null
  return CliAccessError.make({
    code: "invalid_request",
    ...(detail ? { detail } : {}),
    message: "The CLI request contains invalid input.",
    retryable: false,
    cause,
  })
}

export function cliFailureResponse(cause: unknown): Response {
  if (cause instanceof CliAccessError) {
    return cliJsonResponse(
      {
        error: {
          code: cause.code,
          ...(cause.detail ? { cause: cause.detail } : {}),
          message: cause.message,
          ...(cause.requestId ? { requestId: cause.requestId } : {}),
          retryable: cause.retryable,
        },
      },
      statusForCliError(cause.code)
    )
  }
  return cliJsonResponse(
    {
      error: {
        code: "unexpected_error",
        message: "Hearth could not complete the CLI request.",
        retryable: false,
      },
    },
    500
  )
}

function statusForCliError(code: CliAccessError["code"]): number {
  if (code === "authentication_required") return 401
  if (code === "forbidden" || code === "access_denied") return 403
  if (code === "not_found") return 404
  if (code === "conflict") return 409
  if (code === "rate_limited" || code === "slow_down") return 429
  if (code === "relay_operation_failed") return 502
  if (code === "relay_unavailable") return 502
  if (code === "sftp_unavailable") return 503
  if (code === "unexpected_error") return 500
  return 400
}

function zodIssueDetail(error: z.ZodError): string | null {
  const detail = error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".")
      return `${path ? `${path}: ` : ""}${issue.message}`
    })
    .join("; ")
  if (!detail) return null
  return detail.length <= 240 ? detail : `${detail.slice(0, 237)}...`
}
