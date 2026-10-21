import fabricIcon from "../../../bricks/icons/fabric.svg?url"
import foliaIcon from "../../../bricks/icons/folia.svg?url"
import palworldIcon from "../../../bricks/icons/palworld.svg?url"
import paperIcon from "../../../bricks/icons/paper.svg?url"
import velocityIcon from "../../../bricks/icons/velocity.svg?url"

// The official Bricks, drawn from the catalog's own marks the way Hearth
// draws them: as masks, so they take the text colour. Colours are the
// recipes' own.
export const officialBricks = [
  { name: "Paper", icon: paperIcon, color: "#e67e7e" },
  { name: "Fabric", icon: fabricIcon, color: "#8a7b71" },
  { name: "Folia", icon: foliaIcon, color: "#6aa54f" },
  { name: "Velocity", icon: velocityIcon, color: "#4b98b0" },
  { name: "Palworld", icon: palworldIcon, color: "#55b9d1" },
] as const

export function BrickMark({
  className = "size-4",
  icon,
}: {
  className?: string
  icon: string
}) {
  const mask = `url("${icon}")`
  return (
    <span
      aria-hidden="true"
      className={`${className} shrink-0 bg-current [mask-size:contain] [mask-position:center] [mask-repeat:no-repeat]`}
      style={{ WebkitMaskImage: mask, maskImage: mask }}
    />
  )
}
