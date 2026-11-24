/** Where Kiln stands on its recovery code, for its platform administrators. */
export interface RecoveryCodeStatus {
  /**
   * Whether the Relay hosting Kiln has it. Null once saved, since nothing
   * then asks the Relay.
   */
  readonly available: boolean | null
  /**
   * Whether showing it asks the person asking for a two-factor code: every
   * time but the first, and a short while after for whoever saw it first.
   */
  readonly needsTwoFactor: boolean
  /**
   * The newest platform backup that restores Kiln with the code alone and
   * is kept away from this machine, or null when there's none yet.
   */
  readonly recoverableBackup: { readonly at: number } | null
  readonly saved: { readonly at: number; readonly by: string | null } | null
  /** Whether the person asking has two-factor authentication on. */
  readonly twoFactorEnabled: boolean
}

/** What a reveal hands the browser, for as long as its dialog is open. */
export interface RecoveryCodeReveal {
  /** The code, `kiln-rk-…`. */
  readonly code: string
  readonly installationId: string
}

/** What the code is for, wherever Kiln asks for it to be saved. */
export const recoveryCodePurpose =
  "Kiln encrypts its backups with this code. Without it, you can't restore Kiln on a new machine."

export const recoveryDocsUrl =
  "https://github.com/kiln-site/kiln/blob/main/docs/self-hosting.md#recovery"

/**
 * The text file the code downloads as, named for the address Hearth is
 * open at: a restore gives Kiln a new installation ID, but the code stays.
 */
export function recoveryCodeFile(
  reveal: RecoveryCodeReveal,
  host: string
): {
  readonly content: string
  readonly name: string
} {
  return {
    content: [
      "Kiln recovery code",
      "",
      reveal.code,
      "",
      recoveryCodePurpose,
      "Keep it somewhere safe, apart from your backups.",
      "",
      `Restoring: ${recoveryDocsUrl}`,
      "",
    ].join("\n"),
    name: `kiln-recovery-code-${host.replace(/[^\w.-]+/gu, "-")}.txt`,
  }
}
