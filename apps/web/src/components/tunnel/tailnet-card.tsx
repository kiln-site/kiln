import { TailscaleLogo } from "@/components/brand-logos"
import { PickerCard } from "@/components/instance-picker-field"
import type { TunnelOverview } from "@/components/tunnel/tailnet-data"

// A tailnet as a picker or a table shows it, in place of an instance's card:
// the Tailscale account its tunnels join, its TLDs, and how many tunnels it
// has.

export function tailnetMeta(
  tailnet: Pick<TunnelOverview, "gateways" | "domains">
): string {
  const count = tailnet.gateways.length
  return [
    tailnet.domains.map((domain) => `.${domain}`).join(" "),
    count === 1 ? "1 tunnel" : `${count} tunnels`,
  ]
    .filter(Boolean)
    .join(" · ")
}

export function TailnetCard({ meta, name }: { meta: string; name: string }) {
  return (
    <PickerCard
      icon={
        <TailscaleLogo className="size-3.5 text-foreground/80" aria-hidden />
      }
      meta={meta}
      name={name}
    />
  )
}
