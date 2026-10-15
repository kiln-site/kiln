import { showToast } from "@workspace/ui/components/sonner"

export type TailscaleOperation = "connect" | "disconnect" | "install" | "update"

interface TailscaleOperationToast {
  id: string
  networkName: string
  nodeCount?: number
  operation: TailscaleOperation
}

export function tailscaleOperationToastId(networkId: string): string {
  return `kiln-tailscale-${networkId}`
}

export function showTailscaleOperationProgress({
  id,
  networkName,
  nodeCount = 1,
  operation,
}: TailscaleOperationToast): void {
  const content = progressContent(operation, networkName, nodeCount)
  showToast({
    type: "loading",
    id,
    message: content.message,
    description: content.description,
    duration: Infinity,
  })
}

export function showTailscaleOperationSuccess({
  id,
  networkName,
  nodeCount = 1,
  operation,
}: TailscaleOperationToast): void {
  const content = successContent(operation, networkName, nodeCount)
  showToast({
    type: "success",
    id,
    message: content.message,
    description: content.description,
    duration: 5_000,
  })
}

export function showTailscaleOperationError(
  toast: TailscaleOperationToast,
  cause: unknown
): void {
  showToast({
    type: "error",
    id: toast.id,
    message:
      toast.operation === "disconnect"
        ? "Could not disconnect game server"
        : "Could not connect Tailscale",
    description:
      cause instanceof Error
        ? cause.message
        : `${toast.networkName} could not be updated.`,
    duration: 8_000,
  })
}

function progressContent(
  operation: TailscaleOperation,
  networkName: string,
  nodeCount: number
) {
  switch (operation) {
    case "install":
      return {
        message: "Installing Tailscale…",
        description: `Preparing Tailscale and CoreDNS on ${nodeLabel(nodeCount)}…`,
      }
    case "connect":
      return {
        message: "Connecting game server…",
        description: `Adding the game server to ${networkName}.`,
      }
    case "disconnect":
      return {
        message: "Disconnecting game server…",
        description: `Removing the game server from ${networkName}.`,
      }
    case "update":
      return {
        message: "Updating Tailscale…",
        description: `Applying changes to ${networkName}.`,
      }
  }
}

function successContent(
  operation: TailscaleOperation,
  networkName: string,
  nodeCount: number
) {
  switch (operation) {
    case "install":
      return {
        message: "Tailscale connected",
        description: `Tailscale and CoreDNS are connected to ${networkName} on ${nodeLabel(nodeCount)}.`,
      }
    case "connect":
      return {
        message: "Game server connected",
        description: `The game server can now be reached through ${networkName}.`,
      }
    case "disconnect":
      return {
        message: "Game server disconnected",
        description: `The game server is no longer reachable through ${networkName}.`,
      }
    case "update":
      return {
        message: "Tailscale updated",
        description: `${networkName} is up to date.`,
      }
  }
}

function nodeLabel(count: number): string {
  return `${count} ${count === 1 ? "node" : "nodes"}`
}
