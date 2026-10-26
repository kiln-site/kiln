import { Check, LoaderCircle, Share2, TriangleAlert } from "lucide-react"
import * as React from "react"

import { Button } from "@workspace/ui/components/button"

import type {
  ConsoleStreamStore,
  ConsoleUiStore,
} from "@/components/console/console-stores"
import { ConsoleTooltip } from "@/components/console/console-tooltip"
import { copyToClipboard } from "@/components/console/console-toolbar-actions"
import { useInstanceRelayConnected } from "@/components/instance-workspace-context"
import {
  mclogsShareLabel,
  mclogsShareTooltip,
  useMclogsShareAction,
} from "@/components/use-mclogs-share-action"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import { uploadConsoleLogToMclogs } from "@/server/relay"

// Kept apart from the other toolbar actions, which act only on the console's
// own stores, because sharing uploads through Hearth.
export function ConsoleShareButton({
  canShare,
  instance,
  streamStore,
  uiStore,
}: {
  canShare: boolean
  instance: InstanceWorkspaceInstance
  streamStore: ConsoleStreamStore
  uiStore: ConsoleUiStore
}) {
  const relayConnected = useInstanceRelayConnected()
  const hasLines = React.useSyncExternalStore(
    streamStore.subscribe,
    streamStore.getHasLinesSnapshot,
    streamStore.getHasLinesSnapshot
  )
  const { share, state, canOpen, onPointerLeave } = useMclogsShareAction(
    async () => {
      const result = await uploadConsoleLogToMclogs({
        data: {
          instanceId: instance.id,
          relayId: instance.relayId,
          implementation: instance.implementation,
          version: instance.version,
          redactSensitive: uiStore.getRedactSensitiveSnapshot(),
        },
      })
      await copyToClipboard(result.url)
      return result.url
    }
  )

  if (!canShare || !relayConnected) return null

  return (
    <ConsoleTooltip
      content={mclogsShareTooltip(state, canOpen)}
      keepOpen={canOpen}
    >
      <Button
        variant={
          state === "copied"
            ? "secondary"
            : state === "error"
              ? "destructive"
              : "ghost"
        }
        size="sm"
        className="type-control-sm h-8 gap-1.5 px-2.5"
        disabled={!hasLines}
        aria-disabled={state === "uploading"}
        aria-busy={state === "uploading"}
        aria-label={
          state === "copied" && canOpen
            ? "Link copied, press again to open on mclo.gs"
            : undefined
        }
        onClick={share}
        onPointerLeave={onPointerLeave}
      >
        {state === "uploading" ? (
          <LoaderCircle className="animate-spin" />
        ) : state === "copied" ? (
          <Check />
        ) : state === "error" ? (
          <TriangleAlert />
        ) : (
          <Share2 />
        )}
        {mclogsShareLabel(state)}
      </Button>
    </ConsoleTooltip>
  )
}
