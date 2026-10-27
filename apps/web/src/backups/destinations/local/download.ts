import { randomUUID, sign } from "node:crypto"

import { Effect } from "effect"

import { backupDownloadCapabilityPayloadSchema } from "@workspace/contracts"

import type { BackupCatalogRecord } from "@/effect/backups"
import type { PersistedRelay } from "@/lib/relay-registry"

export async function signLocalBackupDownload(
  relay: PersistedRelay,
  backup: Pick<BackupCatalogRecord, "id"> &
    Partial<Pick<BackupCatalogRecord, "linkedFrom">>,
  filename: string,
  subject: string,
  expiresInSeconds: number
) {
  if (relay.role === "custom" && !relay.actions.includes("backup.download")) {
    throw new Error("This Hearth client cannot download Relay backups")
  }
  const { loadRelayCredentials } = await import("@/lib/relay-registry")
  const credentials = await loadRelayCredentials(relay.id)
  // A linked backup's archive is kept under the backup it was made as.
  const archiveId = backup.linkedFrom?.backupId ?? backup.id
  const now = Date.now()
  const expiresAt = now + expiresInSeconds * 1_000
  const payload = backupDownloadCapabilityPayloadSchema.parse({
    action: "backup.download",
    audience: relay.id,
    backupId: archiveId,
    capabilityId: randomUUID(),
    expiresAt,
    filename,
    issuedAt: now,
    issuer: credentials.clientId,
    subject,
    version: 1,
  })
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = sign(
    null,
    Buffer.from(encoded),
    credentials.clientPrivateKeyPem
  ).toString("base64url")
  // A Relay browsers can't reach serves its backups through Hearth. So does
  // one Hearth hasn't heard from yet, as while it reconnects: Hearth reaches
  // any Relay it can serve the link from.
  const { relayConnectionProxyMode } = await import("@/lib/relay-connection")
  const { kilnPublicUrl } = await import("@/lib/environment")
  const mode = relayConnectionProxyMode(relay.id)
  const url =
    mode === "hearth" || mode === null
      ? new URL(
          `/api/relays/${encodeURIComponent(relay.id)}/browser/backups/${encodeURIComponent(archiveId)}`,
          kilnPublicUrl()
        )
      : new URL(
          `/v1/browser/backups/${encodeURIComponent(archiveId)}`,
          relay.browserOrigin
        )
  url.searchParams.set("token", `${encoded}.${signature}`)
  return { expiresAt: new Date(expiresAt).toISOString(), url: url.toString() }
}

export function prepareLocalBackupDownload(input: {
  backup: Pick<BackupCatalogRecord, "id">
  expiresInSeconds: number
  filename: string
  objectKey: string | null
  relay: PersistedRelay
  subject: string
}) {
  if (input.objectKey !== null) {
    return Effect.fail(new Error("Local backup metadata is invalid"))
  }
  return Effect.tryPromise({
    try: () =>
      signLocalBackupDownload(
        input.relay,
        input.backup,
        input.filename,
        input.subject,
        input.expiresInSeconds
      ),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((download) => ({ download, sourceName: input.relay.name }))
  )
}
