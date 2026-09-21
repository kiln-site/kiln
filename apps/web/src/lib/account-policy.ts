/** Account eligibility is independent of permissions and Better Auth bans. */
export interface AccountPolicy {
  status?: "enabled" | "disabled"
  statusExpiresAt?: string | Date | null
  emailVerified?: boolean | number
  emailVerifiedAt?: string | Date | null
  manuallyVerifiedAt?: string | Date | null
  legacyVerificationRecordedAt?: string | Date | null
}

export function isAccountEnabled(
  user: AccountPolicy,
  now = Date.now()
): boolean {
  return (
    user.status !== "disabled" ||
    (user.statusExpiresAt != null &&
      new Date(user.statusExpiresAt).getTime() <= now)
  )
}

export function isAccountVerified(user: AccountPolicy): boolean {
  if (
    user.emailVerifiedAt ||
    user.manuallyVerifiedAt ||
    user.legacyVerificationRecordedAt
  )
    return true
  // Older in-memory integrations lack evidence fields. Persisted identities
  // always expose the three fields, including explicit null values.
  return (
    user.emailVerifiedAt === undefined &&
    user.manuallyVerifiedAt === undefined &&
    user.legacyVerificationRecordedAt === undefined &&
    user.emailVerified === true
  )
}

export function requireVerifiedAccount(user: AccountPolicy): void {
  if (!isAccountVerified(user)) throw new Error("Account verification required")
}

export function isEligibleAccount(user: AccountPolicy): boolean {
  return isAccountVerified(user) && isAccountEnabled(user)
}

export function requireEligibleAccount(user: AccountPolicy): void {
  requireVerifiedAccount(user)
  if (!isAccountEnabled(user)) throw new Error("Your account is disabled")
}

/** Normalizes the persisted status/evidence columns into an AccountPolicy. */
export function accountPolicyFromRow(
  row: {
    status: string | null
    statusExpiresAt: Date | string | null
    emailVerifiedAt: Date | string | null
    manuallyVerifiedAt: Date | string | null
    legacyVerificationRecordedAt: Date | string | null
  },
  now = Date.now()
): Required<
  Pick<
    AccountPolicy,
    | "status"
    | "statusExpiresAt"
    | "emailVerifiedAt"
    | "manuallyVerifiedAt"
    | "legacyVerificationRecordedAt"
  >
> {
  const iso = (value: Date | string | null) =>
    value ? new Date(value).toISOString() : null
  return {
    status:
      row.status === "disabled" &&
      (!row.statusExpiresAt || new Date(row.statusExpiresAt).getTime() > now)
        ? "disabled"
        : "enabled",
    statusExpiresAt: iso(row.statusExpiresAt),
    emailVerifiedAt: iso(row.emailVerifiedAt),
    manuallyVerifiedAt: iso(row.manuallyVerifiedAt),
    legacyVerificationRecordedAt: iso(row.legacyVerificationRecordedAt),
  }
}
