import { z } from "zod"

const stateReasonWithoutDetailsSchema = z
  .object({
    code: z.enum([
      "waiting_for_readiness",
      "health_check_starting",
      "health_check_failed",
      "container_restarting",
      "out_of_memory",
      "out_of_memory_while_stopping",
      "unknown",
    ]),
  })
  .strict()

const processExitStateReasonSchema = z
  .object({
    code: z.literal("process_exit"),
    exitCode: z.number().int(),
  })
  .strict()

const recoveryStateReasonSchema = z
  .object({
    code: z.literal("automatic_recovery"),
    exitCode: z.number().int().nullable(),
    phase: z.enum(["pending", "restarting", "failed"]),
    reason: z.enum([
      "clean_exit",
      "process_exit",
      "out_of_memory",
      "start_failed",
    ]),
  })
  .strict()

export const relayServerStateReasonSchema = z.union([
  stateReasonWithoutDetailsSchema,
  processExitStateReasonSchema,
  recoveryStateReasonSchema,
])

export type RelayServerStateReason = z.infer<
  typeof relayServerStateReasonSchema
>

export function formatRelayServerStateReason(
  reason: RelayServerStateReason
): string {
  switch (reason.code) {
    case "waiting_for_readiness":
      return "Waiting for the configured server port to accept connections."
    case "health_check_starting":
      return "Docker health check is still starting."
    case "health_check_failed":
      return "Docker health check reported unhealthy."
    case "container_restarting":
      return "Docker is restarting the server container."
    case "out_of_memory":
      return "The server was stopped by an out-of-memory kill."
    case "out_of_memory_while_stopping":
      return "The server is stopped after an out-of-memory kill. The process may not have shut down gracefully; increase memory or use its console stop command."
    case "process_exit":
      return `The server process exited with code ${reason.exitCode}.`
    case "automatic_recovery":
      return formatAutomaticRecoveryReason(reason)
    case "unknown":
      return "Relay could not determine why the server failed."
  }
}

function formatAutomaticRecoveryReason(
  reason: Extract<RelayServerStateReason, { code: "automatic_recovery" }>
): string {
  const phase =
    reason.phase === "pending"
      ? "is scheduled"
      : reason.phase === "restarting"
        ? "is restarting the server"
        : "stopped after exhausting its attempts"
  const cause =
    reason.reason === "out_of_memory"
      ? "an out-of-memory kill"
      : reason.reason === "start_failed"
        ? "a failed restart attempt"
        : reason.reason === "clean_exit"
          ? "a clean process exit"
          : reason.exitCode === null
            ? "a process exit"
            : `process exit code ${reason.exitCode}`
  return `Automatic recovery ${phase} after ${cause}.`
}
