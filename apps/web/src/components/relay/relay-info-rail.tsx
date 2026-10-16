import { useQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { BadgeCheck, ExternalLink, TriangleAlert } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Popover, PopoverTrigger } from "@workspace/ui/components/popover"

import {
  InfoDetailsContent,
  InfoFact,
  InfoRailGroup,
} from "@/components/info-page"
import { useInfraUpdateDialogStore } from "@/components/infra-update-dialog-provider"
import { InstanceFavoriteButton } from "@/components/instance-favorite"
import { LocalDateTime } from "@/components/local-date-time"
import {
  RelayNodeCard,
  useRelayNodeFacts,
} from "@/components/relay/relay-node-card"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { useRelayPermission } from "@/components/relay/relay-settings"
import { RelayWorkloads } from "@/components/relay/relay-workloads"
import { WorkspaceIdCopyButton } from "@/components/workspace-header"
import { relayUpdateQueryOptions } from "@/lib/query-options"
import type { RelayDirectoryEntry } from "@/lib/relay-route"

// What the Relay is at a glance: whether it's current, what runs on it, who
// owns it, and the node under it. Its name and status are in the header.
export function RelayInfoRail({
  relay,
  routeId,
}: {
  relay: RelayDirectoryEntry
  routeId: string
}) {
  const node = useRelayNodeFacts(relay.id)
  const version = node?.version ?? relay.nodeVersion
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        {/* Fixed height, so the update icon appearing doesn't move the rail. */}
        <p className="flex h-5 min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground">
          <span className="truncate">
            {version
              ? `Relay ${versionLabel(version)}`
              : "Relay version unknown"}
          </span>
          {version ? (
            <RelayUpdateWarning relay={relay} version={version} />
          ) : null}
        </p>
        <InstanceFavoriteButton id={relay.id} kind="relay" relayId={relay.id} />
      </div>
      <RelayWorkloads relayId={relay.id} routeId={routeId} />
      <InfoRailGroup title="Ownership">
        <dl>
          <InfoFact label="Owner">
            <RelayOwner relay={relay} />
          </InfoFact>
          <InfoFact label="Paired">
            <LocalDateTime dateOnly timestamp={relay.createdAt} />
          </InfoFact>
          <InfoFact label="ID">
            <WorkspaceIdCopyButton
              id={relay.id}
              label="Relay ID"
              shortId={routeId.slice(0, 8)}
            />
          </InfoFact>
        </dl>
      </InfoRailGroup>
      <RelayNodeCard facts={node} relay={relay} />
    </>
  )
}

// A Relay with no recorded owner, like one set up with Kiln itself, belongs
// to this Kiln.
function RelayOwner({ relay }: { relay: RelayDirectoryEntry }) {
  const owner = relay.ownerName ?? relay.ownerEmail
  if (owner) return <span className="truncate">{owner}</span>
  return (
    <span
      className="flex items-center gap-1"
      title="Belongs to this Kiln, not to one person"
    >
      Kiln
      <BadgeCheck aria-label="Verified" className="size-3.5 text-primary" />
    </span>
  )
}

function RelayUpdateWarning({
  relay,
  version,
}: {
  relay: RelayDirectoryEntry
  version: string
}) {
  const { connected } = useRelayLiveStatus(relay)
  const canUpdate = useRelayPermission(relay.id, "relay.update")
  const { data: release } = useQuery({
    ...relayUpdateQueryOptions(relay.id, version),
    enabled: canUpdate && connected,
  })
  if (!release) return null
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Update available: ${release.name}`}
        className="grid size-5 shrink-0 place-items-center text-amber-400 transition-colors outline-none hover:text-amber-300 focus-visible:text-amber-300"
      >
        <TriangleAlert className="size-3.5" />
      </PopoverTrigger>
      <InfoDetailsContent title={`${release.name} is available`}>
        <p>
          This Relay runs {versionLabel(version)}. Updating restarts the Relay;
          game servers, apps, and databases keep running.
        </p>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <RelayUpdateButton relayId={relay.id} />
          <Button asChild size="sm" variant="ghost">
            <a href={release.url} target="_blank" rel="noreferrer">
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

// Release versions read "v0.42.1"; development builds keep their name.
function versionLabel(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version
}
