import {
  appTailscaleMember,
  builtinTailscaleBrickId,
  databaseTailscaleMember,
  instanceTailscaleMember,
} from "@workspace/contracts"

/** What Hearth knows of a Relay's resources, to check a network's members. */
export interface TailscaleMemberRecords {
  readonly apps: ReadonlyArray<{ appId: string; relayId: string }>
  readonly databases: ReadonlyArray<{ databaseId: string; relayId: string }>
  /** The game servers the binding's Relay reports. */
  readonly instances: ReadonlyArray<{
    brickId?: string
    id: string
    managedByRelay: boolean
  }>
}

/**
 * Why a binding can't join a Tailscale network, or null when it can: its
 * member must be a game server, an App, or a database on the Relay the
 * binding names, and not a Tailscale deployment itself.
 */
export function tailscaleMemberProblem(
  binding: { readonly memberId: string; readonly relayId: string },
  records: TailscaleMemberRecords
): string | null {
  const app = appTailscaleMember(binding.memberId)
  if (app) {
    return records.apps.some(
      (record) =>
        record.appId === app.appId && record.relayId === binding.relayId
    )
      ? null
      : `App ${app.appId.slice(0, 8)} is unavailable`
  }
  const databaseId = databaseTailscaleMember(binding.memberId)
  if (databaseId) {
    return records.databases.some(
      (record) =>
        record.databaseId === databaseId && record.relayId === binding.relayId
    )
      ? null
      : `Database ${databaseId.slice(0, 8)} is unavailable`
  }
  const instanceId = instanceTailscaleMember(binding.memberId)
  const instance = records.instances.find(
    (candidate) => candidate.id === instanceId
  )
  if (!instanceId || !instance || !instance.managedByRelay) {
    return `Game server ${binding.memberId} is unavailable`
  }
  if (instance.brickId === builtinTailscaleBrickId) {
    return "A Tailscale deployment cannot attach to itself"
  }
  return null
}
