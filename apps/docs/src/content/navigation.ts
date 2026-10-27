import {
  AppWindow,
  Cable,
  Database,
  DatabaseBackup,
  Gamepad2,
  Globe,
  LifeBuoy,
  Rocket,
  ServerCog,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react"

export interface NavigationSection {
  // The folder under content/ its pages live in.
  id: string
  title: string
  // One line on the docs' home page.
  summary: string
  icon: LucideIcon
  // Page paths, in sidebar order.
  pages: Array<string>
}

// The sidebar, in order. A page's title and description come from its own
// frontmatter; list each page here when you add it.
export const navigation: Array<NavigationSection> = [
  {
    id: "get-started",
    title: "Get started",
    summary: "Install Kiln, add your machines, and see how it fits together.",
    icon: Rocket,
    pages: ["/"],
  },
  {
    id: "game-servers",
    title: "Game servers",
    summary:
      "Start game servers from Bricks, then manage their console, files, and schedules.",
    icon: Gamepad2,
    pages: [
      "/game-servers",
      "/game-servers/console-and-files",
      "/game-servers/schedules",
      "/game-servers/move",
      "/game-servers/bricks",
    ],
  },
  {
    id: "apps",
    title: "Apps",
    summary:
      "Deploy from GitHub, a Docker image, or a Compose file, with domains and HTTPS.",
    icon: AppWindow,
    pages: ["/apps", "/apps/domains", "/apps/settings"],
  },
  {
    id: "databases",
    title: "Databases",
    summary:
      "Run MySQL, MariaDB, PostgreSQL, Redis, and Valkey next to what uses them.",
    icon: Database,
    pages: ["/databases"],
  },
  {
    id: "relays",
    title: "Relays",
    summary:
      "Turn each machine into a Relay, connect it to Hearth, and manage its host.",
    icon: Cable,
    pages: ["/relays", "/relays/connections", "/relays/host"],
  },
  {
    id: "backups",
    title: "Backups",
    summary:
      "Back up to S3-compatible storage on a schedule, and restore in place.",
    icon: DatabaseBackup,
    pages: ["/backups", "/backups/restore"],
  },
  {
    id: "networking",
    title: "Networking",
    summary:
      "Point domains with Cloudflare, reach instances over Tailscale, and open ports.",
    icon: Globe,
    pages: ["/networking"],
  },
  {
    id: "access",
    title: "Access and security",
    summary:
      "Invite people, choose what they can do, and keep what you run patched.",
    icon: ShieldCheck,
    pages: ["/access", "/access/security"],
  },
  {
    id: "self-hosting",
    title: "Self-hosting",
    summary: "Configure, update, recover, and observe your own Kiln.",
    icon: ServerCog,
    pages: [
      "/self-hosting",
      "/self-hosting/updates",
      "/self-hosting/telemetry",
      "/self-hosting/forking",
    ],
  },
  {
    id: "cli",
    title: "Command line",
    summary:
      "Script Relays, game servers, files, and backups with the kiln CLI.",
    icon: SquareTerminal,
    pages: ["/cli", "/cli/commands"],
  },
  {
    id: "help",
    title: "Help",
    summary: "Fix common problems, and find answers and people to ask.",
    icon: LifeBuoy,
    pages: ["/help"],
  },
]
