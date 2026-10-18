import { Schema } from "effect"

// The ID shared by Hearth, its database, and its Relays. Docker labels,
// backup object keys, and platform backup manifests carry it, so Hearth and
// every Relay accept exactly the same values. It is also the platform backup
// target ID, so it fits that 120-character limit (`backupTargetSchema`).
export const KilnInstallationIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/u)
)

export const isKilnInstallationId = Schema.is(KilnInstallationIdSchema)
