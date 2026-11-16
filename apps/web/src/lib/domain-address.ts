/** What a game server's address needs to say how players join it. */
interface GameAddress {
  hostname: string
  publicPort: number | null
  srvRecordId: string | null
  status: string
  supportsSrv: boolean
}

export interface ManagedDomainEndpoint {
  publicHost: string
  publicPort: number
}

export function domainHasActiveSrvRecord(assignment: GameAddress): boolean {
  return (
    assignment.supportsSrv &&
    assignment.status === "active" &&
    Boolean(assignment.srvRecordId)
  )
}

export function managedDomainConnectAddress(assignment: GameAddress): string {
  return domainHasActiveSrvRecord(assignment)
    ? assignment.hostname
    : hostPortAddress(assignment.hostname, assignment.publicPort ?? 0)
}

export function managedDomainEndpointMatches(
  assignment: ManagedDomainEndpoint,
  endpoint: {
    publicHost?: string
    publicPort?: number
  }
): boolean {
  return (
    assignment.publicHost === endpoint.publicHost &&
    assignment.publicPort === endpoint.publicPort
  )
}

export function hostPortAddress(hostname: string, port: number): string {
  const host =
    hostname.includes(":") && !hostname.startsWith("[")
      ? `[${hostname}]`
      : hostname
  return `${host}:${port}`
}
