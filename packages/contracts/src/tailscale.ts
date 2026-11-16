import { z } from "zod"

const normalizedDnsNameSchema = (maximumLength: number) =>
  z
    .string()
    .trim()
    .transform((value) => value.replace(/^[.]+|[.]+$/gu, "").toLowerCase())
    .pipe(
      z
        .string()
        .min(1)
        .max(maximumLength)
        .regex(
          /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/u,
          "Use letters, numbers, hyphens, and dots"
        )
    )

export const relayTailscaleDomainSchema = normalizedDnsNameSchema(120)
export const relayTailscaleSubdomainSchema = normalizedDnsNameSchema(120)
/** A name in a tailnet, whole: its label or labels, then one of its TLDs. */
export const tunnelNameSchema = normalizedDnsNameSchema(253)
export const relayTailscaleHostnameSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(
    z
      .string()
      .min(1)
      .max(63)
      .regex(
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u,
        "Use letters, numbers, and hyphens"
      )
  )
