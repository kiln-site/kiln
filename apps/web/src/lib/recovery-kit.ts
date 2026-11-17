import type { RecoveryKey, RecoveryKit } from "@workspace/contracts"

/** Where Kiln stands on its recovery kit, for its platform administrators. */
export interface RecoveryKitStatus {
  /**
   * What the Relay hosting Kiln can hand out: a kit, a key, or nothing.
   * Null once saved, since nothing then asks the Relay.
   */
  readonly available: "kit" | "key" | "none" | null
  /** Whether it was ever shown; after that, every reveal asks for 2FA. */
  readonly firstRevealDone: boolean
  readonly saved: { readonly at: number; readonly by: string | null } | null
  /** Whether the person asking has two-factor authentication on. */
  readonly twoFactorEnabled: boolean
}

/** A file to download, as `kiln-relay platform` reads it back. */
export interface RecoveryKitFile {
  readonly content: string
  readonly name: string
  readonly type: string
}

/** What a reveal hands the browser, for as long as its dialog is open. */
export interface RecoveryKitReveal {
  readonly file: RecoveryKitFile
  readonly installationId: string
  readonly kind: "kit" | "key"
  /** The `kiln-recovery:v1:` line. */
  readonly text: string
}

/** The file a kit or key downloads as. */
export function recoveryKitFile(
  document: RecoveryKit | RecoveryKey,
  text: string
): RecoveryKitFile {
  const installationId =
    document.kind === "kiln-platform-recovery-kit"
      ? document.state.installationId
      : document.installationId
  if (document.kind === "kiln-platform-recovery-kit") {
    return {
      // As `kiln-relay platform export-kit` prints it, for `import-kit`.
      content: `${JSON.stringify(document, null, 2)}\n`,
      name: `kiln-recovery-kit-${installationId}.json`,
      type: "application/json",
    }
  }
  return {
    content: [
      "Kiln recovery key",
      "",
      "Keep this offline, apart from your backups. Anyone holding it can read",
      "Kiln's platform backups.",
      "",
      "This Kiln takes its other secrets from your own environment file; keep",
      "that too. To restore, set these with the rest of it, start Kiln, then",
      "restore the platform backup.",
      "",
      `KILN_INSTALLATION_ID=${document.installationId}`,
      `KILN_PLATFORM_BACKUP_KEY=${document.platformBackupKey}`,
      "",
      text,
      "",
    ].join("\n"),
    name: `kiln-recovery-key-${installationId}.txt`,
    type: "text/plain",
  }
}

export const recoveryDocsUrl =
  "https://github.com/kiln-site/kiln/blob/main/docs/self-hosting.md#recovery"
