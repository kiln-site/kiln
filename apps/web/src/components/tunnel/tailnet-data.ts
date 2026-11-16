import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { showToast } from "@workspace/ui/components/sonner"

import type { IdentityStatusPresentation } from "@/components/identity-name"
import type { AccessPermission } from "@/lib/permissions"
import {
  queryKeys,
  tunnelsQueryOptions,
  tunnelBricksQueryOptions,
} from "@/lib/query-options"
import {
  addTunnelAlias,
  removeTunnelAlias,
  saveTunnel,
  setPrimaryTunnelName,
  type TunnelMemberName,
  type TunnelOverview,
  type TunnelsResult,
  type GatewayOverview,
} from "@/server/tunnels"

// What every tunnel and tailnet page reads and changes: the tailnets the
// viewer sees (`getTunnels`), one tailnet or tunnel picked out of them, and
// a tailnet saved whole, each save sending everything it connects.

export type { TunnelMemberName, TunnelOverview, TunnelsResult, GatewayOverview }

export type TailnetBinding = TunnelOverview["bindings"][number]
type SaveTailnetInput = Parameters<typeof saveTunnel>[0]["data"]

const noTailnets: TunnelsResult = { tunnels: [], unavailableRelays: [] }
const noPermissions: ReadonlyArray<AccessPermission> = []

export function useTailnets() {
  const query = useQuery(tunnelsQueryOptions())
  return { ...query, data: query.data ?? noTailnets }
}

export function useTailnet(tailnetId: string | undefined) {
  const select = React.useCallback(
    (result: TunnelsResult) =>
      result.tunnels.find((stack) => stack.id === tailnetId) ?? null,
    [tailnetId]
  )
  return useQuery({ ...tunnelsQueryOptions(), select })
}

/** A tunnel, its tailnet, and what the viewer may do with it. */
export interface TunnelView {
  permissions: ReadonlyArray<AccessPermission>
  tailnet: TunnelOverview
  tunnel: GatewayOverview
}

export function selectTunnel(
  result: TunnelsResult,
  tunnelId: string | undefined
): TunnelView | null {
  for (const tailnet of result.tunnels) {
    const tunnel = tailnet.gateways.find(({ id }) => id === tunnelId)
    if (tunnel) {
      return {
        permissions: tailnet.access.gateways[tunnel.id] ?? noPermissions,
        tailnet,
        tunnel,
      }
    }
  }
  return null
}

export function useTunnel(tunnelId: string | undefined) {
  const select = React.useCallback(
    (result: TunnelsResult) => selectTunnel(result, tunnelId),
    [tunnelId]
  )
  return useQuery({ ...tunnelsQueryOptions(), select })
}

/** A tunnel's state as its pages show it, from both its containers. */
export function tunnelStatus(
  tunnel: Pick<GatewayOverview, "components" | "observedState" | "status">
): IdentityStatusPresentation {
  switch (tunnel.observedState) {
    case "stopped":
      return { label: "Stopped", tone: "neutral" }
    case "stopping":
      return { label: "Stopping", pulse: true, tone: "warning" }
    case "starting":
    case "provisioning":
      return { label: "Starting", pulse: true, tone: "info" }
    case "failed":
      return {
        detail: tunnel.status.message ?? undefined,
        label: "Failed",
        tone: "danger",
      }
    case "running":
      break
  }
  if (
    tunnel.status.connected &&
    tunnel.components.coreDnsRunning &&
    tunnel.components.tailscaleRunning
  ) {
    return { label: "Connected", tone: "success" }
  }
  if (tunnel.status.message) {
    return {
      detail: tunnel.status.message,
      label: "Needs attention",
      tone: "danger",
    }
  }
  return { label: "Connecting", pulse: true, tone: "warning" }
}

/** What a member's generated name and aliases are, whole. */
export function namesOf(
  tailnet: Pick<TunnelOverview, "names">,
  memberId: string
): ReadonlyArray<TunnelMemberName> {
  return tailnet.names.filter((name) => name.memberId === memberId)
}

export function wholeName(name: Pick<TunnelMemberName, "domain" | "label">) {
  return `${name.label}.${name.domain}`
}

/** A change to a tailnet, sent with everything it keeps. */
export interface TailnetChange {
  /** What it connects; each keeps its name. */
  bindings?: ReadonlyArray<
    Pick<TailnetBinding, "enabled" | "memberId" | "relayId">
  >
  domains?: ReadonlyArray<string>
  name?: string
  /** A member's generated name, renamed. */
  rename?: { label: string; memberId: string }
}

export function tailnetSaveInput(
  tailnet: TunnelOverview,
  change: TailnetChange = {}
): SaveTailnetInput {
  return {
    bindings: (change.bindings ?? tailnet.bindings).map(
      ({ enabled, memberId, relayId }) => ({
        enabled,
        ...(change.rename?.memberId === memberId
          ? { label: change.rename.label }
          : {}),
        memberId,
        relayId,
      })
    ),
    domains: [...(change.domains ?? tailnet.domains)],
    id: tailnet.id,
    name: change.name ?? tailnet.name,
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

export function useSetTailnets() {
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
 * Saves a tailnet whole. Its tunnels apply one Relay at a time, which takes a
 * while, so a toast follows it. One save at a time per tailnet: each sends
 * every member, and an older one landing last would undo a newer.
 */
export function useTailnetSave() {
  const queryClient = useQueryClient()
  const setTailnets = useSetTailnets()
  return useMutation({
    mutationFn: ({
      change,
      tailnet,
    }: {
      change: TailnetChange
      /** What the toast says is happening, then what happened. */
      doing: string
      done: string
      tailnet: TunnelOverview
    }) => saveTunnel({ data: tailnetSaveInput(tailnet, change) }),
    onMutate: ({ doing, tailnet }) => {
      showToast({
        description: doing,
        duration: Infinity,
        id: toastId(tailnet.id),
        message: tailnet.name,
        type: "loading",
      })
    },
    onSuccess: (next, { done, tailnet }) => {
      setTailnets(next)
      showToast({
        description: done,
        duration: 5_000,
        id: toastId(tailnet.id),
        message: tailnet.name,
        type: "success",
      })
    },
    onError: (cause, { tailnet }) => {
      showToast({
        description: errorMessage(cause),
        duration: 8_000,
        id: toastId(tailnet.id),
        message: `${tailnet.name} wasn't changed`,
        type: "error",
      })
      void queryClient.invalidateQueries({ queryKey: queryKeys.tunnels })
    },
  })
}

/** Gives a member another name, or takes one of its aliases away. */
export function useTailnetAliases() {
  const setTailnets = useSetTailnets()
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
      setTailnets(next)
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
      setTailnets(next)
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
  const setTailnets = useSetTailnets()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: TunnelMemberName) =>
      setPrimaryTunnelName({ data: { id: name.id } }),
    onSuccess: (next, name) => {
      setTailnets(next)
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

const toastId = (tailnetId: string) => `kiln-tailnet-${tailnetId}`

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The tailnet wasn't changed."
}

/** A TLD as typed, without dots around it. */
export function normalizeTld(value: string): string {
  return value
    .trim()
    .replace(/^[.]+|[.]+$/gu, "")
    .toLowerCase()
}
