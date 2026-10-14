import { reportAppError } from "@/effect/runtime"

type RelayCleanupFailure = "backups" | "domains"

interface RelayRemovalOperations {
  deleteRelay: () => Promise<void>
  forgetBackups: () => Promise<number>
  removeManagedDomains: () => Promise<number>
}

export async function removeRelayThenCleanup(
  input: {
    forgetBackups: boolean
    relayId: string
    removeVanityDomains: boolean
  },
  operations: RelayRemovalOperations
) {
  await operations.deleteRelay()

  const [domains, backups] = await Promise.allSettled([
    Promise.resolve().then(operations.removeManagedDomains),
    input.forgetBackups
      ? Promise.resolve().then(operations.forgetBackups)
      : Promise.resolve(0),
  ])
  const cleanupFailures: Array<RelayCleanupFailure> = []
  if (domains.status === "rejected") {
    cleanupFailures.push("domains")
    reportRelayCleanupFailure(
      "domains.relay.removeAssignments",
      input.relayId,
      domains.reason
    )
  }
  if (backups.status === "rejected") {
    cleanupFailures.push("backups")
    reportRelayCleanupFailure(
      "backups.forgetRelay",
      input.relayId,
      backups.reason
    )
  }

  return {
    cleanupFailures,
    forgottenBackups: backups.status === "fulfilled" ? backups.value : 0,
    removed: true as const,
    removedVanityDomains:
      input.removeVanityDomains && domains.status === "fulfilled"
        ? domains.value
        : 0,
  }
}

function reportRelayCleanupFailure(
  operation: string,
  relayId: string,
  error: unknown
) {
  reportAppError(error, { operation, attributes: { "kiln.relay_id": relayId } })
}
