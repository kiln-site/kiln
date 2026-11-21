import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowRightLeft, Copy, LoaderCircle } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import { InfoSection } from "@/components/info-page"
import {
  ResourceMigrationDialog,
  type MigratedResource,
  type ResourceMigrationMode,
} from "@/components/resource-migration-dialog"
import { ensuringPromise, recoverPromise } from "@/effect/promise"
import { resourceMigrationPreviewQueryOptions } from "@/lib/resource-migration-queries"

/**
 * The Move or duplicate section of an Info page, the same for every kind
 * that can be copied.
 */
export function ResourceMigrationSection({
  relayConnected,
  resource,
}: {
  relayConnected: boolean
  resource: MigratedResource
}) {
  return (
    <InfoSection
      icon={<ArrowRightLeft />}
      title="Move or duplicate"
      action={
        <ResourceMigrationButtons
          relayConnected={relayConnected}
          resource={resource}
        />
      }
    />
  )
}

/**
 * The two buttons that open the Move or duplicate dialog for one resource,
 * for wherever it is listed.
 */
export function ResourceMigrationButtons({
  relayConnected,
  resource,
  size = "sm",
}: {
  relayConnected: boolean
  resource: MigratedResource
  size?: "sm" | "xs"
}) {
  const [mode, setMode] = React.useState<ResourceMigrationMode | null>(null)
  const [opening, setOpening] = React.useState<ResourceMigrationMode | null>(
    null
  )
  const queryClient = useQueryClient()
  const previewOptions = resourceMigrationPreviewQueryOptions(resource)
  // Asked for as the pointer reaches a button, and waited for on click, so
  // the dialog opens whole rather than growing once it loads.
  const prefetch = () => {
    void queryClient.prefetchQuery(previewOptions)
  }
  const open = (next: ResourceMigrationMode) => {
    setOpening(next)
    // The dialog shows a failed preview itself.
    void ensuringPromise(
      () =>
        recoverPromise(
          () => queryClient.fetchQuery(previewOptions),
          () => undefined
        ),
      () => {
        setOpening(null)
        setMode(next)
      }
    )
  }
  const unavailable = relayConnected ? undefined : "Reconnect its Relay first"
  return (
    <>
      <Button
        variant="outline"
        size={size}
        disabled={!relayConnected || opening !== null}
        title={unavailable}
        onClick={() => open("duplicate")}
        onFocus={prefetch}
        onPointerEnter={prefetch}
      >
        {opening === "duplicate" ? (
          <LoaderCircle className="animate-spin" />
        ) : (
          <Copy />
        )}
        Duplicate
      </Button>
      <Button
        variant="outline"
        size={size}
        disabled={!relayConnected || opening !== null}
        title={unavailable}
        onClick={() => open("migrate")}
        onFocus={prefetch}
        onPointerEnter={prefetch}
      >
        {opening === "migrate" ? (
          <LoaderCircle className="animate-spin" />
        ) : (
          <ArrowRightLeft />
        )}
        Move to another Relay
      </Button>
      {mode ? (
        <ResourceMigrationDialog
          open
          initialMode={mode}
          resource={resource}
          onOpenChange={(open) => {
            if (!open) setMode(null)
          }}
        />
      ) : null}
    </>
  )
}
