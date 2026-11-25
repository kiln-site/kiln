import * as React from "react"

import { TailscaleLogo } from "@/components/brand-logos"
import { InfoCopyValue } from "@/components/info-page"
import {
  useInstanceTunnelNames,
  type InstanceTunnelName,
} from "@/components/tunnel/tunnel-data"

// An instance's names in the tunnels it's connected to, as rows of its Info
// page's Connection section: Tailscale's mark, the name, and where it
// reaches.

export function TunnelNameFacts({
  address,
  isMember,
}: {
  /**
   * Where the instance answers under a name, to copy, when it isn't a
   * website to open.
   */
  address?: (hostname: string) => string
  /** Whether a tunnel member ID is this instance, or one of its services. */
  isMember: (memberId: string) => boolean
}) {
  const names = useInstanceTunnelNames(isMember)
  return names.map((name) => (
    <TunnelNameFact
      key={name.name.id}
      address={address?.(name.hostname)}
      name={name}
    />
  ))
}

/** Whether the instance has names in any tunnel, for an empty section. */
export function useHasTunnelNames(isMember: (memberId: string) => boolean) {
  return useInstanceTunnelNames(isMember).length > 0
}

const TunnelNameFact = React.memo(function TunnelNameFact({
  address,
  name,
}: {
  address: string | undefined
  name: InstanceTunnelName
}) {
  return (
    <div className="flex min-h-10 items-center gap-3 border-b border-border/60 py-1.5 text-[0.8125rem] last:border-b-0">
      <dt className="flex min-w-0 flex-1 items-center gap-2">
        <TailscaleLogo
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-label="On a tunnel"
          role="img"
        />
        {address === undefined ? (
          <a
            className="truncate font-medium transition-colors hover:text-primary-ink"
            href={`http://${name.hostname}`}
            rel="noreferrer"
            target="_blank"
            title={`${name.hostname}, on ${name.tunnelName}'s tailnet`}
          >
            {name.hostname}
          </a>
        ) : (
          <InfoCopyValue label="tunnel address" value={address} />
        )}
        <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline">
          {[
            name.name.primary ? "Primary" : null,
            name.tunnelName,
            name.name.generated ? null : "alias",
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </dt>
      <dd className="shrink-0 text-xs text-muted-foreground">
        {address === undefined
          ? "Every port, on the tailnet"
          : "On the tailnet"}
      </dd>
    </div>
  )
})
