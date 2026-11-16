import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { showToast } from "@workspace/ui/components/sonner"

import type { IdentityStatusPresentation } from "@/components/identity-name"
import { recoverPromise } from "@/effect/promise"
import type { AccessPermission } from "@/lib/permissions"
import {
  queryKeys,
  tunnelsQueryOptions,
  tunnelBricksQueryOptions,
} from "@/lib/query-options"
import {
  addTunnelAlias,
  connectToTunnel,
  removeTunnelAlias,
  saveTunnel,
  setPrimaryTunnelName,
  type GatewayOverview,
  type TunnelMemberName,
  type TunnelOverview,
  type TunnelsResult,
} from "@/server/tunnels"

// What every tunnel page reads and changes: the tunnels the viewer sees
// (`getTunnels`), one of them, its gateways' states, and the changes made to
// it. A tunnel is one instance whose gateways, one on each Relay something
// it connects is on, follow what connects.

export type { GatewayOverview, TunnelMemberName, TunnelOverview, TunnelsResult }

export type TunnelBinding = TunnelOverview["bindings"][number]
type SaveTunnelInput = Parameters<typeof saveTunnel>[0]["data"]

const noTunnels: TunnelsResult = { tunnels: [], unavailableRelays: [] }
const noPermissions: ReadonlyArray<AccessPermission> = []

export function useTunnels() {
  const query = useQuery(tunnelsQueryOptions())
  return { ...query, data: query.data ?? noTunnels }
}

export function selectTunnel(
  result: TunnelsResult,
  tunnelId: string | undefined
): TunnelOverview | null {
  return result.tunnels.find(({ id }) => id === tunnelId) ?? null
}

export function useTunnel(tunnelId: string | undefined) {
  const select = React.useCallback(
    (result: TunnelsResult) => selectTunnel(result, tunnelId),
    [tunnelId]
  )
  return useQuery({ ...tunnelsQueryOptions(), select })
}

/** What the viewer may do on one of its gateways. */
export function gatewayPermissionsOf(
  tunnel: Pick<TunnelOverview, "access">,
  gatewayId: string
): ReadonlyArray<AccessPermission> {
  return tunnel.access.gateways[gatewayId] ?? noPermissions
}

/**
 * What the viewer may do with the tunnel, for its pages: whoever manages it
 * reads it whole, and anyone else what a gateway they reach lets them.
 */
export function tunnelPermissionsOf(
  tunnel: Pick<TunnelOverview, "access">
): ReadonlyArray<AccessPermission> {
  const held = new Set<AccessPermission>(
    Object.values(tunnel.access.gateways).flat()
  )
  if (tunnel.access.manage) held.add("instance.read")
  return [...held].sort()
}

/** One gateway's state, from both its containers. */
export function gatewayStatus(
  gateway: Pick<GatewayOverview, "components" | "observedState" | "status">
): IdentityStatusPresentation {
  switch (gateway.observedState) {
    case "stopped":
      return { label: "Stopped", tone: "neutral" }
    case "stopping":
      return { label: "Stopping", pulse: true, tone: "warning" }
    case "starting":
    case "provisioning":
      return { label: "Starting", pulse: true, tone: "info" }
    case "failed":
      return {
        detail: gateway.status.message ?? undefined,
        label: "Failed",
        tone: "danger",
      }
    case "running":
      break
  }
  if (
    gateway.status.connected &&
    gateway.components.coreDnsRunning &&
    gateway.components.tailscaleRunning
  ) {
    return { label: "Connected", tone: "success" }
  }
  if (gateway.status.message) {
    return {
      detail: gateway.status.message,
      label: "Needs attention",
      tone: "danger",
    }
  }
  return { label: "Connecting", pulse: true, tone: "warning" }
}

const statusRank: Record<IdentityStatusPresentation["tone"], number> = {
  danger: 0,
  warning: 1,
  info: 2,
  neutral: 3,
  success: 4,
}

/**
 * The tunnel's state across its gateways: the worst of theirs, or what it
 * is without one. A tunnel being deleted says so.
 */
export function tunnelStatus(
  tunnel: Pick<TunnelOverview, "cleanup" | "gateways">
): IdentityStatusPresentation {
  if (tunnel.cleanup) {
    return { label: "Deleting", pulse: true, tone: "warning" }
  }
  if (tunnel.gateways.length === 0) {
    return { label: "No gateways", tone: "neutral" }
  }
  const statuses = tunnel.gateways.map(gatewayStatus)
  const worst = statuses.reduce((left, right) =>
    statusRank[right.tone] < statusRank[left.tone] ? right : left
  )
  const failing = statuses.filter(({ tone }) => tone === worst.tone).length
  return statuses.length > 1 && worst.tone !== "success"
    ? {
        ...worst,
        label: `${worst.label} · ${failing} of ${statuses.length}`,
      }
    : worst
}

/**
 * One of a gateway's containers as the tunnel's Logs page names it:
 * `<gateway>:tailscale` or `<gateway>:coredns`.
 */
export function gatewayStream(
  gatewayId: string,
  container: "coredns" | "tailscale"
): string {
  return `${gatewayId}:${container}`
}

/** What a member's generated name and aliases are, whole. */
export function namesOf(
  tunnel: Pick<TunnelOverview, "names">,
  memberId: string
): ReadonlyArray<TunnelMemberName> {
  return tunnel.names.filter((name) => name.memberId === memberId)
}

export function wholeName(name: Pick<TunnelMemberName, "domain" | "label">) {
  return `${name.label}.${name.domain}`
}

/** A change to a tunnel's settings, sent with everything it keeps. */
export interface TunnelChange {
  domains?: ReadonlyArray<string>
  name?: string
  /** A member's generated name, renamed. */
  rename?: { label: string; memberId: string }
}

export function tunnelSaveInput(
  tunnel: TunnelOverview,
  change: TunnelChange = {}
): SaveTunnelInput {
  return {
    bindings: tunnel.bindings.map(({ enabled, memberId, relayId }) => ({
      enabled,
      ...(change.rename?.memberId === memberId
        ? { label: change.rename.label }
        : {}),
      memberId,
      relayId,
    })),
    domains: [...(change.domains ?? tunnel.domains)],
    id: tunnel.id,
    name: change.name ?? tunnel.name,
  }
}

/**
 * Where Kiln's Tailscale tunnel Brick comes from, which a tunnel added here
 * is made from, or undefined until the catalog is read.
 */
export function useTailscaleTunnelBrick(): string | undefined {
  return useQuery({
    ...tunnelBricksQueryOptions(),
    select: selectTailscaleBrick,
  }).data
}

function selectTailscaleBrick(
  bricks: ReadonlyArray<{ source: string; type?: string | undefined }>
): string | undefined {
  return bricks.find((brick) => brick.type === "tailscale")?.source
}

export function useSetTunnels() {
  const queryClient = useQueryClient()
  return React.useCallback(
    (next: TunnelsResult) => {
      queryClient.setQueryData(queryKeys.tunnels, next)
      void queryClient.invalidateQueries({ queryKey: queryKeys.relay.snapshot })
    },
    [queryClient]
  )
}

/**
 * Saves a tunnel's settings: its name, its TLDs, or a generated name. Its
 * gateways apply it one Relay at a time, which takes a while, so a toast
 * follows it.
 */
export function useTunnelSave() {
  const queryClient = useQueryClient()
  const setTunnels = useSetTunnels()
  return useMutation({
    mutationFn: ({
      change,
      tunnel,
    }: {
      change: TunnelChange
      /** What the toast says is happening, then what happened. */
      doing: string
      done: string
      tunnel: TunnelOverview
    }) => saveTunnel({ data: tunnelSaveInput(tunnel, change) }),
    onMutate: ({ doing, tunnel }) => {
      showToast({
        description: doing,
        duration: Infinity,
        id: toastId(tunnel.id),
        message: tunnel.name,
        type: "loading",
      })
    },
    onSuccess: (next, { done, tunnel }) => {
      setTunnels(next)
      showToast({
        description: done,
        duration: 5_000,
        id: toastId(tunnel.id),
        message: tunnel.name,
        type: "success",
      })
    },
    onError: (cause, { tunnel }) => {
      showToast({
        description: errorMessage(cause),
        duration: 8_000,
        id: toastId(tunnel.id),
        message: `${tunnel.name} wasn't changed`,
        type: "error",
      })
      void queryClient.invalidateQueries({ queryKey: queryKeys.tunnels })
    },
  })
}

/** Something a tunnel connects, or could. */
export interface TunnelMemberRef {
  memberId: string
  name: string
  relayId: string
  relayName: string
}

/**
 * Connects something to a tunnel, or disconnects it. The first thing on a
 * Relay makes the tunnel's gateway there, which waits on Tailscale, so the
 * toast says so; the last to leave takes it away. A request dropped on the
 * way back is checked against the tunnel as it is now before it's called a
 * failure.
 */
export function useTunnelConnection() {
  const queryClient = useQueryClient()
  const setTunnels = useSetTunnels()
  return useMutation({
    mutationFn: async ({
      connected,
      member,
      tunnel,
    }: {
      connected: boolean
      member: TunnelMemberRef
      tunnel: TunnelOverview
    }) => {
      const outcome = await recoverPromise(
        async () => ({
          result: await connectToTunnel({
            data: {
              connected,
              memberId: member.memberId,
              relayId: member.relayId,
              tunnelId: tunnel.id,
            },
          }),
        }),
        (cause) => ({ cause })
      )
      if ("result" in outcome) return outcome.result
      const now = await queryClient.fetchQuery({
        ...tunnelsQueryOptions(),
        staleTime: 0,
      })
      const bound = selectTunnel(now, tunnel.id)?.bindings.some(
        (binding) =>
          binding.memberId === member.memberId &&
          binding.relayId === member.relayId
      )
      if (bound === connected) return now
      throw outcome.cause
    },
    onMutate: ({ connected, member, tunnel }) => {
      const gateway = tunnel.gateways.some(
        ({ relayId }) => relayId === member.relayId
      )
      showToast({
        description: !connected
          ? `Disconnecting ${member.name}`
          : gateway
            ? `Connecting ${member.name}`
            : `Adding a gateway on ${member.relayName}, then connecting ${member.name}. Tailscale takes a moment to log it in.`,
        duration: Infinity,
        id: toastId(tunnel.id),
        message: tunnel.name,
        type: "loading",
      })
    },
    onSuccess: (next, { connected, member, tunnel }) => {
      setTunnels(next)
      showToast({
        description: connected
          ? `${member.name} is connected`
          : `${member.name} is disconnected`,
        duration: 5_000,
        id: toastId(tunnel.id),
        message: tunnel.name,
        type: "success",
      })
    },
    onError: (cause, { connected, member, tunnel }) => {
      showToast({
        description: errorMessage(cause),
        duration: 10_000,
        id: toastId(tunnel.id),
        message: connected
          ? `${member.name} wasn't connected`
          : `${member.name} wasn't disconnected`,
        type: "error",
      })
      void queryClient.invalidateQueries({ queryKey: queryKeys.tunnels })
    },
  })
}

/** Gives a member another name, or takes one of its aliases away. */
export function useTunnelAliases() {
  const setTunnels = useSetTunnels()
  const onError = (cause: Error) =>
    showToast({
      description: cause.message,
      message: "The name wasn't changed",
      type: "error",
    })
  const add = useMutation({
    mutationFn: (input: {
      domain: string
      label: string
      memberId: string
      tunnelId: string
    }) => addTunnelAlias({ data: input }),
    onSuccess: (next, input) => {
      setTunnels(next)
      showToast({
        message: `${input.label}.${input.domain} added`,
        type: "success",
      })
    },
    onError,
  })
  const remove = useMutation({
    mutationFn: (name: TunnelMemberName) =>
      removeTunnelAlias({ data: { id: name.id } }),
    onSuccess: (next, name) => {
      setTunnels(next)
      showToast({ message: `${wholeName(name)} removed`, type: "success" })
    },
    onError,
  })
  return { add, remove }
}

/**
 * Makes a name its game server's or App's primary address, in place of its
 * join address or domain. What shows that address reads it again.
 */
export function useMakeTunnelNamePrimary() {
  const setTunnels = useSetTunnels()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: TunnelMemberName) =>
      setPrimaryTunnelName({ data: { id: name.id } }),
    onSuccess: (next, name) => {
      setTunnels(next)
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.directory })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.servers.directory,
      })
      void queryClient.invalidateQueries({ queryKey: ["web-routes"] })
      showToast({
        message: `${wholeName(name)} is its primary address`,
        type: "success",
      })
    },
    onError: (cause: Error) =>
      showToast({
        description: cause.message,
        message: "The primary address wasn't changed",
        type: "error",
      }),
  })
}

const toastId = (tunnelId: string) => `kiln-tunnel-${tunnelId}`

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The tunnel wasn't changed."
}

/** A TLD as typed, without dots around it. */
export function normalizeTld(value: string): string {
  return value
    .trim()
    .replace(/^[.]+|[.]+$/gu, "")
    .toLowerCase()
}

/** One of an instance's names in a tunnel, as its Domains table lists it. */
export interface InstanceTunnelName {
  hostname: string
  name: TunnelMemberName
  tunnelId: string
  tunnelName: string
}

/**
 * An instance's names in every tunnel it's connected to, its generated ones
 * first, for the members `isMember` says are its own.
 */
export function useInstanceTunnelNames(
  isMember: (memberId: string) => boolean
): ReadonlyArray<InstanceTunnelName> {
  const { data } = useTunnels()
  return React.useMemo(
    () =>
      data.tunnels.flatMap((tunnel) =>
        tunnel.names
          .filter((name) => isMember(name.memberId))
          .map((name) => ({
            hostname: wholeName(name),
            name,
            tunnelId: tunnel.id,
            tunnelName: tunnel.name,
          }))
      ),
    [data.tunnels, isMember]
  )
}
