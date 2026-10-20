import fabricIcon from "../../../bricks/icons/fabric.svg?url"
import foliaIcon from "../../../bricks/icons/folia.svg?url"
import palworldIcon from "../../../bricks/icons/palworld.svg?url"
import paperIcon from "../../../bricks/icons/paper.svg?url"
import velocityIcon from "../../../bricks/icons/velocity.svg?url"

// The official Bricks, drawn from the catalog's own marks the way Hearth
// draws them: as masks, so they take the text colour.
export const officialBricks = [
  { name: "Paper", icon: paperIcon },
  { name: "Fabric", icon: fabricIcon },
  { name: "Folia", icon: foliaIcon },
  { name: "Velocity", icon: velocityIcon },
  { name: "Palworld", icon: palworldIcon },
] as const

export function BrickMark({ icon }: { icon: string }) {
  const mask = `url("${icon}")`
  return (
    <span
      aria-hidden="true"
      className="size-4 shrink-0 bg-current [mask-size:contain] [mask-position:center] [mask-repeat:no-repeat]"
      style={{ WebkitMaskImage: mask, maskImage: mask }}
    />
  )
}
