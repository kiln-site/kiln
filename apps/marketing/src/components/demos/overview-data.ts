import type { IdentityStatusPresentation } from "@/components/identity-name"
import type {
  OverviewInstance,
  OverviewReadings,
  OverviewRelay,
  OverviewServices,
} from "@/components/overview-map-cards"

// A small fleet for Hearth's overview map: three machines, each a Relay,
// running a mix of game servers, apps, and databases. Two have a public
// address Hearth connects to; the home lab connects out to Hearth.

function relay(
  id: string,
  controlDial: OverviewRelay["controlDial"],
  address: string
): OverviewRelay {
  return {
    id,
    name: id,
    enabled: true,
    lastError: null,
    lastConnectedAt: null,
    controlDial,
    address,
  }
}

export const demoRelays: ReadonlyArray<OverviewRelay> = [
  relay("fsn1-dedicated", "hearth", "fsn1.kiln.site"),
  relay("garage-nuc", "hearth", "203.0.113.40:4100"),
  relay("home-lab", "relay", ""),
]

function instance(
  kind: OverviewInstance["kind"],
  relayId: string,
  name: string,
  meta: string
): OverviewInstance {
  return {
    key: `${kind}:${relayId}:${name}`,
    kind,
    id: name,
    relayId,
    name,
    meta,
    routeId: name,
  }
}

export const demoInstances: ReadonlyArray<OverviewInstance> = [
  instance("server", "fsn1-dedicated", "velocity-proxy", "mc.kiln.site"),
  instance("app", "fsn1-dedicated", "community-site", "a81f3e09"),
  instance("app", "fsn1-dedicated", "status-page", "6c02d7b4"),
  instance("database", "fsn1-dedicated", "postgres", "PostgreSQL · 0d9a33f1"),
  instance("server", "garage-nuc", "palworld", "pal.kiln.site:8211"),
  instance("app", "garage-nuc", "discord-bot", "f4471a6e"),
  instance("database", "garage-nuc", "redis", "Redis · 93ce12a7"),
  instance("server", "home-lab", "survival-smp", "survival.tail2c7e.ts.net"),
  instance("server", "home-lab", "creative", "creative.tail2c7e.ts.net"),
  instance("database", "home-lab", "luckperms-db", "MariaDB · 4be1c0d2"),
]

const online: IdentityStatusPresentation = { label: "Online", tone: "success" }

export const relayStatus: Record<string, IdentityStatusPresentation> = {
  "fsn1-dedicated": online,
  "garage-nuc": { label: "Updating", pulse: true, tone: "info" },
  "home-lab": online,
}

// What each Relay's machine reports, as Hearth's map shows it.
export const relayReadings: Record<string, OverviewReadings> = {
  "fsn1-dedicated": { cpu: 18, memory: 52, disk: 29 },
  "garage-nuc": { cpu: 61, memory: 93, disk: 64 },
  "home-lab": { cpu: 34, memory: 71, disk: 46 },
}

const running: IdentityStatusPresentation = {
  label: "Running",
  tone: "success",
}
const stopped: IdentityStatusPresentation = {
  label: "Stopped",
  tone: "neutral",
}

export function instanceStatus(
  instance: OverviewInstance
): IdentityStatusPresentation {
  return instance.name === "creative" ? stopped : running
}

const cloudflare: OverviewServices = { cloudflare: true, tailscale: false }
const tailscale: OverviewServices = { cloudflare: false, tailscale: true }

// fsn1's proxy has a Cloudflare domain; the home lab's game servers are on
// a tailnet.
export const relayServices: Record<string, OverviewServices> = {
  "fsn1-dedicated": cloudflare,
  "home-lab": tailscale,
}

export const instanceServices: Record<string, OverviewServices> = {
  "server:fsn1-dedicated:velocity-proxy": cloudflare,
  "server:home-lab:survival-smp": tailscale,
  "server:home-lab:creative": tailscale,
}
