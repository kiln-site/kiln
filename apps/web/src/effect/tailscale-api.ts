import { Effect, Schedule, Schema } from "effect"

import { ExternalServiceError } from "@/effect/errors"
import type { TailscaleOAuthCredential } from "@/effect/tailscale-networks"

const tailscaleApiBaseUrl = "https://api.tailscale.com/api/v2"
const tailscaleOAuthTokenUrl = `${tailscaleApiBaseUrl}/oauth/token`

export const requiredTailscaleOAuthScopes = [
  "auth_keys",
  "devices:core",
  "devices:routes",
  "dns",
] as const

const OAuthTokenSchema = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String),
  token_type: Schema.optionalKey(Schema.String),
})

const TailscaleKeySchema = Schema.Struct({
  id: Schema.String,
  key: Schema.optionalKey(Schema.String),
  scopes: Schema.optionalKey(Schema.Array(Schema.String)),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
})

const TailscaleDeviceSchema = Schema.Struct({
  addresses: Schema.optionalKey(Schema.Array(Schema.String)),
  hostname: Schema.optionalKey(Schema.String),
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
})

const TailscaleDevicesSchema = Schema.Struct({
  devices: Schema.Array(TailscaleDeviceSchema),
})

const TailscaleDeviceRoutesSchema = Schema.Struct({
  advertisedRoutes: Schema.optionalKey(Schema.Array(Schema.String)),
  enabledRoutes: Schema.optionalKey(Schema.Array(Schema.String)),
})

const TailscaleSplitDnsSchema = Schema.Record(
  Schema.String,
  Schema.Array(Schema.String)
)

class TailscaleRoutePendingError extends Schema.TaggedError<TailscaleRoutePendingError>()(
  "TailscaleRoutePendingError",
  {
    message: Schema.String,
  }
) {}

interface TailscaleControlPlaneDeployment {
  hostname: string
  status: {
    ipv4Address: string | null
  }
  subnet: string
}

interface TailscaleControlPlaneNetwork {
  deployments: ReadonlyArray<TailscaleControlPlaneDeployment>
  domain: string
  id: string
  name: string
  previousDomain?: string
}

interface TailscaleSession {
  accessToken: string
  clientId: string
  scopes: Array<string>
  tags: Array<string>
}

export interface VerifiedTailscaleOAuthCredential {
  clientId: string
  scopes: Array<string>
  tags: Array<string>
}

export interface TailscaleControlPlaneInspection {
  dns: {
    currentResolvers: Array<string>
    desiredResolvers: Array<string>
    previousDomain: string | null
    previousResolvers: Array<string>
  }
  routes: Array<{
    advertised: boolean
    approved: boolean
    hostname: string
    subnet: string
    tailnetIp: string | null
  }>
}

export const verifyTailscaleOAuthCredentialEffect = Effect.fn(
  "tailscale.oauth.verify"
)(function* (clientId: string, clientSecret: string, tags: Array<string>) {
  const session = yield* tailscaleSessionEffect(clientId, clientSecret, tags)
  return {
    clientId: session.clientId,
    scopes: session.scopes,
    tags: session.tags,
  } satisfies VerifiedTailscaleOAuthCredential
})

export const createTailscaleNodeAuthKeyEffect = Effect.fn(
  "tailscale.authKey.create"
)(function* (credential: TailscaleOAuthCredential, nodeName: string) {
  const session = yield* tailscaleSessionEffect(
    credential.clientId,
    credential.clientSecret,
    credential.tags
  )
  const result = yield* requestTailscaleJson(
    `${tailscaleApiBaseUrl}/tailnet/-/keys`,
    session.accessToken,
    TailscaleKeySchema,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capabilities: {
          devices: {
            create: {
              ephemeral: false,
              preauthorized: true,
              reusable: false,
              tags: session.tags,
            },
          },
        },
        description: `Kiln ${nodeName}`.slice(0, 50),
        expirySeconds: 600,
        keyType: "auth",
      }),
    }
  )
  if (!result.key) {
    return yield* tailscaleFailure(
      "Tailscale did not return the new node auth key"
    )
  }
  return result.key
})

export const syncTailscaleControlPlaneEffect = Effect.fn(
  "tailscale.controlPlane.sync"
)(function* (
  credential: TailscaleOAuthCredential,
  network: TailscaleControlPlaneNetwork
) {
  yield* Effect.annotateCurrentSpan({
    "tailscale.network.id": network.id,
    "tailscale.network.nodes": network.deployments.length,
  })
  const session = yield* tailscaleSessionEffect(
    credential.clientId,
    credential.clientSecret,
    credential.tags
  )
  for (const deployment of network.deployments) {
    yield* approveDeploymentRouteEffect(session, deployment).pipe(
      Effect.retry({
        schedule: Schedule.spaced("2 seconds"),
        times: 15,
        while: (error) => error._tag === "TailscaleRoutePendingError",
      }),
      Effect.catchTag("TailscaleRoutePendingError", (error) =>
        tailscaleFailure(error.message)
      )
    )
  }

  const resolvers = [
    ...new Set(
      network.deployments.flatMap(({ status }) =>
        status.ipv4Address ? [status.ipv4Address] : []
      )
    ),
  ].sort()
  yield* requestTailscaleJson(
    `${tailscaleApiBaseUrl}/tailnet/-/dns/split-dns`,
    session.accessToken,
    TailscaleSplitDnsSchema,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        [network.domain]: resolvers.length > 0 ? resolvers : null,
        ...(network.previousDomain && network.previousDomain !== network.domain
          ? { [network.previousDomain]: null }
          : {}),
      }),
    }
  )
  return { resolvers }
})

export const inspectTailscaleControlPlaneEffect = Effect.fn(
  "tailscale.controlPlane.inspect"
)(function* (
  credential: TailscaleOAuthCredential,
  network: TailscaleControlPlaneNetwork
) {
  const session = yield* tailscaleSessionEffect(
    credential.clientId,
    credential.clientSecret,
    credential.tags
  )
  const [splitDns, devicesResult] = yield* Effect.all([
    requestTailscaleJson(
      `${tailscaleApiBaseUrl}/tailnet/-/dns/split-dns`,
      session.accessToken,
      TailscaleSplitDnsSchema
    ),
    requestTailscaleJson(
      `${tailscaleApiBaseUrl}/tailnet/-/devices?fields=all`,
      session.accessToken,
      TailscaleDevicesSchema
    ),
  ])
  const routes = yield* Effect.forEach(
    network.deployments,
    (deployment) =>
      inspectDeploymentRouteEffect(session, devicesResult.devices, deployment),
    { concurrency: 4 }
  )
  const desiredResolvers = [
    ...new Set(
      network.deployments.flatMap(({ status }) =>
        status.ipv4Address ? [status.ipv4Address] : []
      )
    ),
  ].sort()
  return {
    dns: {
      currentResolvers: [...(splitDns[network.domain] ?? [])].sort(),
      desiredResolvers,
      previousDomain:
        network.previousDomain && network.previousDomain !== network.domain
          ? network.previousDomain
          : null,
      previousResolvers:
        network.previousDomain && network.previousDomain !== network.domain
          ? [...(splitDns[network.previousDomain] ?? [])].sort()
          : [],
    },
    routes,
  } satisfies TailscaleControlPlaneInspection
})

export const removeTailscaleControlPlaneDeviceEffect = Effect.fn(
  "tailscale.controlPlane.removeDevice"
)(function* (
  credential: TailscaleOAuthCredential,
  deployment: TailscaleControlPlaneDeployment
) {
  const session = yield* tailscaleSessionEffect(
    credential.clientId,
    credential.clientSecret,
    credential.tags
  )
  const result = yield* requestTailscaleJson(
    `${tailscaleApiBaseUrl}/tailnet/-/devices?fields=all`,
    session.accessToken,
    TailscaleDevicesSchema
  )
  const device = findTailscaleDevice(result.devices, deployment)
  if (!device) return
  yield* requestTailscaleVoid(
    `${tailscaleApiBaseUrl}/device/${encodeURIComponent(device.id)}`,
    session.accessToken,
    { method: "DELETE" }
  )
})

export function missingTailscaleOAuthScopes(
  scopes: ReadonlyArray<string>
): Array<(typeof requiredTailscaleOAuthScopes)[number]> {
  const available = new Set(scopes)
  return requiredTailscaleOAuthScopes.filter((scope) => !available.has(scope))
}

export function findTailscaleDevice(
  devices: ReadonlyArray<typeof TailscaleDeviceSchema.Type>,
  deployment: TailscaleControlPlaneDeployment
) {
  const address = deployment.status.ipv4Address
  const byAddress = address
    ? devices.find((device) => device.addresses?.includes(address))
    : undefined
  if (byAddress) return byAddress
  return devices.find(
    (device) =>
      device.hostname === deployment.hostname ||
      device.name === deployment.hostname ||
      device.name?.startsWith(`${deployment.hostname}.`)
  )
}

const tailscaleSessionEffect = Effect.fn("tailscale.oauth.session")(function* (
  clientId: string,
  clientSecret: string,
  tags: Array<string>
) {
  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: requiredTailscaleOAuthScopes.join(" "),
    tags: tags.join(" "),
  })
  const token = yield* requestTailscaleJson(
    tailscaleOAuthTokenUrl,
    null,
    OAuthTokenSchema,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    }
  )
  // The token endpoint has already authorized the exact scopes and tags in
  // the request. OAuth token responses may omit `scope` when it is unchanged.
  const scopes = [
    ...new Set(
      token.scope?.split(/\s+/u).filter(Boolean) ?? requiredTailscaleOAuthScopes
    ),
  ].sort()
  const missing = missingTailscaleOAuthScopes(scopes)
  if (missing.length > 0) {
    return yield* tailscaleFailure(
      `Kiln requires these OAuth scopes: ${missing.join(", ")}`
    )
  }
  const authorizedTags = [...new Set(tags)].sort()
  if (authorizedTags.length === 0) {
    return yield* tailscaleFailure(
      "The Kiln OAuth client must include at least one device tag"
    )
  }
  return {
    accessToken: token.access_token,
    clientId,
    scopes,
    tags: authorizedTags,
  } satisfies TailscaleSession
})

const inspectDeploymentRouteEffect = Effect.fn(
  "tailscale.controlPlane.inspectRoute"
)(function* (
  session: TailscaleSession,
  devices: ReadonlyArray<typeof TailscaleDeviceSchema.Type>,
  deployment: TailscaleControlPlaneDeployment
) {
  const device = findTailscaleDevice(devices, deployment)
  if (!device) {
    return {
      advertised: false,
      approved: false,
      hostname: deployment.hostname,
      subnet: deployment.subnet,
      tailnetIp: deployment.status.ipv4Address,
    }
  }
  const routes = yield* requestTailscaleJson(
    `${tailscaleApiBaseUrl}/device/${encodeURIComponent(device.id)}/routes`,
    session.accessToken,
    TailscaleDeviceRoutesSchema
  )
  return {
    advertised: routes.advertisedRoutes?.includes(deployment.subnet) ?? false,
    approved: routes.enabledRoutes?.includes(deployment.subnet) ?? false,
    hostname: deployment.hostname,
    subnet: deployment.subnet,
    tailnetIp: deployment.status.ipv4Address,
  }
})

const approveDeploymentRouteEffect = Effect.fn(
  "tailscale.controlPlane.approveRoute"
)(function* (
  session: TailscaleSession,
  deployment: TailscaleControlPlaneDeployment
) {
  const result = yield* requestTailscaleJson(
    `${tailscaleApiBaseUrl}/tailnet/-/devices?fields=all`,
    session.accessToken,
    TailscaleDevicesSchema
  )
  const device = findTailscaleDevice(result.devices, deployment)
  if (!device) {
    return yield* TailscaleRoutePendingError.make({
      message: `Waiting for ${deployment.hostname} to appear in the Tailnet`,
    })
  }
  const routes = yield* requestTailscaleJson(
    `${tailscaleApiBaseUrl}/device/${encodeURIComponent(device.id)}/routes`,
    session.accessToken,
    TailscaleDeviceRoutesSchema
  )
  if (!routes.advertisedRoutes?.includes(deployment.subnet)) {
    return yield* TailscaleRoutePendingError.make({
      message: `Waiting for ${deployment.hostname} to advertise ${deployment.subnet}`,
    })
  }
  const otherDevices = result.devices.filter(
    (candidate) => candidate.id !== device.id
  )
  const conflicts = yield* Effect.forEach(
    otherDevices,
    (candidate) =>
      requestTailscaleJson(
        `${tailscaleApiBaseUrl}/device/${encodeURIComponent(candidate.id)}/routes`,
        session.accessToken,
        TailscaleDeviceRoutesSchema
      ).pipe(
        Effect.map((candidateRoutes) =>
          candidateRoutes.advertisedRoutes?.includes(deployment.subnet)
            ? candidate
            : null
        )
      ),
    { concurrency: 4 }
  )
  const conflict = conflicts.find((candidate) => candidate !== null)
  if (conflict) {
    return yield* tailscaleFailure(
      `${deployment.subnet} is already advertised by ${conflict.hostname ?? conflict.name ?? conflict.id}`
    )
  }
  if (routes.enabledRoutes?.includes(deployment.subnet)) return
  yield* requestTailscaleJson(
    `${tailscaleApiBaseUrl}/device/${encodeURIComponent(device.id)}/routes`,
    session.accessToken,
    TailscaleDeviceRoutesSchema,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routes: [
          ...new Set([...(routes.enabledRoutes ?? []), deployment.subnet]),
        ],
      }),
    }
  )
})

function requestTailscaleJson<TValue>(
  url: string,
  accessToken: string | null,
  schema: Schema.Decoder<TValue>,
  init?: RequestInit
): Effect.Effect<TValue, ExternalServiceError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...init?.headers,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        throw new Error(`Tailscale returned HTTP ${response.status}`)
      }
      return Schema.decodeUnknownSync(schema)(await response.json())
    },
    catch: (cause) =>
      ExternalServiceError.make({
        cause,
        message:
          cause instanceof Error
            ? cause.message
            : "Tailscale returned an invalid response",
        service: "Tailscale",
      }),
  })
}

function requestTailscaleVoid(
  url: string,
  accessToken: string,
  init: RequestInit
): Effect.Effect<void, ExternalServiceError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...init.headers,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok && response.status !== 404) {
        throw new Error(`Tailscale returned HTTP ${response.status}`)
      }
    },
    catch: (cause) =>
      ExternalServiceError.make({
        cause,
        message:
          cause instanceof Error
            ? cause.message
            : "Tailscale returned an invalid response",
        service: "Tailscale",
      }),
  })
}

function tailscaleFailure(message: string) {
  return ExternalServiceError.make({
    message,
    service: "Tailscale",
  })
}
