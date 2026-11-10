import { z } from "zod"

import { brickIdSchema, brickInputValueSchema } from "./brick-recipe.js"

/**
 * `kiln.brick/v1`, as game servers were described before Bricks covered
 * every kind. Kiln writes `kiln.brick/v2` (`brick-recipe.ts`) and converts a
 * v1 recipe when it reads one (`brick-conversion.ts`); this is only what
 * such a recipe looks like. Don't change it: copies stored under it are
 * named by a checksum of how it serializes.
 */
const brickVariableValueSchema = brickInputValueSchema

export const brickVariableV1Schema = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    label: z.string().min(1).max(80),
    description: z.string().min(1).max(280),
    required: z.boolean(),
    sensitive: z.boolean().default(false),
    default: brickVariableValueSchema.optional(),
    options: z.array(brickVariableValueSchema).min(1).max(64).optional(),
    rules: z
      .object({
        pattern: z.string().max(512).optional(),
        min: z.number().finite().optional(),
        max: z.number().finite().optional(),
        minLength: z.number().int().min(0).max(8_192).optional(),
        maxLength: z.number().int().min(1).max(8_192).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const brickReadinessSchema = z
  .object({
    logs: z.array(z.string().trim().min(1).max(256)).min(1).max(8),
  })
  .strict()

export const brickConsoleSchema = z
  .object({
    stopCommands: z.array(z.string().trim().min(1).max(128)).min(1).max(8),
  })
  .strict()

export const brickRecipeV1Schema = z
  .object({
    format: z.literal("kiln.brick/v1"),
    metadata: z
      .object({
        id: brickIdSchema,
        name: z.string().min(1).max(80),
        description: z.string().min(1).max(280),
        game: z.string().min(1).max(80),
        author: z.string().min(1).max(80),
        icon: z.string().trim().min(1).max(2_048).optional(),
        color: z
          .string()
          .regex(/^#[\da-f]{6}$/iu, "Brick colors must use #rrggbb")
          .optional(),
        documentation: z.url().max(2_048).optional(),
        tags: z
          .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/u))
          .max(12)
          .optional(),
      })
      .strict(),
    variables: z.record(
      z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u),
      brickVariableV1Schema
    ),
    runtime: z
      .object({
        image: z.string().min(1).max(512),
        name: z.string().min(1).max(80),
        environment: z.record(
          z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
          z.string().max(8_192)
        ),
        entrypoint: z.array(z.string().max(2_048)).max(32).optional(),
        command: z.array(z.string().max(2_048)).max(64).optional(),
        workingDirectory: z.string().startsWith("/").max(256).optional(),
        stopSignal: z
          .string()
          .regex(/^SIG[A-Z0-9]+$/u)
          .optional(),
        user: z
          .string()
          .regex(/^[0-9]+(?::[0-9]+)?$/u)
          .optional(),
        resources: z
          .object({
            memory: z.string().min(1).max(128),
            memoryReservation: z.string().min(1).max(128).optional(),
            pids: z.number().int().min(16).max(32_768).default(512),
          })
          .strict(),
        storage: z
          .object({ mount: z.string().startsWith("/").max(256) })
          .strict(),
      })
      .strict(),
    readiness: brickReadinessSchema.optional(),
    console: brickConsoleSchema.optional(),
    network: z
      .object({
        mode: z.enum(["minecraft-backend", "direct"]),
        primaryPort: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
        supportsSrv: z.boolean().default(false),
        hostname: z.string().min(1).max(256).optional(),
        ports: z
          .array(
            z
              .object({
                name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
                container: z.number().int().min(1).max(65_535),
                protocol: z.enum(["tcp", "udp", "both"]),
                host: z.number().int().min(1).max(65_535).optional(),
              })
              .strict()
          )
          .min(1)
          .max(16),
      })
      .strict(),
    constraints: z
      .object({
        architectures: z
          .array(z.enum(["amd64", "arm64"]))
          .min(1)
          .optional(),
      })
      .strict()
      .default({}),
  })
  .strict()

export type BrickVariableV1 = z.infer<typeof brickVariableV1Schema>
export type BrickReadiness = z.infer<typeof brickReadinessSchema>
export type BrickRecipeV1 = z.infer<typeof brickRecipeV1Schema>
