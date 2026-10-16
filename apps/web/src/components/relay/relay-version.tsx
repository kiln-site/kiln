import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { ExternalLink, TriangleAlert } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Popover, PopoverTrigger } from "@workspace/ui/components/popover"

import { InfoCopyValue, InfoDetailsContent } from "@/components/info-page"
import { useInfraUpdateDialogStore } from "@/components/infra-update-dialog-provider"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import {
  relayReleaseQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import type { RelayDirectoryEntry } from "@/lib/relay-route"

// The Relay's release by name, like "v0.1.0 Nightly #269", then its raw
// version to copy, and a warning when a newer release is out.
export function RelayVersion({ relay }: { relay: RelayDirectoryEntry }) {
  const { connected } = useRelayLiveStatus(relay)
  const select = React.useCallback(
    (snapshot: RelayFleetSnapshot) =>
      snapshot.nodes.find((node) => node.relayId === relay.id)?.version ?? null,
    [relay.id]
  )
  const { data: liveVersion = null } = useQuery({
    ...relaySnapshotQueryOptions(),
    select,
  })
  const version = liveVersion ?? relay.nodeVersion
  const { data: release } = useQuery({
    ...relayReleaseQueryOptions(relay.id, version ?? ""),
    enabled: connected && version !== null,
  })
  if (!version) return <span className="text-muted-foreground">Unknown</span>

  return (
    <>
      {release?.current ? (
        <span className="truncate">{release.current.name}</span>
      ) : null}
      <InfoCopyValue label="Relay version" value={version} />
      {release?.update ? (
        <RelayUpdateWarning
          relayId={relay.id}
          update={release.update}
          version={version}
        />
      ) : null}
    </>
  )
}

function RelayUpdateWarning({
  relayId,
  update,
  version,
}: {
  relayId: string
  update: { name: string; url: string }
  version: string
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Update available: ${update.name}`}
        className="grid size-5 shrink-0 place-items-center text-amber-400 transition-colors outline-none hover:text-amber-300 focus-visible:text-amber-300"
      >
        <TriangleAlert className="size-3.5" />
      </PopoverTrigger>
      <InfoDetailsContent title={`${update.name} is available`}>
        <p>
          This Relay runs {version}. Updating restarts the Relay; game servers,
          apps, and databases keep running.
        </p>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <RelayUpdateButton relayId={relayId} />
          <Button asChild size="sm" variant="ghost">
            <a href={update.url} target="_blank" rel="noreferrer">
              Release notes
              <ExternalLink />
            </a>
          </Button>
        </div>
      </InfoDetailsContent>
    </Popover>
  )
}

// The Updates dialog lives with the infrastructure pages.
function RelayUpdateButton({ relayId }: { relayId: string }) {
  const router = useRouter()
  const store = useInfraUpdateDialogStore()
  return (
    <Button
      type="button"
      size="sm"
      onClick={() => {
        void router.navigate({ to: "/infra/relays" }).then(() => {
          store.open(relayId)
        })
      }}
    >
      Update Relay
    </Button>
  )
}
