import type { BrickV2Kind } from "@workspace/contracts"

import {
  AppKindIcon,
  DatabaseKindIcon,
  ServerKindIcon,
} from "@/components/instance-kind-icon"

// Hearth's icon and colour for each kind, so Bricks read the same here.
export function BrickKindIcon({
  className = "size-4",
  kind,
}: {
  className?: string
  kind: BrickV2Kind
}) {
  if (kind === "game-server") return <ServerKindIcon className={className} />
  if (kind === "database") return <DatabaseKindIcon className={className} />
  return <AppKindIcon className={className} />
}
