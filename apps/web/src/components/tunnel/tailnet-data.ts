import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { showToast } from "@workspace/ui/components/sonner"

import type { IdentityStatusPresentation } from "@/components/identity-name"
import type { AccessPermission } from "@/lib/permissions"
import { queryKeys, tailnetsQueryOptions } from "@/lib/query-options"
import {
  addTunnelAlias,
  removeTunnelAlias,
  saveTailnet,
  type TailnetName,
  type TailnetOverview,
  type TailnetsResult,
  type TunnelOverview,
} from "@/server/tunnels"

// What every tunnel and tailnet page reads and changes: the tailnets the
// viewer sees (`getTailnets`), one tailnet or tunnel picked out of them, and
// a tailnet saved whole, each save sending everything it connects.

export type { TailnetName, TailnetOverview, TailnetsResult, TunnelOverview }

export type TailnetBinding = TailnetOverview["bindings"][number]
type SaveTailnetInput = Parameters<typeof saveTailnet>[0]["data"]

const noTailnets: TailnetsResult = { stacks: [], unavailableRelays: [] }
const noPermissions: ReadonlyArray<AccessPermission> = []

export function useTailnets() {
  const query = useQuery(tailnetsQueryOptions())
  return { ...query, data: query.data ?? noTailnets }
}

export function useTailnet(tailnetId: string | undefined) {
  const select = React.useCallback(
    (result: TailnetsResult) =>
      result.stacks.find((stack) => stack.id === tailnetId) ?? null,
    [tailnetId]
  )
  return useQuery({ ...tailnetsQueryOptions(), select })
}

/** A tunnel, its tailnet, and what the viewer may do with it. */
export interface TunnelView {
  permissions: ReadonlyArray<AccessPermission>
  tailnet: TailnetOverview
  tunnel: TunnelOverview
}

export function selectTunnel(
  result: TailnetsResult,
  tunnelId: string | undefined
): TunnelView | null {
  for (const tailnet of result.stacks) {
    const tunnel = tailnet.deployments.find(({ id }) => id === tunnelId)
    if (tunnel) {
      return {
        permissions: tailnet.access.tunnels[tunnel.id] ?? noPermissions,
        tailnet,
        tunnel,
      }
    }
  }
  return null
}

export function useTunnel(tunnelId: string | undefined) {
  const select = React.useCallback(
    (result: TailnetsResult) => selectTunnel(result, tunnelId),
    [tunnelId]
  )
  return useQuery({ ...tailnetsQueryOptions(), select })
}

/** A tunnel's state as its pages show it, from both its containers. */
export function tunnelStatus(
  tunnel: Pick<TunnelOverview, "components" | "observedState" | "status">
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
  tailnet: Pick<TailnetOverview, "names">,
  memberId: string
): ReadonlyArray<TailnetName> {
  return tailnet.names.filter((name) => name.memberId === memberId)
}

export function wholeName(name: Pick<TailnetName, "domain" | "label">) {
  return `${name.label}.${name.domain}`
}

/** A change to a tailnet, sent with everything it keeps. */
export interface TailnetChange {
  authKey?: string
  /** What it connects; each keeps its name. */
  bindings?: ReadonlyArray<
    Pick<TailnetBinding, "enabled" | "memberId" | "relayId">
  >
  domains?: ReadonlyArray<string>
  name?: string
  relayIds?: ReadonlyArray<string>
  /** A member's generated name, renamed. */
  rename?: { label: string; memberId: string }
}

export function tailnetSaveInput(
  tailnet: TailnetOverview,
  change: TailnetChange = {}
): SaveTailnetInput {
  return {
    ...(change.authKey ? { authKey: change.authKey } : {}),
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
    relayIds: [
      ...(change.relayIds ?? tailnet.deployments.map(({ relayId }) => relayId)),
    ],
  }
}

export function useSetTailnets() {
  const queryClient = useQueryClient()
  return React.useCallback(
    (next: TailnetsResult) => {
      queryClient.setQueryData(queryKeys.tailnets, next)
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
      tailnet: TailnetOverview
    }) => saveTailnet({ data: tailnetSaveInput(tailnet, change) }),
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.tailnets })
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
      tailnetId: string
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
    mutationFn: (name: TailnetName) =>
      removeTunnelAlias({ data: { id: name.id } }),
    onSuccess: (next, name) => {
      setTailnets(next)
      showToast({ message: `${wholeName(name)} removed`, type: "success" })
    },
    onError,
  })
  return { add, remove }
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
