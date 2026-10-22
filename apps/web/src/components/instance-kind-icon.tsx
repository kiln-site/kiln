import type { ComponentType } from "react"
import { Boxes, Database, RadioTower, Server } from "lucide-react"
import type { LucideProps } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

export type InstanceKind = "app" | "database" | "relay" | "server"

// Every Relay, game server, app, and database icon takes its kind's colour
// from here. Fixed colours, so a custom accent can't change them or make two
// kinds match. Light mode takes darker shades so the icons keep their contrast,
// except Relays, which keep Kiln's default accent orange in both modes.
export const instanceKindTones = {
  relay: "text-orange-500",
  server: "text-emerald-700 dark:text-emerald-300",
  app: "text-red-600 dark:text-red-400",
  database: "text-blue-600 dark:text-blue-300",
} as const satisfies Record<InstanceKind, string>

// The kind's colour wins over any colour in `className`, so every use matches.
export function RelayKindIcon({ className, ...props }: LucideProps) {
  return (
    <RadioTower className={cn(className, instanceKindTones.relay)} {...props} />
  )
}

export function ServerKindIcon({ className, ...props }: LucideProps) {
  return (
    <Server className={cn(className, instanceKindTones.server)} {...props} />
  )
}

export function AppKindIcon({ className, ...props }: LucideProps) {
  return <Boxes className={cn(className, instanceKindTones.app)} {...props} />
}

export function DatabaseKindIcon({ className, ...props }: LucideProps) {
  return (
    <Database
      className={cn(className, instanceKindTones.database)}
      {...props}
    />
  )
}

export const instanceKindIcons = {
  relay: RelayKindIcon,
  server: ServerKindIcon,
  app: AppKindIcon,
  database: DatabaseKindIcon,
} as const satisfies Record<InstanceKind, ComponentType<LucideProps>>
