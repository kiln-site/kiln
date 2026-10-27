import { Result } from "effect"
import { z } from "zod"

export const domainNameSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^[.]+|[.]+$/gu, "").toLowerCase())
  .pipe(
    z
      .string()
      .min(3, "Enter a domain")
      .max(253)
      .regex(
        /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u,
        "Enter a fully qualified domain"
      )
  )

export const vanityLabelSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(
    z
      .string()
      .min(1, "Enter a server address")
      .max(63)
      .regex(
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
        "Use lowercase letters, numbers, and single hyphens"
      )
  )

/** Whether `domain` is `zoneName` or a name inside it. */
export function domainInZone(domain: string, zoneName: string): boolean {
  return domain === zoneName || domain.endsWith(`.${zoneName}`)
}

export const domainBlacklistPatternsSchema = z
  .array(z.string().trim().min(1).max(128))
  .max(32)

/**
 * A reserved-names line that stands for profanity, spelled out or disguised,
 * from the list Kiln ships rather than a regular expression.
 */
export const badWordsPattern = "{{bad-words}}"

export const defaultDomainBlacklistPatterns = [
  badWordsPattern,
  "^(admin|api|ftp|mail|status|support|www)$",
] as const

export function validateBlacklistPatterns(
  patterns: ReadonlyArray<string>
): Array<string> {
  return patterns.map((pattern, index) =>
    pattern === badWordsPattern
      ? pattern
      : Result.getOrThrow(
          Result.try({
            try: () => {
              new RegExp(pattern, "iu")
              return pattern
            },
            catch: () =>
              new Error(`Blacklist pattern ${index + 1} is not valid`),
          })
        )
  )
}
