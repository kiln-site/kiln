import { CronExpressionParser } from "cron-parser"
import { Result } from "effect"
import { z } from "zod"

import {
  backupLocalDestinationSchema,
  backupModeSchema,
  backupObjectKeySchema,
  backupResticDestinationSchema,
  backupS3CredentialSchema,
} from "./backups.js"

export const scheduleActionTypeSchema = z.enum([
  "console_command",
  "backup",
  "power",
  "wait",
])

export type ScheduleActionType = z.infer<typeof scheduleActionTypeSchema>

const scheduleActionIdSchema = z.uuid()
const scheduleActionTargetKeysSchema = z
  .array(z.string().trim().min(1).max(512))
  .max(2_000)
  .optional()

export const scheduleConsoleCommandActionSchema = z
  .object({
    command: z.string().trim().min(1).max(4_096),
    id: scheduleActionIdSchema,
    targetKeys: scheduleActionTargetKeysSchema,
    type: z.literal("console_command"),
  })
  .strict()

export const scheduleBackupActionSchema = z
  .object({
    destination: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("local") }).strict(),
        z
          .object({
            kind: z.literal("storage"),
            storageId: z.uuid(),
          })
          .strict(),
      ])
      .default({ kind: "local" }),
    id: scheduleActionIdSchema,
    mode: backupModeSchema.default("full"),
    name: z
      .string()
      .trim()
      .max(120)
      .transform((name) => name || "Scheduled backup")
      .default("Scheduled backup"),
    targetKeys: scheduleActionTargetKeysSchema,
    type: z.literal("backup"),
  })
  .strict()

export const schedulePowerActionSchema = z
  .object({
    action: z.enum(["start", "stop", "restart", "kill"]),
    id: scheduleActionIdSchema,
    targetKeys: scheduleActionTargetKeysSchema,
    type: z.literal("power"),
  })
  .strict()

export const scheduleWaitUnitSchema = z.enum([
  "milliseconds",
  "seconds",
  "minutes",
  "hours",
  "days",
])

export type ScheduleWaitUnit = z.infer<typeof scheduleWaitUnitSchema>

export const scheduleWaitActionSchema = z
  .object({
    duration: z
      .number()
      .int()
      .positive()
      .max(Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000)),
    id: scheduleActionIdSchema,
    type: z.literal("wait"),
    unit: scheduleWaitUnitSchema.default("seconds"),
  })
  .strict()

export const scheduleActionSchema = z.discriminatedUnion("type", [
  scheduleConsoleCommandActionSchema,
  scheduleBackupActionSchema,
  schedulePowerActionSchema,
  scheduleWaitActionSchema,
])

export type ScheduleAction = z.infer<typeof scheduleActionSchema>

export const scheduleTargetSchema = z
  .object({
    id: z.string().min(1).max(120),
    kind: z.enum(["instance", "database", "relay"]),
    name: z.string().trim().min(1).max(120),
    relayId: z.string().min(1).max(120),
  })
  .strict()

export type ScheduleTarget = z.infer<typeof scheduleTargetSchema>

export const scheduleCronAliases = {
  daily: "0 0 * * *",
  hourly: "0 * * * *",
  monthly: "0 0 1 * *",
  weekly: "0 0 * * 0",
} as const

export type ScheduleCronAlias = keyof typeof scheduleCronAliases

export function normalizeScheduleCron(value: string): string {
  const normalized = value.trim().toLowerCase()
  return scheduleCronAliases[normalized as ScheduleCronAlias] ?? value.trim()
}

export function validateScheduleTimezone(value: string): boolean {
  return Result.isSuccess(
    Result.try(() =>
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format()
    )
  )
}

export function validateScheduleCron(value: string, timezone: string): boolean {
  if (!validateScheduleTimezone(timezone)) return false
  return Result.isSuccess(
    Result.try(() => {
      const normalized = normalizeScheduleCron(value)
      if (normalized.split(/\s+/u).length !== 5) {
        throw new Error("Cron expression must have five fields")
      }
      CronExpressionParser.parse(normalized, {
        currentDate: new Date(),
        tz: timezone,
      })
    })
  )
}

export function nextScheduleOccurrence(
  expression: string,
  timezone: string,
  after: Date | number | string = new Date()
): Date {
  return CronExpressionParser.parse(normalizeScheduleCron(expression), {
    currentDate: after,
    tz: timezone,
  })
    .next()
    .toDate()
}

export const scheduleInputSchema = z.object({
  actions: z.array(scheduleActionSchema).min(1).max(32),
  // Keeps running a target's later actions after one fails. Older Relays
  // reject unknown keys, so Hearth omits it from projections when off and
  // only turns it on for Relays with the `schedule-continue-on-failure`
  // capability.
  continueOnFailure: z.boolean().optional(),
  cron: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  name: z.string().trim().min(1).max(120),
  targets: z.array(scheduleTargetSchema).min(1).max(2_000),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine(validateScheduleTimezone, "Timezone is invalid"),
})

export const scheduleDefinitionSchema = scheduleInputSchema
  .safeExtend({
    id: z.uuid(),
    revision: z.number().int().positive(),
  })
  .strict()
  .superRefine((schedule, context) => {
    if (!validateScheduleCron(schedule.cron, schedule.timezone)) {
      context.addIssue({
        code: "custom",
        message: "Cron expression is invalid",
        path: ["cron"],
      })
    }
    const actionIds = new Set(schedule.actions.map((action) => action.id))
    if (actionIds.size !== schedule.actions.length) {
      context.addIssue({
        code: "custom",
        message: "Action IDs must be unique",
        path: ["actions"],
      })
    }
    const targetIds = new Set(
      schedule.targets.map(
        (target) => `${target.relayId}:${target.kind}:${target.id}`
      )
    )
    if (targetIds.size !== schedule.targets.length) {
      context.addIssue({
        code: "custom",
        message: "Targets must be unique",
        path: ["targets"],
      })
    }
    for (const [actionIndex, action] of schedule.actions.entries()) {
      if (action.type === "wait") continue
      if (action.targetKeys === undefined) continue
      const seenTargetKeys = new Set<string>()
      for (const targetKey of action.targetKeys) {
        if (seenTargetKeys.has(targetKey)) {
          context.addIssue({
            code: "custom",
            message: "Action target overrides must be unique",
            path: ["actions", actionIndex, "targetKeys"],
          })
        }
        seenTargetKeys.add(targetKey)
        if (!targetIds.has(targetKey)) {
          context.addIssue({
            code: "custom",
            message: "Action target overrides must reference selected targets",
            path: ["actions", actionIndex, "targetKeys"],
          })
        }
      }
    }
  })

export type ScheduleDefinition = z.infer<typeof scheduleDefinitionSchema>

export const relayScheduleS3DestinationSchema = backupS3CredentialSchema
  .safeExtend({
    kind: z.literal("s3"),
    objectKeyPrefix: backupObjectKeySchema,
  })
  .strict()

const relayScheduleBackupExecutionSchema = z
  .object({
    destination: z.discriminatedUnion("kind", [
      backupLocalDestinationSchema,
      backupResticDestinationSchema,
      relayScheduleS3DestinationSchema,
    ]),
    mode: backupModeSchema,
    targetId: z.string().min(1).max(120),
    targetKind: z.enum(["instance", "database", "relay"]),
  })
  .strict()

export const relayScheduleBackupActionSchema = scheduleBackupActionSchema
  .safeExtend({
    executions: z
      .array(relayScheduleBackupExecutionSchema)
      .max(2_000)
      .default([]),
  })
  .strict()

export const relayScheduleActionSchema = z.discriminatedUnion("type", [
  scheduleConsoleCommandActionSchema,
  relayScheduleBackupActionSchema,
  schedulePowerActionSchema,
  scheduleWaitActionSchema,
])

export type RelayScheduleAction = z.infer<typeof relayScheduleActionSchema>

export const relayScheduleProjectionSchema = scheduleDefinitionSchema
  .safeExtend({
    actions: z.array(relayScheduleActionSchema).min(1).max(32),
  })
  .strict()

export type RelayScheduleProjection = z.infer<
  typeof relayScheduleProjectionSchema
>

export const scheduleAttemptStatusSchema = z.enum([
  "succeeded",
  "failed",
  "skipped_unsupported",
  "skipped_missing",
  "skipped_policy",
  "interrupted",
  "not_run",
])

export const scheduleTargetRunStatusSchema = z.enum([
  "succeeded",
  "noop",
  "failed",
  "interrupted",
  "skipped_overlap",
])

export const scheduleRunStatusSchema = z.enum([
  "running",
  "succeeded",
  "partial",
  "failed",
  "noop",
  "interrupted",
  "missed",
])

export const scheduleActionAttemptSchema = z
  .object({
    actionId: z.uuid(),
    actionType: scheduleActionTypeSchema,
    error: z.string().max(2_000).nullable(),
    finishedAt: z.number().int().nonnegative(),
    id: z.string().min(1).max(128),
    startedAt: z.number().int().nonnegative(),
    status: scheduleAttemptStatusSchema,
  })
  .strict()

export type ScheduleActionAttempt = z.infer<typeof scheduleActionAttemptSchema>

export const scheduleTargetRunSchema = z
  .object({
    attempts: z.array(scheduleActionAttemptSchema).max(32),
    error: z.string().max(2_000).nullable(),
    finishedAt: z.number().int().nonnegative(),
    id: z.string().min(1).max(128),
    startedAt: z.number().int().nonnegative(),
    status: scheduleTargetRunStatusSchema,
    target: scheduleTargetSchema,
  })
  .strict()

export const scheduleRunSchema = z
  .object({
    finishedAt: z.number().int().nonnegative(),
    id: z.string().min(1).max(128),
    revision: z.number().int().positive(),
    scheduleId: z.uuid(),
    scheduledAt: z.number().int().nonnegative(),
    sequenceAttempts: z.array(scheduleActionAttemptSchema).max(32).default([]),
    startedAt: z.number().int().nonnegative(),
    status: scheduleRunStatusSchema,
    targetRuns: z.array(scheduleTargetRunSchema).max(2_000),
  })
  .strict()

export type ScheduleRun = z.infer<typeof scheduleRunSchema>

export const relayScheduleDeploymentSchema = z
  .object({
    acknowledgedRevision: z.number().int().positive(),
    nextRunAt: z.number().int().nonnegative().nullable(),
    scheduleId: z.uuid(),
  })
  .strict()

export type RelayScheduleDeployment = z.infer<
  typeof relayScheduleDeploymentSchema
>

export const relayScheduleOverviewSchema = z
  .object({
    deployments: z.array(relayScheduleDeploymentSchema),
    runs: z.array(scheduleRunSchema),
  })
  .strict()

export function scheduleStableId(...parts: ReadonlyArray<string | number>) {
  const value = parts.map(String).join("\u001f")
  return [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => {
      let hash = seed >>> 0
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return hash.toString(16).padStart(8, "0")
    })
    .join("")
}

export function scheduleDeterministicUuid(
  ...parts: ReadonlyArray<string | number>
) {
  const hash = scheduleStableId(...parts).split("")
  hash[12] = "5"
  hash[16] = ((Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8).toString(16)
  const value = hash.join("")
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

export function resolveScheduleBackupName(
  template: string,
  context: {
    backupId: string
    instanceId: string
    runId: string
    scheduleId: string
    scheduleName: string
    timestamp: number
  }
) {
  const isoTimestamp = new Date(context.timestamp).toISOString()
  const timestamp = `${isoTimestamp.slice(0, 10).replaceAll("-", ".")}-${isoTimestamp.slice(11, 19).replaceAll(":", ".")}Z`
  const tags: Record<string, string> = {
    "<backup_id>": context.backupId,
    "<instance_id>": context.instanceId,
    "<run_id>": context.runId,
    "<schedule>": context.scheduleName,
    "<schedule_id>": context.scheduleId,
    "<timestamp>": timestamp,
  }
  const resolved = template.replaceAll(
    /<(?:backup_id|instance_id|run_id|schedule|schedule_id|timestamp)>/gu,
    (tag) => tags[tag] ?? tag
  )
  return resolved.slice(0, 120)
}

export function scheduleActionSupportsTarget(
  action: {
    action?: "kill" | "restart" | "start" | "stop"
    mode?: "full" | "incremental"
    type: ScheduleActionType
  },
  target: Pick<ScheduleTarget, "kind">
): boolean {
  if (action.type === "wait") return true
  if (action.type === "console_command") return target.kind === "instance"
  if (action.type === "power") {
    return (
      target.kind !== "relay" &&
      !(target.kind === "database" && action.action === "kill")
    )
  }
  if (action.mode === "incremental") return target.kind === "instance"
  return true
}

export function scheduleTargetKey(
  target: Pick<ScheduleTarget, "id" | "kind" | "relayId">
) {
  return `${target.relayId}:${target.kind}:${target.id}`
}

export function scheduleActionAppliesToTarget(
  action: {
    targetKeys?: ReadonlyArray<string>
    action?: "kill" | "restart" | "start" | "stop"
    mode?: "full" | "incremental"
    type: ScheduleActionType
  },
  target: ScheduleTarget
) {
  if (action.type === "wait") return true
  return (
    scheduleActionSupportsTarget(action, target) &&
    (action.targetKeys === undefined ||
      action.targetKeys.includes(scheduleTargetKey(target)))
  )
}
