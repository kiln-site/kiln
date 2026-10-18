import { Effect, Option, Schema } from "effect"

import { ExternalServiceError } from "@/effect/errors"

const cloudflareApiBaseUrl = "https://api.cloudflare.com/client/v4"

const CloudflareErrorSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.Number),
  message: Schema.String,
})

const CloudflareZoneSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.optionalKey(Schema.String),
})

const CloudflareDnsRecordSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
})

const CloudflareDnsRecordBatchSchema = Schema.Struct({
  posts: Schema.Array(CloudflareDnsRecordSchema),
})

const CloudflareErrorEnvelopeSchema = Schema.Struct({
  errors: Schema.optionalKey(Schema.Array(CloudflareErrorSchema)),
  success: Schema.Boolean,
})

const CloudflareResultInfoSchema = Schema.Struct({
  total_pages: Schema.optionalKey(Schema.Number),
})

const cloudflareEnvelopeSchema = <TValue>(result: Schema.Decoder<TValue>) =>
  Schema.Struct({
    errors: Schema.optionalKey(Schema.Array(CloudflareErrorSchema)),
    result: Schema.optionalKey(result),
    result_info: Schema.optionalKey(CloudflareResultInfoSchema),
    success: Schema.Boolean,
  })

export interface CloudflareZone {
  id: string
  name: string
}

export interface CloudflareDnsRecord {
  id: string
  name: string
  type: string
}

export type CloudflareAddressRecordType = "A" | "AAAA" | "CNAME"

export interface CloudflareAddressRecord {
  content: string
  name: string
  type: CloudflareAddressRecordType
}

export interface CloudflareSrvRecord {
  name: string
  port: number
  priority: number
  target: string
  weight: number
}

export function cloudflareAddressRecord(
  name: string,
  publicHost: string
): CloudflareAddressRecord {
  const addressFamily = ipAddressFamily(publicHost)
  return {
    content: publicHost,
    name,
    type: addressFamily === 4 ? "A" : addressFamily === 6 ? "AAAA" : "CNAME",
  }
}

function ipAddressFamily(host: string): 0 | 4 | 6 {
  const octets = host.split(".")
  if (
    octets.length === 4 &&
    octets.every(
      (octet) =>
        /^[0-9]{1,3}$/u.test(octet) &&
        Number(octet) >= 0 &&
        Number(octet) <= 255
    )
  ) {
    return 4
  }
  if (!host.includes(":")) return 0
  return Schema.decodeUnknownOption(Schema.URLFromString)(
    `http://[${host}]/`
  ).pipe(
    Option.filter((parsed) => parsed.hostname.startsWith("[")),
    Option.match({
      onNone: () => 0,
      onSome: () => 6,
    })
  )
}

// Cloudflare caps zone pages at 50; more pages than this is not a real token.
const zonePageLimit = 20

/** The active zones the token can read, by name. */
export const listCloudflareZonesEffect = Effect.fn("cloudflare.zones.list")(
  function* (apiToken: string) {
    const zones: Array<CloudflareZone> = []
    for (let page = 1; page <= zonePageLimit; page += 1) {
      const query = new URLSearchParams({
        page: String(page),
        per_page: "50",
        status: "active",
      })
      const { result, resultInfo } = yield* requestCloudflare(
        apiToken,
        `/zones?${query}`,
        Schema.Array(CloudflareZoneSchema)
      )
      for (const zone of result) {
        if (zone.status === undefined || zone.status === "active") {
          zones.push({ id: zone.id, name: zone.name.toLowerCase() })
        }
      }
      if (!resultInfo?.total_pages || page >= resultInfo.total_pages) break
    }
    return zones.sort((left, right) => left.name.localeCompare(right.name))
  }
)

export const cloudflareHostnameAvailableEffect = Effect.fn(
  "cloudflare.dns.available"
)(function* (apiToken: string, zoneId: string, hostname: string) {
  const query = new URLSearchParams({
    name: hostname,
    page: "1",
    per_page: "1",
  })
  const records = yield* requestCloudflareResult(
    apiToken,
    `/zones/${encodeURIComponent(zoneId)}/dns_records?${query}`,
    Schema.Array(CloudflareDnsRecordSchema)
  )
  return records.length === 0
})

export const createCloudflareAddressRecordEffect = Effect.fn(
  "cloudflare.dns.createAddress"
)(function* (
  apiToken: string,
  zoneId: string,
  record: CloudflareAddressRecord,
  instanceId: string
) {
  return yield* mutateCloudflareRecord(
    apiToken,
    zoneId,
    undefined,
    cloudflareAddressRecordBody(record, instanceId),
    "POST"
  )
})

export const createCloudflareSrvRecordEffect = Effect.fn(
  "cloudflare.dns.createSrv"
)(function* (
  apiToken: string,
  zoneId: string,
  record: CloudflareSrvRecord,
  instanceId: string
) {
  return yield* mutateCloudflareRecord(
    apiToken,
    zoneId,
    undefined,
    {
      comment: `Managed by Kiln for server ${instanceId}`,
      data: {
        port: record.port,
        priority: record.priority,
        target: record.target,
        weight: record.weight,
      },
      name: record.name,
      ttl: 1,
      type: "SRV",
    },
    "POST"
  )
})

export const updateCloudflareAddressRecordEffect = Effect.fn(
  "cloudflare.dns.updateAddress"
)(function* (
  apiToken: string,
  zoneId: string,
  recordId: string,
  record: CloudflareAddressRecord,
  instanceId: string
) {
  return yield* mutateCloudflareRecord(
    apiToken,
    zoneId,
    recordId,
    cloudflareAddressRecordBody(record, instanceId),
    "PATCH"
  )
})

export const replaceCloudflareAddressRecordEffect = Effect.fn(
  "cloudflare.dns.replaceAddress"
)(function* (
  apiToken: string,
  zoneId: string,
  recordId: string,
  record: CloudflareAddressRecord,
  instanceId: string
) {
  const result = yield* requestCloudflareResult(
    apiToken,
    `/zones/${encodeURIComponent(zoneId)}/dns_records/batch`,
    CloudflareDnsRecordBatchSchema,
    {
      body: JSON.stringify({
        deletes: [{ id: recordId }],
        posts: [cloudflareAddressRecordBody(record, instanceId)],
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }
  )
  const replacement = result.posts[0]
  if (!replacement) {
    return yield* cloudflareFailure(
      "Cloudflare did not return the replacement DNS record"
    )
  }
  return replacement
})

export const updateCloudflareSrvRecordEffect = Effect.fn(
  "cloudflare.dns.updateSrv"
)(function* (
  apiToken: string,
  zoneId: string,
  recordId: string,
  record: CloudflareSrvRecord,
  instanceId: string
) {
  return yield* mutateCloudflareRecord(
    apiToken,
    zoneId,
    recordId,
    {
      comment: `Managed by Kiln for server ${instanceId}`,
      data: {
        port: record.port,
        priority: record.priority,
        target: record.target,
        weight: record.weight,
      },
      name: record.name,
      ttl: 1,
      type: "SRV",
    },
    "PATCH"
  )
})

export const deleteCloudflareRecordEffect = Effect.fn("cloudflare.dns.delete")(
  function* (apiToken: string, zoneId: string, recordId: string) {
    yield* requestCloudflareResult(
      apiToken,
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
      Schema.Struct({ id: Schema.optionalKey(Schema.String) }),
      { method: "DELETE" },
      { notFoundResult: {} }
    )
  }
)

function mutateCloudflareRecord(
  apiToken: string,
  zoneId: string,
  recordId: string | undefined,
  body: object,
  method: "PATCH" | "POST"
): Effect.Effect<CloudflareDnsRecord, ExternalServiceError> {
  const suffix = recordId ? `/${encodeURIComponent(recordId)}` : ""
  return requestCloudflareResult(
    apiToken,
    `/zones/${encodeURIComponent(zoneId)}/dns_records${suffix}`,
    CloudflareDnsRecordSchema,
    {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method,
    }
  )
}

function cloudflareAddressRecordBody(
  record: CloudflareAddressRecord,
  instanceId: string
) {
  return {
    comment: `Managed by Kiln for server ${instanceId}`,
    content: record.content,
    name: record.name,
    proxied: false,
    ttl: 1,
    type: record.type,
  }
}

function requestCloudflareResult<TValue>(
  apiToken: string,
  path: string,
  resultSchema: Schema.Decoder<TValue>,
  init?: RequestInit,
  options?: {
    notFoundResult: TValue
  }
): Effect.Effect<TValue, ExternalServiceError> {
  return requestCloudflare(apiToken, path, resultSchema, init, options).pipe(
    Effect.map(({ result }) => result)
  )
}

function requestCloudflare<TValue>(
  apiToken: string,
  path: string,
  resultSchema: Schema.Decoder<TValue>,
  init?: RequestInit,
  options?: {
    notFoundResult: TValue
  }
): Effect.Effect<
  { result: TValue; resultInfo: { total_pages?: number } | undefined },
  ExternalServiceError
> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${cloudflareApiBaseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiToken}`,
          ...init?.headers,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        const payload = Schema.decodeUnknownSync(CloudflareErrorEnvelopeSchema)(
          await response.json()
        )
        if (
          options &&
          (response.status === 404 ||
            payload.errors?.some((error) => error.code === 81_044))
        ) {
          return { result: options.notFoundResult, resultInfo: undefined }
        }
        const message = payload.errors?.map((error) => error.message).join("; ")
        throw new Error(
          message || `Cloudflare returned HTTP ${response.status}`
        )
      }
      const payload = Schema.decodeUnknownSync(
        cloudflareEnvelopeSchema(resultSchema)
      )(await response.json())
      if (!payload.success || payload.result === undefined) {
        const message = payload.errors?.map((error) => error.message).join("; ")
        throw new Error(
          message || `Cloudflare returned HTTP ${response.status}`
        )
      }
      return { result: payload.result, resultInfo: payload.result_info }
    },
    catch: (cause) =>
      ExternalServiceError.make({
        cause,
        message:
          cause instanceof Error
            ? cause.message
            : "Cloudflare returned an invalid response",
        service: "Cloudflare",
      }),
  })
}

function cloudflareFailure(
  message: string
): Effect.Effect<never, ExternalServiceError> {
  return Effect.fail(
    ExternalServiceError.make({
      message,
      service: "Cloudflare",
    })
  )
}
